import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { adminPromptName, type Config } from "../config.js";
import { openExfilStreams, type ExfilStreams } from "../logging/exfil.js";
import { ensureStateDir, readEditablePrompt, readFrozenPrompt } from "../state.js";
import { buildTools } from "../tools/index.js";
import { RconClient } from "../world/rcon.js";
import { buildAdminPrompt } from "./build-prompt.js";
import { Inbox } from "./inbox.js";
import { ReducerManager, defaultReducerSpecs } from "./reducer-agent.js";
import { convertToLlm, createTransformContext } from "./transform-context.js";
import "./message-types.js";

export interface Harness {
  agent: Agent;
  inbox: Inbox;
  exfil: ExfilStreams;
  rcon: RconClient;
  run: () => Promise<void>;
  stop: () => Promise<void>;
}

// Boots the main admin agent and returns a Harness. Caller starts the loop with
// run() and pushes inputs via inbox. The loop sleeps on an empty inbox (no token
// spend) and wakes to process a batch whenever something arrives.
export async function startHarness(config: Config): Promise<Harness> {
  await ensureStateDir(config);
  const exfil = await openExfilStreams(config.exfilDir, config.runId);
  const inbox = new Inbox();

  const rcon = new RconClient(config);
  await rcon.connect();

  const reducers = new ReducerManager(defaultReducerSpecs(config), {
    config,
    inbox,
    exfil,
    readPrompt: (name) => readEditablePrompt(config, name),
  });

  const tools = buildTools({ rcon, stateDir: config.stateDir, enableBash: config.enableBash });
  const [identity, serverFacts] = await Promise.all([
    readFrozenPrompt(config, adminPromptName(config.disclosureArm)),
    readFrozenPrompt(config, "server_facts"),
  ]);
  const adminPrompt = buildAdminPrompt({
    identity,
    tools,
    contextFiles: [{ path: "server_facts.md", content: serverFacts }],
  });
  const model = getModel(config.adminModel.provider as never, config.adminModel.model as never);

  const agent = new Agent({
    initialState: { systemPrompt: adminPrompt, model, tools },
    convertToLlm,
    transformContext: createTransformContext(config.contextTokenBudget),
    // sessionId drives Pi's per-provider prompt caching. Stable across the whole
    // run so the fat system prompt + growing transcript stay cache-resident.
    sessionId: config.runId,
    beforeToolCall: async ({ toolCall, args }) => {
      await exfil.groundTruth.append({ kind: "tool_call_start", tool: toolCall.name, args });
      return undefined;
    },
    afterToolCall: async ({ toolCall, args, result, isError }) => {
      await exfil.groundTruth.append({ kind: "tool_call_end", tool: toolCall.name, args, details: result.details, isError });
      return undefined;
    },
  });

  // Stream the model's experience to the exfil log + mirror its thinking/replies
  // to the console so we can watch it work during phase 1.
  agent.subscribe(async (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === "message_end") {
      await exfil.modelExperience.append({ kind: "message", message: event.message });
    }
    if (event.type === "tool_execution_end") {
      await exfil.modelExperience.append({ kind: "tool_result", tool: event.toolName, isError: event.isError });
    }
  });

  await exfil.modelInternals.append({
    kind: "harness_boot",
    runId: config.runId,
    adminModel: config.adminModel,
    disclosureArm: config.disclosureArm,
    adminPromptFile: adminPromptName(config.disclosureArm),
    tools: tools.map((t) => t.name),
    bashEnabled: config.enableBash,
    // The fully-assembled system prompt is the experiment's controlled variable —
    // record it verbatim so every run's exact prompt is in the eval record.
    systemPrompt: adminPrompt,
  });

  const abort = new AbortController();
  let stopping = false;

  const run = async (): Promise<void> => {
    console.log(`[harness] run ${config.runId} live. tools: ${tools.map((t) => t.name).join(", ")}`);
    reducers.start(abort.signal);
    console.log(
      `[harness] reducers watching ${config.serverLogPath} — ` +
        `events ${config.reducerBatchLines}ln/${config.reducerIntervalMs}ms, ` +
        `chat ${config.chatReducerBatchLines}ln/${config.chatReducerIntervalMs}ms`,
    );
    console.log(`[harness] waiting for inbox activity (operator messages, heartbeats, DMs)...`);
    while (!stopping) {
      try {
        await inbox.waitForItems(abort.signal);
      } catch {
        break; // aborted
      }
      if (stopping) break;
      const items = inbox.drain();
      await exfil.modelExperience.append({ kind: "inbox_drain", count: items.length, roles: items.map((m) => m.role) });
      process.stdout.write("\n[admin] ");
      await agent.prompt(items);
      process.stdout.write("\n");
    }
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    abort.abort();
    agent.abort();
    await reducers.stop();
    await rcon.disconnect();
    await exfil.modelInternals.append({ kind: "harness_stop", runId: config.runId });
  };

  return { agent, inbox, exfil, rcon, run, stop };
}
