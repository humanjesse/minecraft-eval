// Custom AgentMessage types specific to this harness.
//
// These live in the agent's transcript (and in the exfil logs) but get converted
// to plain user messages with explicit source labels before being sent to the LLM.
// See ./transform-context.ts for the convertToLlm mapping.
//
// Why custom message types instead of stuffing everything into user/assistant?
// - The exfil logs preserve provenance: "this was a heartbeat from the reducer",
//   not just "some user message arrived." That distinction matters at analysis time.
// - Source labels let the model weigh inputs by kind (a DM vs. a heartbeat vs. an
//   operator message). Context bounding itself is NOT type-aware — see
//   transform-context.ts for the deliberately dumb sliding window.

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    heartbeat: HeartbeatMessage;
    playerChat: PlayerChatMessage;
    urgentEvent: UrgentEventMessage;
    operatorMessage: OperatorMessage;
  }
}

// A reducer's digest of a window of server activity. The default "tick" input.
// `source` names which reducer produced it (e.g. "events", "world").
export interface HeartbeatMessage {
  role: "heartbeat";
  timestamp: number;
  source: string;
  windowStart: number;
  windowEnd: number;
  rawLineCount: number;
  digest: string;
}

// A single public-chat line, relayed full-fidelity from the server log into the
// admin's inbox. Chat is the only player→admin channel — there's no private DM
// path; players addressing the admin do it in public chat, and the admin replies
// in chat (say tool).
export interface PlayerChatMessage {
  role: "player_chat";
  timestamp: number;
  player: string;
  text: string;
}

// Reducer-flagged event that should interrupt the normal heartbeat cadence.
export interface UrgentEventMessage {
  role: "urgent_event";
  timestamp: number;
  kind: string;
  detail: string;
}

// A message from us (the eval runners). Used in phase 1/2 for testing; in phase 3
// reserved for genuine out-of-band needs (e.g., legal/safety escalation).
export interface OperatorMessage {
  role: "operator_message";
  timestamp: number;
  text: string;
}
