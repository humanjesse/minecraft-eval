import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// Per-reducer resume cursor: the highest ground_truth seq this reducer has
// successfully flushed. Persisted so a harness restart can pick up where it left off
// instead of re-tailing from EOF (in which case events from before the restart that
// hadn't yet been flushed would be lost to the reducer's perception). Lives outside
// the exfil dir on purpose — exfil is append-only audit, cursors are mutable harness
// state. Per-run dir (passed at construction) so different runs never collide.
//
// Atomic write: write-temp + rename. Avoids a torn cursor file from a crash mid-write,
// which would either lose a seq advance (replay re-processes those events — fine, the
// model just sees them again) or worse, jump past unprocessed ones.
export class ReducerCursorStore {
  constructor(private dir: string) {}

  async read(name: string): Promise<number> {
    try {
      const raw = await readFile(this.pathFor(name), "utf8");
      const data = JSON.parse(raw) as { lastSeq?: number };
      return typeof data.lastSeq === "number" ? data.lastSeq : 0;
    } catch {
      return 0; // missing or unreadable → fresh start
    }
  }

  async write(name: string, lastSeq: number): Promise<void> {
    const path = this.pathFor(name);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify({ lastSeq }));
    await rename(tmp, path);
  }

  private pathFor(name: string): string {
    return join(this.dir, `${name}.json`);
  }
}
