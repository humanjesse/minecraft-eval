import { readFile } from "node:fs/promises";
import type { Config } from "../config.js";
import type { ExfilStreams } from "../logging/exfil.js";
import { tailLog } from "../world/log-tail.js";
import type { Inbox } from "../harness/inbox.js";
import type { DmStore } from "./store.js";
import "../harness/message-types.js";

// One line the Paper /dm plugin appends to the inbound spool.
interface SpoolLine {
  ts: number;
  player: string;
  uuid?: string;
  message: string;
}

export interface DmIngestorDeps {
  config: Config;
  inbox: Inbox;
  dmStore: DmStore;
  exfil: ExfilStreams;
}

// Watches the plugin's inbound spool and turns each `/dm` into (1) a canonical store
// append (write-through to both sinks) and (2) an inbox notification carrying the full
// message — one guaranteed look per DM at arrival (see notes/DESIGN.md → Player DMs).
//
// DMs BYPASS the reducers: a player choosing a private line is addressed-by-nature, so
// it gets full fidelity, not salience filtering.
//
// Restart-safe by reconciliation: the spool is durable, so DMs that land while the
// harness is down aren't lost. On boot we read the spool up to a snapshot offset, replay
// any lines past what the store already has (by seq), then tail live from exactly that
// offset — gap-free and dup-free, without a separate offset sidecar (the store itself is
// the record of what's been ingested).
export async function startDmIngestor(deps: DmIngestorDeps, signal: AbortSignal): Promise<void> {
  const { config, dmStore } = deps;
  const path = config.dmInboundPath;

  // Boot replay AND live tailing share one error-reporting path: a failure in either
  // (e.g. a durable DM write that can't complete) surfaces as a logged ingestion_error
  // + an urgent inbox interrupt, never an unhandled rejection. The caller starts this
  // with `void`, so an unreported throw here would otherwise vanish silently.
  try {
    // Snapshot the spool's complete lines and the exact byte offset they end at.
    let raw = "";
    try {
      raw = await readFile(path, "utf8");
    } catch {
      raw = ""; // plugin hasn't created the spool yet
    }
    const lastNl = raw.lastIndexOf("\n");
    const complete = lastNl >= 0 ? raw.slice(0, lastNl + 1) : "";
    const spoolLines = complete.split("\n").filter((l) => l.trim());
    const consumedBytes = Buffer.byteLength(complete, "utf8");

    // Replay only lines past what the store already ingested (seq is 1-based line index).
    const already = dmStore.maxInboundSeq();
    for (let i = already; i < spoolLines.length; i++) {
      await ingestLine(deps, spoolLines[i]!, i + 1);
    }

    // Live tail from the snapshot offset; continue seq numbering from the lines we saw.
    let seq = spoolLines.length;
    for await (const line of tailLog(path, signal, 500, consumedBytes)) {
      if (!line.trim()) continue;
      seq++;
      await ingestLine(deps, line, seq);
    }
  } catch (err) {
    if (signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    await deps.exfil.modelExperience.append({ kind: "ingestion_error", source: "dm_spool", path, error: message });
    await deps.exfil.groundTruth.append({ kind: "ingestion_error", source: "dm_spool", path, error: message });
    deps.inbox.push({
      role: "urgent_event",
      timestamp: Date.now(),
      kind: "dm_ingestion_error",
      detail: `DM ingestion stopped for ${path}: ${message}`,
    });
  }
}

async function ingestLine(deps: DmIngestorDeps, line: string, seq: number): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (err) {
    return logParseError(deps, seq, line, err instanceof Error ? err.message : String(err));
  }
  // Validate the shape — JSON.parse happily yields {}, [], null, or wrong field types,
  // and the spool is a plain file (in phase 3 the model with bash can write to it). A
  // bad shape must not create a thread for an undefined player or push a malformed
  // player_dm to the model; treat it like malformed JSON.
  const parsed = asSpoolLine(raw);
  if (!parsed) {
    return logParseError(deps, seq, line, "invalid spool line shape (need string player + message)");
  }
  const ts = typeof parsed.ts === "number" ? parsed.ts : Date.now();
  await deps.dmStore.append({ ts, dir: "in", player: parsed.player, uuid: parsed.uuid, message: parsed.message, seq });
  deps.inbox.push({ role: "player_dm", timestamp: ts, player: parsed.player, text: parsed.message });
}

function asSpoolLine(raw: unknown): SpoolLine | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.player !== "string" || o.player.length === 0) return undefined;
  if (typeof o.message !== "string") return undefined;
  if (o.uuid !== undefined && typeof o.uuid !== "string") return undefined;
  if (o.ts !== undefined && typeof o.ts !== "number") return undefined;
  return { ts: o.ts as number | undefined ?? Date.now(), player: o.player, uuid: o.uuid as string | undefined, message: o.message };
}

// A malformed spool line: log to ground_truth, don't crash the channel. The raw line is
// still on disk in the spool for forensics.
async function logParseError(deps: DmIngestorDeps, seq: number, line: string, error: string): Promise<void> {
  await deps.exfil.groundTruth.append({ kind: "dm_parse_error", source: "dm_spool", seq, raw: line, error });
}
