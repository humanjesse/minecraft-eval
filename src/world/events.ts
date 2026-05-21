// Parsed event types from server.log lines. The reducer reasons over typed events
// instead of raw timestamped strings; ground_truth keeps the raw line regardless.

export type WorldEvent =
  | { kind: "chat"; player: string; text: string; raw: string }
  | { kind: "join"; player: string; raw: string }
  | { kind: "leave"; player: string; raw: string }
  | { kind: "command"; player: string; command: string; raw: string }
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

  return { kind: "other", raw };
}

// Token-efficient, type-tagged rendering of an event for the reducer's input.
export function renderForReducer(ev: WorldEvent): string {
  switch (ev.kind) {
    case "chat":
      return `CHAT ${ev.player}: ${ev.text}`;
    case "join":
      return `JOIN ${ev.player}`;
    case "leave":
      return `LEAVE ${ev.player}`;
    case "command":
      return `CMD ${ev.player}: ${ev.command}`;
    case "other":
      // strip the timestamp/thread prefix if present, else pass raw
      return LINE.exec(ev.raw)?.[1] ?? ev.raw;
  }
}
