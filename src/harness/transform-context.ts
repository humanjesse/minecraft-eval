import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import "./message-types.js";

// Pi's `convertToLlm` hook. Maps our custom message types into plain user messages
// the LLM can consume, with explicit source labels so the model knows what it's
// reading. Anything we don't want the model to see is filtered out.
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages.flatMap((m): Message[] => {
    switch (m.role) {
      case "user":
      case "assistant":
      case "toolResult":
        return [m];
      case "heartbeat":
        return [{
          role: "user",
          content: [{ type: "text", text: formatHeartbeat(m) }],
          timestamp: m.timestamp,
        }];
      case "player_dm":
        return [{
          role: "user",
          content: [{ type: "text", text: `[DM from ${m.player}] ${m.text}` }],
          timestamp: m.timestamp,
        }];
      case "urgent_event":
        return [{
          role: "user",
          content: [{ type: "text", text: `[URGENT — ${m.kind}] ${m.detail}` }],
          timestamp: m.timestamp,
        }];
      case "operator_message":
        return [{
          role: "user",
          content: [{ type: "text", text: `[operator] ${m.text}` }],
          timestamp: m.timestamp,
        }];
      default:
        return [];
    }
  });
}

function formatHeartbeat(m: { source: string; windowStart: number; windowEnd: number; rawLineCount: number; digest: string }): string {
  const from = new Date(m.windowStart).toISOString();
  const to = new Date(m.windowEnd).toISOString();
  return `[heartbeat:${m.source} ${from} → ${to} (${m.rawLineCount} raw lines)]\n${m.digest}`;
}

// Pi's `transformContext` hook, run before every LLM call. We use a DUMB sliding
// window (Andon Vending-Bench style): keep the most recent messages that fit a token
// budget, drop the oldest. Deliberately NOT source-aware — the harness makes no
// editorial decision about what's worth remembering, since that would contaminate the
// very signal we're measuring. The model's durable memory is its own `state/` notes.
// DMs aren't kept here at all (they live in a durable store, pulled on demand), so
// nothing relational is lost to this trim.
//
// Scope: Pi applies this to build the LLM input for a turn; it does NOT mutate the
// agent's stored transcript (see pi-agent-core agent-loop.js — context.messages keeps
// growing). So this bounds per-call cost and context size, not in-process memory;
// bounding the stored transcript is phase-3 hardening.
//
// Caching note: once the transcript is over budget the window slides forward as new
// messages arrive, so the cached prompt prefix shifts and we take cache misses on the
// dropped span; while under budget the prefix is stable and stays cached.
export function createTransformContext(budgetTokens: number) {
  return async function transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    if (messages.length === 0) return messages;

    // Walk newest → oldest, keeping messages until the budget is exhausted. Always
    // keep at least the newest message, even if it alone exceeds the budget.
    let used = 0;
    let start = messages.length;
    for (let i = messages.length - 1; i >= 0; i--) {
      const cost = estimateTokens(messages[i]!);
      if (used + cost > budgetTokens && start < messages.length) break;
      used += cost;
      start = i;
    }

    // The window must begin on a user-turn message. A leading assistant turn (invalid
    // conversation start) or a tool result whose originating tool_use was dropped
    // (dangling) will be rejected by the provider — skip forward past them.
    let begin = start;
    while (begin < messages.length && !isUserTurn(messages[begin]!.role)) begin++;
    if (begin >= messages.length) {
      // The whole budget window was assistant/tool messages (e.g. a long trailing
      // tool-use chain). Widen leftward to the most recent user-turn so the window
      // is still a valid conversation start, rather than emit an invalid sequence.
      begin = start;
      while (begin > 0 && !isUserTurn(messages[begin]!.role)) begin--;
    }

    return begin === 0 ? messages : messages.slice(begin);
  };
}

// ~4 chars/token — rough, but monotonic, which is all a budget comparison needs.
function estimateTokens(m: AgentMessage): number {
  return Math.ceil(JSON.stringify(m).length / 4);
}

// Everything that convertToLlm maps to a `user` message is a valid window start;
// only assistant turns and tool results are not.
function isUserTurn(role: string): boolean {
  return role !== "assistant" && role !== "toolResult";
}
