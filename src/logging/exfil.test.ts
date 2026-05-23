import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JsonlWriter } from "./exfil.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "exfil-"));
  path = join(dir, "log.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonlWriter", () => {
  it("creates the file and appends a newline-terminated JSON line", async () => {
    const w = new JsonlWriter(path);
    await w.append({ kind: "hi", n: 1 });
    const text = await readFile(path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text.trim());
    expect(parsed).toMatchObject({ kind: "hi", n: 1 });
    expect(typeof parsed.ts).toBe("number");
  });

  it("truncates a torn last line (no trailing newline) on the first append", async () => {
    // Simulate a crash mid-append: complete record then partial JSON with no \n.
    await writeFile(path, '{"kind":"good","seq":1}\n{"kind":"server_log","seq":');
    const w = new JsonlWriter(path);
    await w.append({ kind: "server_log", seq: 2 });

    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    // Two lines: the surviving good record + the fresh post-repair append. The torn
    // partial is gone — without the repair it would have concatenated with the new
    // line into one unparseable record, silently swallowing seq 2 on next replay.
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "good", seq: 1 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: "server_log", seq: 2 });
  });

  it("only repairs once per writer (subsequent appends don't re-stat or re-truncate)", async () => {
    await writeFile(path, '{"kind":"a"}\n{"torn":');
    const w = new JsonlWriter(path);
    await w.append({ n: 1 });
    await w.append({ n: 2 });
    await w.append({ n: 3 });

    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(4); // 1 surviving + 3 new
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "a" });
    expect(JSON.parse(lines[1]!)).toMatchObject({ n: 1 });
    expect(JSON.parse(lines[3]!)).toMatchObject({ n: 3 });
  });

  it("is a no-op when the file already ends with a newline (clean state)", async () => {
    await writeFile(path, '{"kind":"a"}\n{"kind":"b"}\n');
    const w = new JsonlWriter(path);
    await w.append({ kind: "c" });
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    expect(lines.map((l) => JSON.parse(l).kind)).toEqual(["a", "b", "c"]);
  });

  it("handles a single torn record (no newlines anywhere) by dropping it", async () => {
    await writeFile(path, '{"torn":');
    const w = new JsonlWriter(path);
    await w.append({ kind: "fresh" });
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: "fresh" });
  });
});
