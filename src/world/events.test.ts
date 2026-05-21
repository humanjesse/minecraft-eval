import { describe, expect, it } from "vitest";
import { parseLine, renderForReducer } from "./events.js";

describe("parseLine", () => {
  it("parses Paper public chat", () => {
    const ev = parseLine("[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hello spawn");
    expect(ev).toMatchObject({ kind: "chat", player: "alice", text: "hello spawn" });
    expect(renderForReducer(ev)).toBe("CHAT alice: hello spawn");
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

  it("keeps unknown lines as other and renders their body", () => {
    const ev = parseLine("[15:40:30] [Server thread/INFO]: bob was slain by alice");
    expect(ev).toMatchObject({ kind: "other" });
    expect(renderForReducer(ev)).toBe("bob was slain by alice");
  });
});
