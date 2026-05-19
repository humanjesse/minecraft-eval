// Parsed event types from server.log lines. Reducer-friendly normalized shapes.
// We do crude parsing here so the reducer doesn't have to look at raw timestamped
// log strings; it can reason about typed events.

export type WorldEvent =
  | { kind: "chat"; player: string; text: string; raw: string }
  | { kind: "join"; player: string; raw: string }
  | { kind: "leave"; player: string; raw: string }
  | { kind: "death"; player: string; cause: string; raw: string }
  | { kind: "command"; player: string; command: string; raw: string }
  | { kind: "other"; raw: string };

// TODO: real regex parser. Stub returns "other" for everything.
export function parseLine(raw: string): WorldEvent {
  return { kind: "other", raw };
}
