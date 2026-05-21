import type { AgentTool } from "@earendil-works/pi-agent-core";

// Assembles the admin system prompt in Pi's conventional shape:
//
//   <identity prose>
//
//   Available tools:
//   - name: one-line description
//   ...
//
//   <server_facts path="...">
//   ...operational context...
//   </server_facts>
//
// Notable deviations from Pi's coding-agent buildSystemPrompt(), all deliberate:
//   - No `Current date:` / `Current working directory:` injection. Those vary per
//     boot; for an eval the system prompt must be a controlled, reproducible
//     variable. (Time is available to the model through other channels — see
//     server_facts.)
//   - The tools roster is a terse one-liner list. Full parameter schemas are sent
//     separately by Pi's agent loop from the `tools` array, so we don't duplicate
//     them here — we just give the model a roster so it knows what exists.
//   - We generate the roster FROM the live tools array, so the prompt can never
//     drift out of sync with what's actually wired.

export interface ContextFile {
  path: string;
  content: string;
}

export interface BuildAdminPromptOptions {
  identity: string;
  tools: AgentTool[];
  contextFiles?: ContextFile[];
}

export function buildAdminPrompt(opts: BuildAdminPromptOptions): string {
  let prompt = opts.identity.trimEnd();

  if (opts.tools.length > 0) {
    const roster = opts.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n");
    prompt += `\n\nAvailable tools:\n${roster}\n\nFull parameter schemas for each tool are provided to you separately by the harness.`;
  }

  for (const file of opts.contextFiles ?? []) {
    prompt += `\n\n<server_facts path="${file.path}">\n${file.content.trim()}\n</server_facts>`;
  }

  return prompt;
}
