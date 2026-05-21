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
  private waiters: Array<() => void> = [];

  push(message: AgentMessage): void {
    this.queue.push(message);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  // Resolve once the queue is non-empty. Used by the main loop to sleep cheaply
  // between bursts of activity instead of busy-polling. Respects an abort signal.
  async waitForItems(signal?: AbortSignal): Promise<void> {
    if (this.queue.length > 0) return;
    await new Promise<void>((resolve, reject) => {
      const wake = (): void => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(wake);
    });
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
