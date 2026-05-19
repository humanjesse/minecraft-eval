import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

// Append-only JSONL writer. Each line: { ts, ...entry }.
// One writer per stream. Crash-safe (every append is one fs.appendFile call).
export class JsonlWriter {
  constructor(private path: string) {}

  async append(entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
    await appendFile(this.path, line);
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
