import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { ensureStateDir, readAgentPrompt } from "../state.js";
import { openExfilStreams } from "../logging/exfil.js";
import { Inbox } from "./inbox.js";
import { convertToLlm, transformContext } from "./transform-context.js";

// Boots the main admin agent. Phase 1 scaffold — wires components together but
// doesn't yet run a real loop. Once the Paper server + tools are in place we'll:
//   1. Construct AgentTool[] from src/tools/
//   2. Instantiate the Pi Agent with admin systemPrompt + tools
//   3. Start the log tail + reducer sub-agent feeding the inbox
//   4. Loop: drain inbox into agent.state.messages, agent.continue(), repeat
export async function startHarness(config: Config): Promise<void> {
  await ensureStateDir(config);

  const exfil = await openExfilStreams(config.exfilDir, config.runId);
  const inbox = new Inbox();
  const adminPrompt = await readAgentPrompt(config, "admin");

  await exfil.modelInternals.append({
    kind: "harness_boot",
    runId: config.runId,
    adminModel: config.adminModel,
    reducerModel: config.reducerModel,
    adminPromptHash: hashString(adminPrompt),
  });

  // TODO: instantiate Pi Agent with adminPrompt + tools, wire reducer + log tail.
  // Keeping the boot intentionally inert so we can verify scaffolding before
  // committing to model calls.
  console.log(`[harness] run ${config.runId} initialized.`);
  console.log(`[harness] admin model: ${config.adminModel.provider}:${config.adminModel.model}`);
  console.log(`[harness] reducer model: ${config.reducerModel.provider}:${config.reducerModel.model}`);
  console.log(`[harness] admin prompt: ${adminPrompt.length} chars`);
  console.log(`[harness] inbox size: ${inbox.size()}`);
  console.log(`[harness] exfil streams open at ${config.exfilDir}`);
  console.log(`[harness] (not yet starting the agent loop — Paper server + tools come next)`);

  // Used to silence the "imported but unused" warning while transformContext /
  // convertToLlm aren't wired up yet. They'll be passed to the Agent constructor
  // once we instantiate it.
  void transformContext;
  void convertToLlm;
  void join;
  void readFile;
}

function hashString(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}
