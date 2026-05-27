import { readFile, stat } from "node:fs/promises";
import type { ExfilStreams } from "../logging/exfil.js";
import type { Inbox } from "../harness/inbox.js";
import { parseLine, type WorldEvent } from "./events.js";
import { tailLog } from "./log-tail.js";

// Subscriber callback: receives each new ground_truth event with its assigned seq.
export type LogEventSubscriber = (ev: WorldEvent, seq: number) => void;

// Owns the single server-log tail. Parses each line once, appends it to ground_truth
// with a monotonic seq id, then notifies subscribers. Reducers read seq + parsed event
// from ground_truth on boot to resume from a cursor, then subscribe here for live
// events — so a transient reducer failure no longer drops events permanently (the
// durable source-of-truth is ground_truth, and cursors only advance on success).
//
// Per-stream seq (server_log gets its own counter, independent of any other
// ground_truth event kinds). We scan ground_truth.jsonl on boot to find the current
// max; the file IS the resume record.
export class LogIngestor {
  private subs: LogEventSubscriber[] = [];
  private seq: number;

  private constructor(
    private serverLogPath: string,
    private exfil: ExfilStreams,
    startSeq: number,
    private initialPosition: number,
  ) {
    this.seq = startSeq;
  }

  static async load(
    serverLogPath: string,
    groundTruthPath: string,
    exfil: ExfilStreams,
  ): Promise<LogIngestor> {
    // Snapshot BOTH the seq and the server-log byte offset NOW. Reducer boot replay
    // happens between this call and start() — anything Paper appends during that
    // window must still be picked up. tailLog defaults to EOF *when iteration begins*,
    // which would skip exactly those lines; pinning startPosition here closes the gap.
    const [startSeq, initialPosition] = await Promise.all([
      readMaxServerLogSeq(groundTruthPath),
      readServerLogSize(serverLogPath),
    ]);
    return new LogIngestor(serverLogPath, exfil, startSeq, initialPosition);
  }

  // Current highest assigned seq. Snapshot at the moment of the call — used by the
  // boot order to know "ground_truth has events up through head()" before we start
  // tailing, so replay can complete before live events flow.
  head(): number {
    return this.seq;
  }

  subscribe(cb: LogEventSubscriber): () => void {
    this.subs.push(cb);
    return () => {
      this.subs = this.subs.filter((s) => s !== cb);
    };
  }

  // Begin tailing. Subscribers must be attached BEFORE calling — anything they miss
  // here lands only in ground_truth (and would require a restart-style replay to see).
  async start(signal: AbortSignal, inbox?: Inbox): Promise<void> {
    try {
      // initialPosition was captured at load() — any lines appended during reducer
      // boot replay are past that offset and will be read by the first tail tick.
      // Rotation between load() and now: tailLog detects size < position (truncation)
      // or a new inode and reopens from 0, so we don't get stuck.
      for await (const line of tailLog(this.serverLogPath, signal, undefined, this.initialPosition)) {
        const ev = parseLine(line);
        this.seq += 1;
        const assignedSeq = this.seq;
        // Tag ground_truth with the seq so reducers can resume from a known point.
        await this.exfil.groundTruth.append({ kind: "server_log", seq: assignedSeq, parsed: ev.kind, line });
        for (const s of this.subs) s(ev, assignedSeq);
      }
    } catch (err) {
      if (signal.aborted) return;
      // Surface ingestion failures: the admin needs to know reducers have gone deaf,
      // not "quiet". Same shape as the old ReducerManager.consume() error path.
      const message = err instanceof Error ? err.message : String(err);
      await this.exfil.modelExperience.append({
        kind: "ingestion_error",
        source: "server_log",
        path: this.serverLogPath,
        error: message,
      });
      await this.exfil.groundTruth.append({
        kind: "ingestion_error",
        source: "server_log",
        path: this.serverLogPath,
        error: message,
      });
      inbox?.push({
        role: "urgent_event",
        timestamp: Date.now(),
        kind: "log_ingestion_error",
        detail: `Server log ingestion stopped for ${this.serverLogPath}: ${message}`,
      });
    }
  }
}

// Server-log current size, or 0 if the file isn't there yet (fresh Paper install /
// pre-rotation moment). Used by load() to pin the tail's starting offset across the
// reducer boot-replay window.
async function readServerLogSize(serverLogPath: string): Promise<number> {
  try {
    return (await stat(serverLogPath)).size;
  } catch {
    return 0;
  }
}

// Scan an existing ground_truth.jsonl for the highest server_log seq. New runs (no
// file) return 0. Tolerant of a torn last line (crash mid-append) and of pre-seq
// entries from older runs (skipped if no `seq` field).
export async function readMaxServerLogSeq(groundTruthPath: string): Promise<number> {
  let raw: string;
  try {
    raw = await readFile(groundTruthPath, "utf8");
  } catch {
    return 0;
  }
  let max = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { kind?: string; seq?: number };
      if (entry.kind === "server_log" && typeof entry.seq === "number" && entry.seq > max) {
        max = entry.seq;
      }
    } catch {
      // torn last line; skip
    }
  }
  return max;
}

// Yield {seq, ev} from ground_truth.jsonl for every server_log entry with seq > after.
// Used by a reducer on boot to catch up from its persisted cursor before subscribing
// to live emits. Re-parses the stored raw line so the WorldEvent shape stays in one
// place (events.ts) — ground_truth holds only the raw line + parsed kind tag.
export async function* replayServerLog(
  groundTruthPath: string,
  afterSeq: number,
): AsyncGenerator<{ seq: number; ev: WorldEvent }> {
  let raw: string;
  try {
    raw = await readFile(groundTruthPath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: { kind?: string; seq?: number; line?: string };
    try {
      entry = JSON.parse(line) as { kind?: string; seq?: number; line?: string };
    } catch {
      continue;
    }
    if (entry.kind !== "server_log") continue;
    if (typeof entry.seq !== "number" || entry.seq <= afterSeq) continue;
    if (typeof entry.line !== "string") continue;
    yield { seq: entry.seq, ev: parseLine(entry.line) };
  }
}
