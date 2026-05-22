import { open, stat } from "node:fs/promises";

// Tail a Paper server log, yielding lines as they're appended — and survive rotation.
//
// Paper renames latest.log to a dated archive and creates a fresh file on restart.
// fs.watch follows the old *inode*, so after rotation it goes deaf silently. We
// instead poll by *name*: each tick we stat the path and detect a new inode (the
// file was replaced) or a size shrink (truncated/rotated in place), and reopen from
// position 0. Polling (vs. fs events) keeps this a few lines and sidesteps fs.watch's
// rename quirks; the reducers batch anyway, so sub-second latency is irrelevant.
//
// We start at end-of-file (tail NEW activity, no history replay), and only ever
// advance `position` past a trailing newline — a partial last line is held until the
// rest arrives, so we never split a log record mid-line under burst writes.
//
// Caveat: a rotation that *reuses* the old inode number AND lands at a size >= our
// offset would be missed; in practice Paper's rotation yields a fresh inode.
export async function* tailLog(path: string, signal?: AbortSignal, pollMs = 500): AsyncGenerator<string> {
  const initial = await safeStat(path);
  let position = initial?.size ?? 0;
  let ino = initial?.ino ?? 0;

  while (!signal?.aborted) {
    await delay(pollMs, signal);
    if (signal?.aborted) return;

    const s = await safeStat(path);
    if (!s) continue; // file briefly absent mid-rotation; retry next tick

    // New inode → file was replaced (rotation). size < position → truncated. Either
    // way our old offset is meaningless; reopen from the start of the current file.
    if (s.ino !== ino || s.size < position) {
      ino = s.ino;
      position = 0;
    }
    if (s.size > position) {
      const chunk = await readChunk(path, position, s.size);
      const lastNl = chunk.lastIndexOf("\n");
      if (lastNl >= 0) {
        const complete = chunk.slice(0, lastNl); // up to, excluding, the last newline
        for (const line of complete.split("\n")) yield line.endsWith("\r") ? line.slice(0, -1) : line;
        // Advance only past the bytes we actually consumed (the partial tail stays).
        position += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
      }
      // else: no complete line yet — leave position, wait for the newline.
    }
  }
}

async function readChunk(path: string, start: number, end: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(end - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

async function safeStat(path: string): Promise<{ size: number; ino: number } | undefined> {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}
