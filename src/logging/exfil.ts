import { mkdir, appendFile, open, stat, truncate } from "node:fs/promises";
import { join } from "node:path";

// Append-only JSONL writer. Each line: { ts, ...entry }.
// One writer per stream. Crash-safe (every append is one fs.appendFile call).
//
// On the first append since construction, if the file exists and does NOT end with a
// newline (a torn last line — crash mid-append in a prior process), the file is
// truncated back to the last newline boundary. Without this, the next append would
// concatenate onto the torn line — yielding one unparseable record that silently
// swallows the new entry on every subsequent replay scan. Trade-off: we drop the
// already-unparseable partial line (it was lost anyway) rather than preserve it as
// a forensic trace, which would cost one good entry per crash forever.
export class JsonlWriter {
  private repaired = false;

  constructor(private path: string) {}

  async append(entry: Record<string, unknown>): Promise<void> {
    if (!this.repaired) {
      await this.repairTrailingBoundary();
      this.repaired = true;
    }
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    await appendFile(this.path, line);
  }

  private async repairTrailingBoundary(): Promise<void> {
    let size: number;
    try {
      size = (await stat(this.path)).size;
    } catch {
      return; // file doesn't exist yet — appendFile will create it cleanly
    }
    if (size === 0) return;
    const fh = await open(this.path, "r");
    let lastByte: number;
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      lastByte = buf[0]!;
    } finally {
      await fh.close();
    }
    if (lastByte === 0x0a) return; // already on a clean boundary
    // Find the last newline by reading backwards in 4KB chunks — avoids loading a
    // potentially huge log into memory just to find one byte.
    const lastNl = await findLastNewline(this.path, size);
    if (lastNl < 0) {
      // Whole file is one torn record — drop it.
      await truncate(this.path, 0);
    } else {
      await truncate(this.path, lastNl + 1); // keep the newline so the next append lands clean
    }
  }
}

async function findLastNewline(path: string, size: number): Promise<number> {
  const fh = await open(path, "r");
  try {
    const chunkSize = 4096;
    let end = size;
    const buf = Buffer.alloc(chunkSize);
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const length = end - start;
      await fh.read(buf, 0, length, start);
      for (let i = length - 1; i >= 0; i--) {
        if (buf[i] === 0x0a) return start + i;
      }
      end = start;
    }
    return -1;
  } finally {
    await fh.close();
  }
}

// Three log tiers per the design discussion:
//   - groundTruth:  what actually happened in the world (raw server log lines,
//                   RCON commands + replies, world snapshots, raw player DMs)
//   - modelExperience: what the model actually saw and did (every agent turn,
//                   heartbeat digests as delivered, tool calls + results,
//                   reducer-prompt snapshots+diffs)
//   - modelInternals: the model's own writings (notes, journal entries, files
//                   it creates in its working directory)
//
// Important: in phase 3 these paths point to *off-VM* storage. The model has bash
// and can `rm -rf` anything in-VM. The ground-truth/experience streams are the
// eval record — they MUST survive even if the model nukes its environment.
export interface ExfilStreams {
  groundTruth: JsonlWriter;
  modelExperience: JsonlWriter;
  modelInternals: JsonlWriter;
}

export async function openExfilStreams(exfilDir: string, runId: string): Promise<ExfilStreams> {
  const runDir = join(exfilDir, runId);
  await mkdir(runDir, { recursive: true });
  return {
    groundTruth: new JsonlWriter(join(runDir, "ground_truth.jsonl")),
    modelExperience: new JsonlWriter(join(runDir, "model_experience.jsonl")),
    modelInternals: new JsonlWriter(join(runDir, "model_internals.jsonl")),
  };
}
