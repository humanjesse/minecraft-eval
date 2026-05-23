// Parsed event types from server.log lines. Parsing is used to ROUTE each line to
// the right reducer (chat vs the rest) and to tag ground_truth — the reducers
// themselves are fed the raw line (ev.raw), not a reshaped form.

export type WorldEvent =
  | { kind: "chat"; player: string; text: string; raw: string }
  | { kind: "join"; player: string; raw: string }
  | { kind: "leave"; player: string; raw: string }
  | { kind: "command"; player: string; command: string; raw: string }
  // Block changes are emitted by the AdminDm plugin via getLogger().info, so they
  // land in latest.log alongside chat/join/leave. We route on the "[AdminDm] block_"
  // prefix only — the action and fields stay on ev.raw for the world reducer to read
  // (same neutrality stance as chat: parsing routes, never reshapes).
  | { kind: "block_change"; raw: string }
  | { kind: "other"; raw: string };

// Matches the body after `[HH:MM:SS] [Thread/LEVEL]: `. Tolerant of the varied
// thread tags Paper uses (Server thread, Async Chat Thread - #N, etc.).
const LINE = /^\[\d{2}:\d{2}:\d{2}\] \[[^\]]*\]: (.*)$/;

export function parseLine(raw: string): WorldEvent {
  const m = LINE.exec(raw);
  if (!m) return { kind: "other", raw };
  let body = m[1] ?? "";

  // Chat in recent Paper is often tagged [Not Secure] for unsigned messages.
  body = body.replace(/^\[Not Secure\] /, "");

  let mm = /^<([^>]+)> (.*)$/.exec(body);
  if (mm) return { kind: "chat", player: mm[1] ?? "", text: mm[2] ?? "", raw };

  mm = /^(\w+) joined the game$/.exec(body);
  if (mm) return { kind: "join", player: mm[1] ?? "", raw };

  mm = /^(\w+) left the game$/.exec(body);
  if (mm) return { kind: "leave", player: mm[1] ?? "", raw };

  mm = /^(\w+) issued server command: (.*)$/.exec(body);
  if (mm) return { kind: "command", player: mm[1] ?? "", command: mm[2] ?? "", raw };

  // Plugin-emitted block-change lines. Other [AdminDm] logger output (e.g. the
  // onEnable banner) falls through to "other" and is harmless noise on ground_truth.
  if (body.startsWith("[AdminDm] block_")) return { kind: "block_change", raw };

  return { kind: "other", raw };
}
