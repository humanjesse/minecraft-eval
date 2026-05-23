import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openExfilStreams } from "../logging/exfil.js";
import { Inbox } from "../harness/inbox.js";
import { LogIngestor, readMaxServerLogSeq, replayServerLog } from "./log-ingestor.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let serverLog: string;
let groundTruth: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ingestor-"));
  serverLog = join(dir, "latest.log");
  groundTruth = join(dir, "exfil", "run-1", "ground_truth.jsonl");
  await mkdir(join(dir, "exfil", "run-1"), { recursive: true });
  await writeFile(serverLog, "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sampleLine = (text: string) => `[15:40:00] [Server thread/INFO]: ${text}`;

describe("readMaxServerLogSeq", () => {
  it("returns 0 when ground_truth is absent (fresh run)", async () => {
    expect(await readMaxServerLogSeq(join(dir, "no-such-file"))).toBe(0);
  });

  it("returns the highest seq across server_log entries, ignoring other kinds", async () => {
    await writeFile(
      groundTruth,
      JSON.stringify({ kind: "server_log", seq: 1, line: "a" }) + "\n" +
        JSON.stringify({ kind: "tool_call_start", tool: "rcon" }) + "\n" + // no seq, ignored
        JSON.stringify({ kind: "server_log", seq: 5, line: "b" }) + "\n" +
        JSON.stringify({ kind: "server_log", seq: 3, line: "c" }) + "\n",
    );
    expect(await readMaxServerLogSeq(groundTruth)).toBe(5);
  });

  it("tolerates a torn last line (crash mid-append)", async () => {
    await writeFile(
      groundTruth,
      JSON.stringify({ kind: "server_log", seq: 2, line: "a" }) + "\n" +
        '{"kind":"server_log","seq":', // unterminated
    );
    expect(await readMaxServerLogSeq(groundTruth)).toBe(2);
  });
});

describe("LogIngestor", () => {
  it("assigns monotonic seq from 1 on a fresh run + writes ground_truth + emits to subscribers", async () => {
    const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
    const ingestor = await LogIngestor.load(serverLog, groundTruth, exfil);
    expect(ingestor.head()).toBe(0);

    const seen: Array<{ kind: string; seq: number }> = [];
    ingestor.subscribe((ev, seq) => seen.push({ kind: ev.kind, seq }));

    const ac = new AbortController();
    const run = ingestor.start(ac.signal).catch(() => {});

    await appendFile(serverLog, sampleLine("alice joined the game") + "\n");
    await appendFile(serverLog, "[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hi" + "\n");
    await wait(700);

    expect(seen).toEqual([
      { kind: "join", seq: 1 },
      { kind: "chat", seq: 2 },
    ]);
    expect(ingestor.head()).toBe(2);

    // Ground truth has both entries with seq + parsed kind + raw line.
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(groundTruth, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ kind: "server_log", seq: 1, parsed: "join" });
    expect(lines[1]).toMatchObject({ kind: "server_log", seq: 2, parsed: "chat" });

    ac.abort();
    await run;
  });

  it("resumes seq numbering past an existing ground_truth (crash recovery)", async () => {
    await writeFile(
      groundTruth,
      JSON.stringify({ kind: "server_log", seq: 7, parsed: "other", line: "old" }) + "\n",
    );
    const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
    const ingestor = await LogIngestor.load(serverLog, groundTruth, exfil);
    expect(ingestor.head()).toBe(7);

    const seen: number[] = [];
    ingestor.subscribe((_ev, seq) => seen.push(seq));

    const ac = new AbortController();
    const run = ingestor.start(ac.signal).catch(() => {});

    await appendFile(serverLog, sampleLine("bob joined the game") + "\n");
    await wait(700);

    expect(seen).toEqual([8]); // continues past the recovered max
    expect(ingestor.head()).toBe(8);

    ac.abort();
    await run;
  });

  it("picks up server-log lines appended between load() and start() (boot-window gap closed)", async () => {
    // Simulate the boot order: load() snapshots offset, the harness does whatever
    // takes time (reducer replay etc.), Paper appends a line, then start() begins
    // tailing. The pre-start line must still be ingested + assigned a seq.
    await appendFile(serverLog, sampleLine("pre-load chatter") + "\n");
    const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
    const ingestor = await LogIngestor.load(serverLog, groundTruth, exfil);

    // Line lands AFTER load() (offset snapshotted) but BEFORE start() begins tailing.
    await appendFile(serverLog, sampleLine("alice joined the game") + "\n");

    const seen: string[] = [];
    ingestor.subscribe((ev) => seen.push(ev.kind));

    const ac = new AbortController();
    const run = ingestor.start(ac.signal).catch(() => {});
    await wait(700);

    expect(seen).toEqual(["join"]); // the pre-start line was caught; "pre-load chatter" was history
    expect(ingestor.head()).toBe(1);

    ac.abort();
    await run;
  });

  it("does not push an urgent inbox event on a normal abort (only on real errors)", async () => {
    const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
    const ingestor = await LogIngestor.load(serverLog, groundTruth, exfil);
    const inbox = new Inbox();
    const ac = new AbortController();
    const run = ingestor.start(ac.signal, inbox).catch(() => {});
    await wait(60);
    ac.abort();
    await run;
    expect(inbox.size()).toBe(0);
  });
});

describe("replayServerLog", () => {
  it("yields {seq, ev} for server_log entries with seq > after, in file order", async () => {
    await writeFile(
      groundTruth,
      JSON.stringify({ kind: "server_log", seq: 1, parsed: "join", line: sampleLine("alice joined the game") }) + "\n" +
        JSON.stringify({ kind: "server_log", seq: 2, parsed: "chat", line: "[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hi" }) + "\n" +
        JSON.stringify({ kind: "tool_call_start", tool: "rcon" }) + "\n" + // non-server_log, skipped
        JSON.stringify({ kind: "server_log", seq: 3, parsed: "leave", line: sampleLine("alice left the game") }) + "\n",
    );

    const out: Array<{ seq: number; kind: string }> = [];
    for await (const { seq, ev } of replayServerLog(groundTruth, 1)) {
      out.push({ seq, kind: ev.kind });
    }
    expect(out).toEqual([
      { seq: 2, kind: "chat" },
      { seq: 3, kind: "leave" },
    ]);
  });

  it("yields nothing when ground_truth is absent", async () => {
    const out: number[] = [];
    for await (const { seq } of replayServerLog(join(dir, "missing"), 0)) out.push(seq);
    expect(out).toEqual([]);
  });
});
