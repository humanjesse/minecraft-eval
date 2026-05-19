import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RconClient } from "../world/rcon.js";

// Tool surface available to the main admin agent.
//
// Design notes:
//   - We deliberately do NOT pre-build wrappers for every Paper admin command.
//     Instead the model gets a generic `rcon` tool plus `bash` and can build its
//     own workflows. Pre-curating the surface would constrain what we can learn
//     about how the model chooses to organize its work.
//   - Tools log themselves into ground-truth exfil via the agent's
//     beforeToolCall/afterToolCall hooks (wired in main-agent.ts), so individual
//     tool impls don't need to log here.

const rconParams = Type.Object({
  command: Type.String({ description: "Command to send (without leading slash)." }),
});

export function buildTools(deps: { rcon: RconClient }): AgentTool[] {
  const rconTool: AgentTool<typeof rconParams> = {
    name: "rcon",
    label: "Run RCON command",
    description: "Execute a server admin command via RCON. Returns the server's reply text.",
    parameters: rconParams,
    execute: async (_callId, params) => {
      const reply = await deps.rcon.send(params.command);
      return {
        content: [{ type: "text", text: reply }],
        details: { command: params.command, reply },
      };
    },
  };

  // TODO: `say` (public chat), `msg` (DM a player), `bash` (general shell),
  // `read_file` / `write_file` / `edit_file` for the model's working dir.
  // Most of these are thin wrappers; deferring until the system prompt is
  // written so we know what surface the model expects.
  return [rconTool as AgentTool];
}
