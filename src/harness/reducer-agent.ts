import { complete, getModel, type Model } from "@earendil-works/pi-ai";
import type { Config } from "../config.js";
import type { ExfilStreams } from "../logging/exfil.js";
import { parseLine, renderForReducer, type WorldEvent } from "../world/events.js";
import { tailLog } from "../world/log-tail.js";
import type { Inbox } from "./inbox.js";
import "./message-types.js";

// Reducers are cheap sub-agents that watch a filtered slice of the raw server-log
// firehose and emit labeled HeartbeatMessages into the admin's inbox. There are
// several — one per concern (events, chat, …) — all running the same mechanism with
// different prompts and input filters. A reducer's prompt lives at
// state/agents/<name>-reducer.md and the admin can edit it; the diff against the
// frozen baseline is a primary eval signal, now legible per-concern.
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
  readPrompt: (promptName: string) => Promise<string>;
}

// One reducer instance: buffers its accepted events, flushes on count or timer,
// emits a labeled heartbeat (+ any urgent items). Does NOT tail — the manager owns
// the single log tail and routes events here via ingest().
class Reducer {
  private buffer: WorldEvent[] = [];
  private windowStart = Date.now();
  private activeFlush?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private signal?: AbortSignal;
  private readonly model: Model<never>;

  constructor(private spec: ReducerSpec, private deps: ReducerDeps) {
    this.model = getModel(deps.config.reducerModel.provider as never, deps.config.reducerModel.model as never);
  }

  start(signal: AbortSignal): void {
    this.signal = signal;
    this.timer = setInterval(() => void this.requestFlush(), this.spec.intervalMs);
  }

  ingest(ev: WorldEvent): void {
    if (!this.spec.accepts(ev)) return;
    this.buffer.push(ev);
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
    this.activeFlush = this.flushBatch().finally(() => {
      this.activeFlush = undefined;
    });
    return this.activeFlush;
  }

  private async flushBatch(): Promise<void> {
    const batch = this.buffer;
    this.buffer = [];
    const windowStart = this.windowStart;
    const windowEnd = Date.now();
    this.windowStart = windowEnd;
    try {
      const prompt = await this.deps.readPrompt(this.spec.promptName);
      const lines = batch.map(renderForReducer);
      const digest = await reduceBatch(this.model, prompt, lines, `${this.deps.config.runId}-${this.spec.name}`, {
        signal: this.signal,
      });

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
      // Reducer model call failed/aborted. Log it loudly rather than silently
      // dropping into a bogus "quiet" digest. The batch's raw lines are already in
      // ground_truth; the admin gets a degraded heartbeat instead of a false summary.
      // (Proper retry/resume belongs with the durable-spool work — see notes/STATUS.)
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
        digest: `[reducer degraded] Couldn't summarize this ${this.spec.name} window (${batch.length} events) — a transient failure on my side, not a quiet period. The underlying activity still happened; treat this window as unobserved by the ${this.spec.name} reducer.`,
      });
    }
  }
}

// Owns the single log tail; parses each line once, logs raw+typed to ground_truth
// once, and routes the event to every reducer that accepts it.
export class ReducerManager {
  private readonly reducers: Reducer[];

  constructor(specs: ReducerSpec[], private deps: ReducerDeps) {
    this.reducers = specs.map((s) => new Reducer(s, deps));
  }

  start(signal: AbortSignal): void {
    for (const r of this.reducers) r.start(signal);
    void this.consume(signal);
  }

  async stop(): Promise<void> {
    await Promise.all(this.reducers.map((r) => r.stop()));
  }

  private async consume(signal: AbortSignal): Promise<void> {
    try {
      for await (const line of tailLog(this.deps.config.serverLogPath, signal)) {
        const ev = parseLine(line);
        await this.deps.exfil.groundTruth.append({ kind: "server_log", parsed: ev.kind, line });
        for (const r of this.reducers) r.ingest(ev);
      }
    } catch (err) {
      if (signal.aborted) return;
      const message = err instanceof Error ? err.message : String(err);
      await this.deps.exfil.modelExperience.append({
        kind: "ingestion_error",
        source: "server_log",
        path: this.deps.config.serverLogPath,
        error: message,
      });
      await this.deps.exfil.groundTruth.append({
        kind: "ingestion_error",
        source: "server_log",
        path: this.deps.config.serverLogPath,
        error: message,
      });
      this.deps.inbox.push({
        role: "urgent_event",
        timestamp: Date.now(),
        kind: "log_ingestion_error",
        detail: `Server log ingestion stopped for ${this.deps.config.serverLogPath}: ${message}`,
      });
    }
  }
}

// The default reducer roster. Sensible starting defaults the admin can later retune.
export function defaultReducerSpecs(config: Config): ReducerSpec[] {
  return [
    {
      name: "events",
      promptName: "events-reducer",
      accepts: (ev) => ev.kind !== "chat",
      batchLines: config.reducerBatchLines,
      intervalMs: config.reducerIntervalMs,
    },
    {
      name: "chat",
      promptName: "chat-reducer",
      accepts: (ev) => ev.kind === "chat",
      batchLines: config.reducerBatchLines,
      intervalMs: config.reducerIntervalMs,
    },
  ];
}

// Render a digest into readable text (used by tests + any direct display).
export function formatDigest(d: ReducerDigest): string {
  if (d.quiet && !d.digest) return "Quiet — nothing notable.";
  return d.digest || "Quiet — nothing notable.";
}
