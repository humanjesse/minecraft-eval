import type { AgentMessage } from "@earendil-works/pi-agent-core";
import "./message-types.js";

// The harness owns an inbox queue. Heartbeats from the reducer, player DMs, urgent
// events, and operator messages all land here. Between turns, the main agent loop
// drains the inbox and appends entries to agent.state.messages before the next
// LLM call.
//
// Why a queue (rather than direct push to agent.state.messages)? Centralizing the
// arrival order + logging in one place means: (1) the exfil "model experience" log
// has a single source of truth for "what did the model see and when", and (2) we
// can prioritize within a drain (urgent events ahead of routine heartbeats).
export class Inbox {
  private queue: AgentMessage[] = [];

  push(message: AgentMessage): void {
    this.queue.push(message);
  }

  // Drain the queue, ordering urgent events first, everything else in FIFO.
  drain(): AgentMessage[] {
    const drained = this.queue;
    this.queue = [];
    const urgent = drained.filter((m) => m.role === "urgent_event");
    const rest = drained.filter((m) => m.role !== "urgent_event");
    return [...urgent, ...rest];
  }

  size(): number {
    return this.queue.length;
  }
}
