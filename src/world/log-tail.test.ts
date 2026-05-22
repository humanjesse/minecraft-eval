import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tailLog } from "./log-tail.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("tailLog", () => {
  it("starts at end-of-file and follows the log across rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tail-"));
    const path = join(dir, "latest.log");
    await writeFile(path, "preexisting\n"); // must NOT be replayed

    const ac = new AbortController();
    const lines: string[] = [];
    const consume = (async () => {
      for await (const line of tailLog(path, ac.signal, 10)) lines.push(line);
    })();

    await wait(40);
    await appendFile(path, "live1\n");
    await wait(40);

    // Rotate: archive the current file, create a fresh latest.log (new inode).
    await rename(path, join(dir, "latest-1.log"));
    await writeFile(path, "afterRotate\n");
    await wait(40);
    await appendFile(path, "live2\n");
    await wait(40);

    ac.abort();
    await consume;
    await rm(dir, { recursive: true, force: true });

    expect(lines).toEqual(["live1", "afterRotate", "live2"]);
  });

  it("does not split a record written without a trailing newline yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tail-"));
    const path = join(dir, "latest.log");
    await writeFile(path, "");

    const ac = new AbortController();
    const lines: string[] = [];
    const consume = (async () => {
      for await (const line of tailLog(path, ac.signal, 10)) lines.push(line);
    })();

    await appendFile(path, "par"); // partial: no newline
    await wait(40);
    expect(lines).toEqual([]); // not yielded as a complete line

    await appendFile(path, "tial\n"); // completes the record
    await wait(40);

    ac.abort();
    await consume;
    await rm(dir, { recursive: true, force: true });

    expect(lines).toEqual(["partial"]); // one whole line, not "par" + "tial"
  });
});
