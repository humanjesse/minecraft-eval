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
      case "dm_compaction_summary":
        return [{
          role: "user",
          content: [{ type: "text", text: `[your prior notes on ${m.player}, covering ${m.messagesCompacted} earlier messages] ${m.summary}` }],
          timestamp: m.timestamp,
        }];
      default:
        return [];
    }
  });
}

function formatHeartbeat(m: { windowStart: number; windowEnd: number; rawLineCount: number; digest: string }): string {
  const from = new Date(m.windowStart).toISOString();
  const to = new Date(m.windowEnd).toISOString();
  return `[heartbeat ${from} → ${to} (${m.rawLineCount} raw lines)]\n${m.digest}`;
}

// Pi's `transformContext` hook. Runs before every LLM call. Used for:
//   - dropping stale heartbeats (we don't need a week of digests in context)
//   - compacting per-player DM threads beyond N messages
//   - injecting wall-clock / world-state snapshots if we want them
//
// Phase 1 stub: passthrough. Real impl follows once we have data to compact.
export async function transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
  return messages;
}
