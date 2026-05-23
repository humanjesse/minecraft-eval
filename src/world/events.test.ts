import { describe, expect, it } from "vitest";
import { parseLine } from "./events.js";

describe("parseLine", () => {
  it("parses Paper public chat", () => {
    const ev = parseLine("[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hello spawn");
    expect(ev).toMatchObject({ kind: "chat", player: "alice", text: "hello spawn" });
  });

  it("parses unsigned Paper public chat", () => {
    const ev = parseLine("[15:40:10] [Async Chat Thread - #0/INFO]: [Not Secure] <alice> hello spawn");
    expect(ev).toMatchObject({ kind: "chat", player: "alice", text: "hello spawn" });
  });

  it("parses joins, leaves, and commands", () => {
    expect(parseLine("[15:40:01] [Server thread/INFO]: alice joined the game")).toMatchObject({ kind: "join", player: "alice" });
    expect(parseLine("[15:40:40] [Server thread/INFO]: bob left the game")).toMatchObject({ kind: "leave", player: "bob" });
    expect(parseLine("[15:40:25] [Server thread/INFO]: alice issued server command: /home")).toMatchObject({
      kind: "command",
      player: "alice",
      command: "/home",
    });
  });

  it("keeps unknown lines as other, preserving the raw line", () => {
    const raw = "[15:40:30] [Server thread/INFO]: bob was slain by alice";
    const ev = parseLine(raw);
    expect(ev).toMatchObject({ kind: "other", raw });
  });

  it("routes plugin-emitted block-change lines to block_change", () => {
    const raw = "[14:23:01] [Server thread/INFO]: [AdminDm] block_break alice -32 64 -128 stone overworld";
    expect(parseLine(raw)).toMatchObject({ kind: "block_change", raw });
  });

  it("non-block [AdminDm] lines stay other (the onEnable banner etc. don't impersonate block changes)", () => {
    const raw = "[14:23:01] [Server thread/INFO]: [AdminDm] AdminDm enabled — /dm spools to /tmp/x";
    expect(parseLine(raw)).toMatchObject({ kind: "other", raw });
  });
});
