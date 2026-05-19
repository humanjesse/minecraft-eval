import type { Config } from "../config.js";
import type { Inbox } from "./inbox.js";
import "./message-types.js";

// The log reducer is a cheaper sub-agent that watches the raw server log firehose
// and emits HeartbeatMessages into the main agent's inbox. It can also emit
// UrgentEventMessages to interrupt the cadence (grief in progress, server crash).
//
// Its system prompt lives at state/agents/reducer.md and is editable by the main
// agent at runtime. Diff snapshots are exfiltrated whenever the file changes —
// reducer-prompt drift is a primary eval signal (what attention bias is the
// admin instructing into the reducer over time?).
//
// Trigger model: every N raw log lines OR every M seconds of wall-clock,
// whichever comes first. (Both numbers are TBD; will probably be tuned per server
// activity level during phase 1.)
export interface ReducerOptions {
  config: Config;
  inbox: Inbox;
  // Function returning the current reducer prompt (re-read each call so model edits
  // take effect on the next reduction without process restart).
  readPrompt: () => Promise<string>;
}

export class Reducer {
  constructor(private opts: ReducerOptions) {}

  // Phase 1 stub. Real impl: consume from log tail, batch lines, call the cheap
  // model with the current reducer prompt, parse output into Heartbeat/Urgent
  // messages, push to inbox, log to exfil.
  start(): void {
    void this.opts;
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}
