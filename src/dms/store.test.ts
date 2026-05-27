import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DmStore } from "./store.js";

let dir: string;
let workingPath: string;
let recordPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dms-"));
  workingPath = join(dir, "data", "dms.jsonl");
  recordPath = join(dir, "exfil", "dms.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lines = async (p: string): Promise<unknown[]> =>
  (await readFile(p, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

describe("DmStore", () => {
  it("writes through to both the working store and the immutable record", async () => {
    const store = new DmStore(workingPath, recordPath, "run-1");
    await store.load();
    await store.append({ ts: 1000, dir: "in", player: "alice", message: "hi", seq: 1 });
    await store.append({ ts: 1001, dir: "out", player: "alice", message: "hey" });

    const working = await lines(workingPath);
    const record = await lines(recordPath);
    expect(working).toEqual(record);
    expect(working).toHaveLength(2);
    expect(working[0]).toMatchObject({ runId: "run-1", dir: "in", player: "alice", message: "hi", seq: 1 });
  });

  it("reads a thread oldest→newest and bounds by n", async () => {
    const store = new DmStore(workingPath, recordPath, "run-1");
    await store.load();
    for (let i = 1; i <= 5; i++) await store.append({ ts: i, dir: "in", player: "bob", message: `m${i}`, seq: i });

    expect(store.readThread("bob").map((e) => e.message)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(store.readThread("bob", 2).map((e) => e.message)).toEqual(["m4", "m5"]);
    expect(store.readThread("nobody")).toEqual([]);
  });

  it("derives neutral thread metadata, including count since the admin's last reply", async () => {
    const store = new DmStore(workingPath, recordPath, "run-1");
    await store.load();
    await store.append({ ts: 1, dir: "in", player: "alice", message: "a1", seq: 1 });
    await store.append({ ts: 2, dir: "out", player: "alice", message: "reply" });
    await store.append({ ts: 3, dir: "in", player: "alice", message: "a2", seq: 2 });
    await store.append({ ts: 4, dir: "in", player: "alice", message: "a3", seq: 3 });
    await store.append({ ts: 10, dir: "in", player: "bob", message: "b1", seq: 4 });

    const threads = store.listThreads();
    // most-recently-active first
    expect(threads.map((t) => t.player)).toEqual(["bob", "alice"]);
    const alice = threads.find((t) => t.player === "alice")!;
    expect(alice.messageCount).toBe(4);
    expect(alice.preview).toBe("a3");
    expect(alice.sinceLastReply).toBe(2); // a2, a3 — after the one "out"
    const bob = threads.find((t) => t.player === "bob")!;
    expect(bob.sinceLastReply).toBe(1); // never replied
  });

  it("rebuilds the index and resumes the inbound seq across a reload", async () => {
    const first = new DmStore(workingPath, recordPath, "run-1");
    await first.load();
    await first.append({ ts: 1, dir: "in", player: "alice", message: "a1", seq: 1 });
    await first.append({ ts: 2, dir: "in", player: "alice", message: "a2", seq: 2 });
    await first.append({ ts: 3, dir: "out", player: "alice", message: "reply" });

    // A fresh process (e.g. harness reboot) loading the same store.
    const second = new DmStore(workingPath, recordPath, "run-2");
    await second.load();
    expect(second.maxInboundSeq()).toBe(2); // the ingestor resumes the spool past line 2
    expect(second.readThread("alice").map((e) => e.message)).toEqual(["a1", "a2", "reply"]);
  });

  it("tolerates a torn trailing line on load", async () => {
    const store = new DmStore(workingPath, recordPath, "run-1");
    await store.load();
    await store.append({ ts: 1, dir: "in", player: "alice", message: "a1", seq: 1 });
    // Simulate a crash mid-append by leaving a partial JSON line.
    const { appendFile } = await import("node:fs/promises");
    await appendFile(workingPath, '{"ts":2,"dir":"in","player":"alice"');

    const reloaded = new DmStore(workingPath, recordPath, "run-2");
    await reloaded.load();
    expect(reloaded.readThread("alice").map((e) => e.message)).toEqual(["a1"]);
    expect(reloaded.maxInboundSeq()).toBe(1);
  });
});
