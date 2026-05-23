import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module mock for the model call — has to be hoisted above the imports of code that
// touches it. The mock returns a fresh AssistantMessage-shaped object per call, with
// content drawn from a per-test stack so we can script success vs. error per flush.
const mockComplete = vi.fn();
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, complete: (...args: unknown[]) => mockComplete(...args) };
});

import type { Config } from "../config.js";
import { openExfilStreams } from "../logging/exfil.js";
import type { LogEventSubscriber } from "../world/log-ingestor.js";
import { parseLine } from "../world/events.js";
import { Inbox } from "./inbox.js";
import { ReducerCursorStore } from "./reducer-cursor.js";
import { ReducerManager, type ReducerSpec } from "./reducer-agent.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Tiny in-memory EventStream the reducer can subscribe to without needing the real
// LogIngestor + tail. `emit(line)` simulates a fresh server-log line landing. Seq
// starts where the real LogIngestor would — past whatever's already in ground_truth —
// so the reducer's "max seq = batch.last.seq" assumption (which relies on monotonic
// arrival order across replay + live) holds.
function makeStream(startSeq: number = 0) {
  const subs: LogEventSubscriber[] = [];
  let seq = startSeq;
  return {
    subscribe(cb: LogEventSubscriber) {
      subs.push(cb);
      return () => {};
    },
    emit(line: string): number {
      seq += 1;
      const ev = parseLine(line);
      for (const s of subs) s(ev, seq);
      return seq;
    },
    head: () => seq,
  };
}

// Build a ReducerDigest-shaped AssistantMessage Pi would return.
const okMessage = (digest: string) => ({
  role: "assistant",
  content: [{ type: "text", text: JSON.stringify({ digest, urgent: [], quiet: false }) }],
  stopReason: "end_turn",
});
const errMessage = () => ({
  role: "assistant",
  content: [],
  stopReason: "error",
  errorMessage: "transient provider failure",
});

let dir: string;
let groundTruthPath: string;
let cursorDir: string;
let promptsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "reducer-resume-"));
  groundTruthPath = join(dir, "exfil", "run-1", "ground_truth.jsonl");
  cursorDir = join(dir, "cursors");
  promptsDir = join(dir, "prompts");
  await mkdir(promptsDir, { recursive: true });
  await writeFile(join(promptsDir, "events-reducer.md"), "summarize events");
  mockComplete.mockReset();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setup(spec: Partial<ReducerSpec> = {}) {
  const config = {
    runId: "run-1",
    reducerModel: { provider: "anthropic", model: "claude-haiku-4-5" },
  } as unknown as Config;
  const inbox = new Inbox();
  const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
  const cursorStore = new ReducerCursorStore(cursorDir);

  const full: ReducerSpec = {
    name: "events",
    promptName: "events-reducer",
    accepts: (ev) => ev.kind !== "chat",
    batchLines: 3,
    intervalMs: 5_000,
    ...spec,
  };
  const manager = new ReducerManager([full], {
    config,
    inbox,
    exfil,
    cursorStore,
    groundTruthPath,
    readPrompt: async () => "summarize events",
  });
  return { manager, inbox, cursorStore };
}

// Seed a ground_truth.jsonl with server_log entries at the given seqs.
async function seedGroundTruth(entries: Array<{ seq: number; line: string }>): Promise<void> {
  await mkdir(join(dir, "exfil", "run-1"), { recursive: true });
  const body = entries
    .map((e) => JSON.stringify({ kind: "server_log", seq: e.seq, parsed: parseLine(e.line).kind, line: e.line }))
    .join("\n") + "\n";
  await writeFile(groundTruthPath, body);
}

const line = (text: string) => `[15:40:00] [Server thread/INFO]: ${text}`;

describe("reducer boot replay", () => {
  it("replays ground_truth events past the persisted cursor + advances the cursor on success", async () => {
    await seedGroundTruth([
      { seq: 1, line: line("alice joined the game") },
      { seq: 2, line: line("bob joined the game") },
      { seq: 3, line: line("alice left the game") },
    ]);
    const { manager, inbox, cursorStore } = await setup({ batchLines: 3 });

    // Cursor already at 1 — a previous run flushed up through seq 1.
    await cursorStore.write("events", 1);

    mockComplete.mockResolvedValue(okMessage("Two players moved through."));

    // Stream continues seq past ground_truth's max (3) — mirrors what the real
    // LogIngestor does after a crash recovery.
    const stream = makeStream(3);
    const ac = new AbortController();
    await manager.startWith(stream, ac.signal);
    // Replay puts 2 events (seq 2, 3) in the buffer; batchLines=3 doesn't trigger
    // count-flush yet — emit one live event (seq 4) to cross the threshold.
    stream.emit(line("eve joined the game"));
    await wait(20);
    await manager.stop(); // forces a final flush

    expect(mockComplete).toHaveBeenCalledTimes(1);
    // Only seqs > cursor were processed (so 2 ground-truth events + 1 live).
    const [, request] = mockComplete.mock.calls[0]!;
    const sent = (request as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]!.content[0]!.text;
    expect(sent).toContain("bob joined");
    expect(sent).toContain("alice left");
    expect(sent).toContain("eve joined");
    expect(sent).not.toContain("alice joined"); // skipped — at or below cursor

    // Cursor advanced to the max seq of the flushed batch — the live emit's seq 4.
    expect(await cursorStore.read("events")).toBe(4);

    expect(inbox.size()).toBeGreaterThanOrEqual(1);
    const heartbeats = inbox.drain().filter((m) => m.role === "heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect((heartbeats[0] as { digest: string }).digest).toContain("Two players moved");
  });

  it("filters via accepts() — chat reducer skips non-chat events on replay", async () => {
    await seedGroundTruth([
      { seq: 1, line: line("alice joined the game") },
      { seq: 2, line: "[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hi" },
      { seq: 3, line: line("alice left the game") },
    ]);
    const { manager, inbox, cursorStore } = await setup({
      name: "chat",
      promptName: "chat-reducer",
      accepts: (ev) => ev.kind === "chat",
      batchLines: 1,
    });

    mockComplete.mockResolvedValue(okMessage("alice greeted."));
    const stream = makeStream();
    const ac = new AbortController();
    await manager.startWith(stream, ac.signal);
    await wait(20);
    await manager.stop();

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const [, request] = mockComplete.mock.calls[0]!;
    const sent = (request as { messages: Array<{ content: Array<{ text: string }> }> }).messages[0]!.content[0]!.text;
    expect(sent).toContain("<alice> hi");
    expect(sent).not.toContain("joined the game");

    // Cursor advanced to the chat event's seq (2), not 3 — only flushed accepted
    // events contribute. On the next boot, the leave at seq 3 is replayed (and
    // skipped again by accepts) — harmless re-scan.
    expect(await cursorStore.read("chat")).toBe(2);
    inbox.drain();
  });

  it("retains the batch + cursor on flush failure, then advances on the next retry", async () => {
    await seedGroundTruth([
      { seq: 1, line: line("alice joined the game") },
      { seq: 2, line: line("bob joined the game") },
    ]);
    // Short interval so the retry fires inside the test's wait.
    const { manager, inbox, cursorStore } = await setup({ batchLines: 2, intervalMs: 60 });

    // Fail the first flush, succeed the second.
    mockComplete
      .mockResolvedValueOnce(errMessage())
      .mockResolvedValueOnce(okMessage("Two arrivals."));

    const stream = makeStream();
    const ac = new AbortController();
    await manager.startWith(stream, ac.signal);

    // Replay alone fills the buffer to batchLines=2 → an immediate count-triggered
    // flush, which fails (mock 1). Cursor stays at 0; degraded heartbeat in inbox.
    await wait(40);
    expect(await cursorStore.read("events")).toBe(0);
    const afterFail = inbox.drain().filter((m) => m.role === "heartbeat");
    expect(afterFail).toHaveLength(1);
    expect((afterFail[0] as { digest: string }).digest).toContain("reducer degraded");

    // Wait past intervalMs so the timer's retry fires (mock 2 succeeds).
    await wait(120);
    expect(await cursorStore.read("events")).toBe(2);
    const afterOk = inbox.drain().filter((m) => m.role === "heartbeat");
    expect(afterOk).toHaveLength(1);
    expect((afterOk[0] as { digest: string }).digest).toContain("Two arrivals");

    await manager.stop();
    ac.abort();

    // Both completion attempts happened, against the SAME two lines.
    expect(mockComplete).toHaveBeenCalledTimes(2);
    const first = (mockComplete.mock.calls[0]![1] as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0]!.content[0]!.text;
    const second = (mockComplete.mock.calls[1]![1] as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0]!.content[0]!.text;
    expect(first).toBe(second); // same payload — retry didn't drop anything
  });

  it("ground_truth was written by the previous run; cursor file persists across DmStore-style reload", async () => {
    // This is the cross-process resume story. Seed a ground_truth + cursor as if a
    // previous harness wrote them, then construct a fresh manager and confirm it
    // resumes correctly without re-processing flushed events.
    await seedGroundTruth([
      { seq: 1, line: line("alice joined the game") },
      { seq: 2, line: line("bob joined the game") },
      { seq: 3, line: line("alice left the game") },
    ]);

    // Pretend a prior process flushed up through seq 2.
    const priorCursorStore = new ReducerCursorStore(cursorDir);
    await priorCursorStore.write("events", 2);

    const { manager, cursorStore } = await setup({ batchLines: 1, intervalMs: 5_000 });
    mockComplete.mockResolvedValue(okMessage("Alice departed."));

    const stream = makeStream();
    const ac = new AbortController();
    await manager.startWith(stream, ac.signal);
    await wait(20);
    await manager.stop();
    ac.abort();

    // Only seq 3 should have been replayed + flushed.
    expect(mockComplete).toHaveBeenCalledTimes(1);
    const sent = (mockComplete.mock.calls[0]![1] as { messages: Array<{ content: Array<{ text: string }> }> })
      .messages[0]!.content[0]!.text;
    expect(sent).toContain("alice left");
    expect(sent).not.toContain("alice joined");
    expect(sent).not.toContain("bob joined");
    expect(await cursorStore.read("events")).toBe(3);
  });
});

describe("ReducerCursorStore", () => {
  it("returns 0 for a missing cursor file (fresh start)", async () => {
    const store = new ReducerCursorStore(cursorDir);
    expect(await store.read("events")).toBe(0);
  });

  it("round-trips lastSeq via atomic write", async () => {
    const store = new ReducerCursorStore(cursorDir);
    await store.write("events", 42);
    expect(await store.read("events")).toBe(42);

    // Confirm the persisted shape, not just the read value.
    const raw = await readFile(join(cursorDir, "events.json"), "utf8");
    expect(JSON.parse(raw)).toEqual({ lastSeq: 42 });
  });

  it("isolates cursors by reducer name", async () => {
    const store = new ReducerCursorStore(cursorDir);
    await store.write("events", 10);
    await store.write("chat", 5);
    expect(await store.read("events")).toBe(10);
    expect(await store.read("chat")).toBe(5);
  });
});
