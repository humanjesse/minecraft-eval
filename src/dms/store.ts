import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { JsonlWriter } from "../logging/exfil.js";

// One private DM exchanged between a player and the admin.
//   dir "in"  — player → admin (ingested from the plugin spool)
//   dir "out" — admin → player (the admin's `tell` replies)
// `seq` (inbound only) is the source spool line index (1-based) — it lets a harness
// reboot reconcile the spool against this store without re-delivering DMs it already
// ingested. See ../dms/ingest.ts.
export interface DmEntry {
  ts: number;
  runId: string;
  dir: "in" | "out";
  player: string;
  uuid?: string;
  message: string;
  seq?: number;
}

// Neutral per-thread metadata, all DERIVED from the log — no read/unread flag machine,
// no harness verdict on importance (the admin decides what deserves attention). See
// notes/DESIGN.md → Player DMs.
export interface ThreadMeta {
  player: string;
  messageCount: number;
  lastTs: number;
  preview: string;
  // Inbound messages since the admin's last reply to this player. A neutral "they've
  // said N things you haven't answered" count, not a priority ranking.
  sinceLastReply: number;
}

// The canonical DM store. Append-only, write-through to two sinks:
//   - working: the local store this process queries (rebuilt into an in-memory index
//     on load). The model reaches it only through read_dms/list_dm_threads/tell.
//   - record:  the off-VM-bound immutable copy. If the model later nukes the working
//     store (bash, phase 3), it loses its own memory but the record survives.
// In phase 1 both are local; the split is structural so phase 3 only repoints `record`.
export class DmStore {
  private entries: DmEntry[] = [];
  private byPlayer = new Map<string, DmEntry[]>();
  private maxSeq = 0;
  private readonly working: JsonlWriter;
  private readonly record: JsonlWriter;

  constructor(
    private workingPath: string,
    recordPath: string,
    private runId: string,
  ) {
    this.working = new JsonlWriter(workingPath);
    this.record = new JsonlWriter(recordPath);
    this.recordPath = recordPath;
  }
  private recordPath: string;

  // Rebuild the in-memory index from the persistent working store. Tolerant of a
  // missing file (first run) and of an unparseable trailing line (a crash mid-append).
  async load(): Promise<void> {
    await Promise.all([
      mkdir(dirname(this.workingPath), { recursive: true }),
      mkdir(dirname(this.recordPath), { recursive: true }),
    ]);
    let raw: string;
    try {
      raw = await readFile(this.workingPath, "utf8");
    } catch {
      return; // no store yet
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let e: DmEntry;
      try {
        e = JSON.parse(line) as DmEntry;
      } catch {
        continue; // skip a torn line rather than fail the whole load
      }
      this.index(e);
    }
  }

  // Highest inbound spool seq already in the store — the resume point for the ingestor.
  maxInboundSeq(): number {
    return this.maxSeq;
  }

  // Append a DM, write-through to both sinks, then update the index. Durability comes
  // BEFORE we treat the message as real (indexing, advancing maxSeq, and — for inbound —
  // the caller's inbox delivery, which happens only after this resolves). If either
  // write throws, we propagate without indexing/delivering, so a failed persist never
  // leaves a phantom in-memory message or an undelivered-but-counted DM.
  //
  // Record (the off-VM immutable audit) FIRST, then working: on a crash between the two,
  // the working store is missing the entry, so a reboot's reconcile replays it from the
  // spool — at worst a dedupable duplicate in the record (seq + dir tag it), never a
  // permanent audit gap. Working-first would advance maxSeq past an entry the record
  // never got, losing it from the audit for good.
  async append(entry: Omit<DmEntry, "runId">): Promise<void> {
    const e: DmEntry = { ...entry, runId: this.runId };
    await this.record.append({ ...e });
    await this.working.append({ ...e });
    this.index(e);
  }

  // Last `n` messages of a player's thread, oldest → newest.
  readThread(player: string, n = 20): DmEntry[] {
    const thread = this.byPlayer.get(player) ?? [];
    return n >= thread.length ? [...thread] : thread.slice(thread.length - n);
  }

  // Neutral metadata for every thread, most-recently-active first.
  listThreads(): ThreadMeta[] {
    const metas: ThreadMeta[] = [];
    for (const [player, thread] of this.byPlayer) {
      const last = thread[thread.length - 1]!;
      let lastOutIdx = -1;
      for (let i = thread.length - 1; i >= 0; i--) {
        if (thread[i]!.dir === "out") { lastOutIdx = i; break; }
      }
      const sinceLastReply = thread.slice(lastOutIdx + 1).filter((m) => m.dir === "in").length;
      metas.push({
        player,
        messageCount: thread.length,
        lastTs: last.ts,
        preview: last.message,
        sinceLastReply,
      });
    }
    return metas.sort((a, b) => b.lastTs - a.lastTs);
  }

  private index(e: DmEntry): void {
    this.entries.push(e);
    const thread = this.byPlayer.get(e.player);
    if (thread) thread.push(e);
    else this.byPlayer.set(e.player, [e]);
    if (e.dir === "in" && typeof e.seq === "number" && e.seq > this.maxSeq) {
      this.maxSeq = e.seq;
    }
  }
}
