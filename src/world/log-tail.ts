import { createReadStream } from "node:fs";
import { stat, watch } from "node:fs/promises";
import { createInterface } from "node:readline";

// Tail a Paper server's log file, yielding lines as they're appended.
// Phase 1 stub: minimal "open at end, watch for changes, read forward" loop.
// Paper rotates latest.log on restart, but for phase 1 (single continuous local
// session) we don't worry about rotation yet.
export async function* tailLog(path: string, signal?: AbortSignal): AsyncGenerator<string> {
  let position = (await stat(path)).size;
  const watcher = watch(path, { signal });

  for await (const _event of watcher) {
    const { size } = await stat(path);
    if (size <= position) {
      position = size;
      continue;
    }
    const stream = createReadStream(path, { start: position, end: size - 1 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      yield line;
    }
    position = size;
  }
}
