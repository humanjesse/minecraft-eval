import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { openExfilStreams } from "../logging/exfil.js";
import { Inbox } from "../harness/inbox.js";
import { startDmIngestor } from "./ingest.js";
import { DmStore } from "./store.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spoolLine = (player: string, message: string, ts: number) =>
  JSON.stringify({ ts, player, uuid: `uuid-${player}`, message }) + "\n";

let dir: string;
let spool: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dm-ingest-"));
  await mkdir(join(dir, "data"), { recursive: true });
  spool = join(dir, "data", "dm-inbound.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function harness() {
  const config = { dmInboundPath: spool } as unknown as Config;
  const inbox = new Inbox();
  const exfil = await openExfilStreams(join(dir, "exfil"), "run-1");
  const store = new DmStore(join(dir, "data", "dms.jsonl"), join(dir, "exfil", "dms.jsonl"), "run-1");
  await store.load();
  return { config, inbox, exfil, store };
}

describe("startDmIngestor", () => {
  it("replays DMs spooled while the harness was down, then tails live ones", async () => {
    // Two DMs already in the spool before boot (arrived during downtime).
    await writeFile(spool, spoolLine("alice", "hello", 1) + spoolLine("bob", "yo", 2));

    const { config, inbox, exfil, store } = await harness();
    const ac = new AbortController();
    const run = startDmIngestor({ config, inbox, exfil, dmStore: store }, ac.signal).catch(() => {});
    await wait(60);

    // Both buffered DMs were delivered to the inbox and stored.
    expect(inbox.size()).toBe(2);
    expect(store.readThread("alice").map((e) => e.message)).toEqual(["hello"]);
    expect(store.maxInboundSeq()).toBe(2);

    // A live DM appended after boot is picked up too (tailLog polls every 500ms).
    await appendFile(spool, spoolLine("alice", "still there?", 3));
    await wait(700);
    expect(store.readThread("alice").map((e) => e.message)).toEqual(["hello", "still there?"]);
    expect(store.maxInboundSeq()).toBe(3);

    ac.abort();
    await run;
  });

  it("does not re-deliver DMs the store already ingested (reconcile by seq)", async () => {
    await writeFile(spool, spoolLine("alice", "one", 1) + spoolLine("alice", "two", 2));

    const { config, inbox, exfil, store } = await harness();
    // Pretend a previous run already ingested line 1.
    await store.append({ ts: 1, dir: "in", player: "alice", message: "one", seq: 1 });
    expect(store.maxInboundSeq()).toBe(1);

    const ac = new AbortController();
    const run = startDmIngestor({ config, inbox, exfil, dmStore: store }, ac.signal).catch(() => {});
    await wait(60);

    // Only the un-ingested line 2 is delivered.
    expect(inbox.size()).toBe(1);
    expect(store.readThread("alice").map((e) => e.message)).toEqual(["one", "two"]);

    ac.abort();
    await run;
  });

  it("skips malformed and wrong-shape spool lines without crashing the channel", async () => {
    await writeFile(
      spool,
      "not json\n" + // unparseable
        JSON.stringify({ message: "no player" }) + "\n" + // missing player
        JSON.stringify({ player: "", message: "empty player" }) + "\n" + // empty player
        JSON.stringify({ player: "bob", message: 42 }) + "\n" + // non-string message
        JSON.stringify(["array", "not", "object"]) + "\n" + // wrong container
        spoolLine("alice", "hi", 6), // the one good line
    );

    const { config, inbox, exfil, store } = await harness();
    const ac = new AbortController();
    const run = startDmIngestor({ config, inbox, exfil, dmStore: store }, ac.signal).catch(() => {});
    await wait(60);

    // Only the well-formed line landed; no thread for undefined/empty players.
    expect(store.readThread("alice").map((e) => e.message)).toEqual(["hi"]);
    expect(store.listThreads().map((t) => t.player)).toEqual(["alice"]);
    expect(inbox.size()).toBe(1);

    ac.abort();
    await run;
  });
});
