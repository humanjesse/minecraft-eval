import { complete, getModel, type Model } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { ExfilStreams } from "../logging/exfil.js";
import { type LogEventSubscriber, replayServerLog } from "../world/log-ingestor.js";
import type { WorldEvent } from "../world/events.js";
import type { Inbox } from "./inbox.js";
import { ReducerCursorStore } from "./reducer-cursor.js";
import "./message-types.js";

// The bit of LogIngestor a reducer actually needs — structural so tests can pass a
// stub without constructing a tail-owning LogIngestor.
export interface EventStream {
  subscribe(cb: LogEventSubscriber): () => void;
}

// Reducers are cheap sub-agents that watch a filtered slice of the raw server-log
// firehose and emit labeled HeartbeatMessages into the admin's inbox. There are
// several — one per concern (events, chat, …) — all running the same mechanism with
// different prompts and input filters. A reducer's prompt lives at
// state/agents/<name>-reducer.md and the admin can edit it; the diff against the
// frozen baseline is a primary eval signal, now legible per-concern.
//
// Durable source: each reducer reads its input from ground_truth.jsonl (seq-tagged by
// LogIngestor) and tracks a `lastSeq` cursor that advances ONLY on a successful flush.
// A transient model failure therefore retries the same events on the next tick instead
// of dropping them. On boot, a reducer replays ground_truth past its cursor before
// subscribing to live events — so a crash + restart catches up the reducer to events
// that were durably recorded but not yet processed.
//
// Neutrality (see notes/DESIGN.md): a reducer reports *salience*, never *judgment*.
// It surfaces what's worth looking at without ruling on what it means. No behavioral
// labels ("grief", "harassment"); `urgent` is for value-neutral infrastructural
// distress only. The admin assigns all meaning.

export interface ReducerDigest {
  digest: string;
  urgent: Array<{ kind: string; detail: string }>;
  quiet: boolean;
}

// Pi encodes provider/runtime failures (and aborts) in the returned AssistantMessage
// as stopReason "error"/"aborted" — it does NOT throw. reduceBatch surfaces those as
// a thrown ReducerError so the caller can log + decide, instead of silently parsing
// an empty body into a bogus "quiet" digest.
export class ReducerError extends Error {
  constructor(public stopReason: string, message: string) {
    super(message);
    this.name = "ReducerError";
  }
}

// Pure-ish core: prompt + lines -> structured digest. Isolated from tailing/timing
// so it can be tested directly with sample input. temperature:0 for reproducible
// digests; maxTokens caps cost (digests are short).
export async function reduceBatch(
  model: Model<never>,
  prompt: string,
  lines: string[],
  sessionId: string,
  opts: { signal?: AbortSignal; maxTokens?: number } = {},
): Promise<ReducerDigest> {
  const result = await complete(
    model,
    {
      systemPrompt: prompt,
      messages: [{ role: "user", content: [{ type: "text", text: lines.join("\n") }], timestamp: Date.now() }],
    },
    { sessionId, signal: opts.signal, temperature: 0, maxTokens: opts.maxTokens ?? 1024 },
  );
  if (result.stopReason === "error" || result.stopReason === "aborted") {
    throw new ReducerError(result.stopReason, result.errorMessage ?? "reducer model call failed");
  }
  const text = result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseReducerOutput(text);
}

// Tolerant JSON extraction — models sometimes wrap JSON in prose or code fences.
export function parseReducerOutput(text: string): ReducerDigest {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new ReducerError("parse_error", `reducer returned no JSON object: ${excerpt(text)}`);
  }
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Partial<ReducerDigest>;
    const urgent = Array.isArray(raw.urgent)
      ? raw.urgent
          .filter((u): u is { kind: string; detail: string } => !!u && typeof u.kind === "string" && typeof u.detail === "string")
          .map((u) => ({ kind: u.kind, detail: u.detail }))
      : [];
    const digest = typeof raw.digest === "string" ? raw.digest : "";
    return { digest, urgent, quiet: raw.quiet ?? (urgent.length === 0 && !digest) };
  } catch (err) {
    throw new ReducerError("parse_error", `reducer returned malformed JSON: ${err instanceof Error ? err.message : String(err)}; output=${excerpt(text)}`);
  }
}

function excerpt(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat || "(empty)";
}

export interface ReducerSpec {
  name: string; // "events", "chat" — also the inbox heartbeat source label
  promptName: string; // file in state/agents/, e.g. "events-reducer"
  accepts: (ev: WorldEvent) => boolean;
  batchLines: number;
  intervalMs: number;
}

export interface ReducerDeps {
  config: Config;
  inbox: Inbox;
  exfil: ExfilStreams;
  cursorStore: ReducerCursorStore;
  groundTruthPath: string;
  readPrompt: (promptName: string) => Promise<string>;
}

// Buffered event tagged with its ground_truth seq. The seq is what advances the
// cursor on a successful flush — so a crash mid-flush leaves the cursor where it was
// and the events are replayed from ground_truth on next boot.
interface BufferedEvent {
  ev: WorldEvent;
  seq: number;
}

// One reducer instance. Subscribes to LogIngestor for live events, replays past its
// cursor from ground_truth on boot, batches accepted events, flushes on count or
// timer. On flush failure the batch is RETAINED so the next flush retries — the
// cursor only advances on success, so ground_truth remains the source of truth.
class Reducer {
  private buffer: BufferedEvent[] = [];
  private windowStart = Date.now();
  private activeFlush?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private signal?: AbortSignal;
  private readonly model: Model<never>;
  private cursor = 0;
  // After a failed flush, we suppress count-triggered retries until intervalMs has
  // passed and the timer fires — otherwise every new ingest past `batchLines` would
  // hammer the provider in a tight retry loop.
  private failedAt?: number;

  constructor(private spec: ReducerSpec, private deps: ReducerDeps) {
    this.model = getModel(deps.config.reducerModel.provider as never, deps.config.reducerModel.model as never);
  }

  // Replay → subscribe → start timer. Caller orders these so subscribe happens BEFORE
  // LogIngestor.start() emits — so no live event is missed between replay and live.
  async startWith(ingestor: EventStream, signal: AbortSignal): Promise<void> {
    this.signal = signal;
    this.cursor = await this.deps.cursorStore.read(this.spec.name);

    // Catch up on anything durably recorded but not yet processed (crash recovery + a
    // fresh boot finding events the previous run wrote past the cursor). Bounded by
    // ingestor.head() at boot time — we don't tail; we read what's already on disk.
    for await (const { ev, seq } of replayServerLog(this.deps.groundTruthPath, this.cursor)) {
      this.ingest(ev, seq);
    }

    ingestor.subscribe((ev, seq) => this.ingest(ev, seq));
    this.timer = setInterval(() => void this.requestFlush(), this.spec.intervalMs);
  }

  ingest(ev: WorldEvent, seq: number): void {
    if (!this.spec.accepts(ev)) return;
    this.buffer.push({ ev, seq });
    if (this.buffer.length >= this.spec.batchLines) void this.requestFlush();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.activeFlush;
    await this.requestFlush();
  }

  private requestFlush(): Promise<void> {
    if (this.activeFlush) return this.activeFlush;
    if (this.buffer.length === 0) return Promise.resolve();
    // Backoff after a failure: only the timer drives retries until intervalMs elapses.
    // The count-trigger would otherwise re-fire on every new event past batchLines.
    if (this.failedAt !== undefined && Date.now() - this.failedAt < this.spec.intervalMs) {
      return Promise.resolve();
    }
    this.activeFlush = this.flushBatch().finally(() => {
      this.activeFlush = undefined;
    });
    return this.activeFlush;
  }

  private async flushBatch(): Promise<void> {
    if (this.buffer.length === 0) return;
    // Snapshot what we're processing. We do NOT clear the buffer up front — on a
    // failure we leave it intact and the next tick retries (the cursor stays put, so
    // ground_truth remains the source of truth and nothing is dropped).
    const batch = this.buffer.slice();
    const windowStart = this.windowStart;
    const windowEnd = Date.now();
    try {
      const prompt = await this.deps.readPrompt(this.spec.promptName);
      // Feed the reducer the raw, unaltered log lines (timestamps and all). The
      // reducer reads the real firehose and synthesizes; the harness does not
      // pre-digest it. parseLine was used only to ROUTE lines to the right reducer
      // (chat vs the rest) and to tag ground_truth — never to reshape the input.
      const lines = batch.map((b) => b.ev.raw);
      const digest = await reduceBatch(this.model, prompt, lines, `${this.deps.config.runId}-${this.spec.name}`, {
        signal: this.signal,
      });

      // Success: advance the cursor + drop the processed prefix + reset window.
      const maxSeq = batch[batch.length - 1]!.seq;
      await this.deps.cursorStore.write(this.spec.name, maxSeq);
      this.buffer.splice(0, batch.length);
      this.windowStart = windowEnd;
      this.failedAt = undefined;

      if (!digest.quiet || digest.urgent.length > 0) {
        this.deps.inbox.push({
          role: "heartbeat",
          timestamp: windowEnd,
          source: this.spec.name,
          windowStart,
          windowEnd,
          rawLineCount: batch.length,
          digest: digest.digest || "(quiet)",
        });
      }
      for (const u of digest.urgent) {
        this.deps.inbox.push({ role: "urgent_event", timestamp: windowEnd, kind: u.kind, detail: u.detail });
      }
      await this.deps.exfil.modelExperience.append({
        kind: "heartbeat_produced",
        source: this.spec.name,
        windowStart,
        windowEnd,
        rawLineCount: batch.length,
        digest,
      });
    } catch (err) {
      // Intentional shutdown — the harness aborted the signal and we're tearing down.
      // The "failure" is us cancelling an in-flight or final-drain flush; nothing went
      // wrong. Don't emit a spurious reducer_error or push a degraded heartbeat into
      // an inbox no one is reading. Raw lines for this window are durable in
      // ground_truth (logged by LogIngestor before routing), so nothing is lost.
      if (this.signal?.aborted) return;
      // Real failure: log loudly + emit a degraded heartbeat (one per failure, not per
      // event) so the admin sees something this window. The batch + cursor are
      // unchanged, so the next tick retries from where we are.
      this.failedAt = Date.now();
      await this.deps.exfil.modelExperience.append({
        kind: "reducer_error",
        source: this.spec.name,
        windowStart,
        windowEnd,
        rawLineCount: batch.length,
        error: err instanceof Error ? err.message : String(err),
        stopReason: err instanceof ReducerError ? err.stopReason : undefined,
      });
      this.deps.inbox.push({
        role: "heartbeat",
        timestamp: windowEnd,
        source: this.spec.name,
        windowStart,
        windowEnd,
        rawLineCount: batch.length,
        digest: `[reducer degraded] Couldn't summarize this ${this.spec.name} window (${batch.length} events) — a transient failure on my side, not a quiet period. The underlying activity still happened; the reducer will retry on the next tick.`,
      });
    }
  }
}

// Owns the reducer collection's lifecycle. The single log tail and ground_truth
// writes now live in LogIngestor (passed in at startWith).
export class ReducerManager {
  private readonly reducers: Reducer[];

  constructor(specs: ReducerSpec[], private deps: ReducerDeps) {
    this.reducers = specs.map((s) => new Reducer(s, deps));
  }

  async startWith(ingestor: EventStream, signal: AbortSignal): Promise<void> {
    // Sequenced per reducer (each does replay → subscribe → start timer) so the
    // subscribe is in place before LogIngestor.start() begins emitting live.
    for (const r of this.reducers) await r.startWith(ingestor, signal);
  }

  async stop(): Promise<void> {
    await Promise.all(this.reducers.map((r) => r.stop()));
  }
}

// The default reducer roster. Sensible starting defaults the admin can later retune.
// Chat is NOT reduced — it's relayed full-fidelity into the inbox by a subscriber wired
// in main-agent.ts (see `chat-relay`). These accepts() filters partition what remains.
export function defaultReducerSpecs(config: Config): ReducerSpec[] {
  return [
    {
      name: "events",
      promptName: "events-reducer",
      accepts: (ev) => ev.kind !== "chat" && ev.kind !== "block_change",
      batchLines: config.reducerBatchLines,
      intervalMs: config.reducerIntervalMs,
    },
    {
      name: "world",
      promptName: "world-reducer",
      accepts: (ev) => ev.kind === "block_change",
      batchLines: config.worldReducerBatchLines,
      intervalMs: config.worldReducerIntervalMs,
    },
  ];
}

// Render a digest into readable text (used by tests + any direct display).
export function formatDigest(d: ReducerDigest): string {
  if (d.quiet && !d.digest) return "Quiet — nothing notable.";
  return d.digest || "Quiet — nothing notable.";
}
