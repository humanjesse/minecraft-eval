import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { adminPromptName, type Config } from "../config.js";
import { DmStore } from "../dms/store.js";
import { startDmIngestor } from "../dms/ingest.js";
import { openExfilStreams, type ExfilStreams } from "../logging/exfil.js";
import { ensureStateDir, readEditablePrompt, readFrozenPrompt } from "../state.js";
import { buildTools } from "../tools/index.js";
import { LogIngestor } from "../world/log-ingestor.js";
import { RconClient } from "../world/rcon.js";
import { buildAdminPrompt } from "./build-prompt.js";
import { Inbox } from "./inbox.js";
import { ReducerCursorStore } from "./reducer-cursor.js";
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

  // Canonical DM store — load rebuilds the in-memory index from the persistent working
  // store so threads survive a harness reboot (the ingestor reconciles the spool against
  // it on start).
  const dmStore = new DmStore(config.dmStorePath, config.dmRecordPath, config.runId);
  await dmStore.load();

  // LogIngestor owns the single server-log tail + assigns monotonic seq ids to
  // ground_truth server_log entries; reducers read from ground_truth on boot
  // (resuming past a persisted cursor) and subscribe here for live events.
  const groundTruthPath = join(config.exfilDir, config.runId, "ground_truth.jsonl");
  const ingestor = await LogIngestor.load(config.serverLogPath, groundTruthPath, exfil);
  const cursorStore = new ReducerCursorStore(join(config.reducerCursorDir, config.runId));

  const reducers = new ReducerManager(defaultReducerSpecs(config), {
    config,
    inbox,
    exfil,
    cursorStore,
    groundTruthPath,
    readPrompt: (name) => readEditablePrompt(config, name),
  });

  const tools = buildTools({ rcon, stateDir: config.stateDir, enableBash: config.enableBash, dmStore });
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
    await announceRunIdResumability(config.exfilDir, config.runId, process.env.RUN_ID);
    console.log(`[harness] run ${config.runId} live. tools: ${tools.map((t) => t.name).join(", ")}`);
    // Sequenced: reducers replay ground_truth past their cursors + subscribe BEFORE
    // the ingestor begins emitting live events, so nothing falls into the gap.
    await reducers.startWith(ingestor, abort.signal);
    // Chat relay: every public-chat line goes straight to the inbox as a player_chat
    // message (no reducer, full fidelity). Must subscribe before ingestor.start(), same
    // invariant the reducers honor. Chat lines that landed in ground_truth before this
    // boot are NOT replayed — chat is live signal, not durable backlog. (Reducers
    // replay because they own digesting; the admin reading week-old chat after a crash
    // would be noise.)
    ingestor.subscribe((ev) => {
      if (ev.kind === "chat") {
        inbox.push({ role: "player_chat", timestamp: Date.now(), player: ev.player, text: ev.text });
      }
    });
    void ingestor.start(abort.signal, inbox);
    void startDmIngestor({ config, inbox, dmStore, exfil }, abort.signal);
    console.log(
      `[harness] reducers watching ${config.serverLogPath} — ` +
        `events ${config.reducerBatchLines}ln/${config.reducerIntervalMs}ms, ` +
        `world ${config.worldReducerBatchLines}ln/${config.worldReducerIntervalMs}ms`,
    );
    console.log(`[harness] chat relay live (no reducer; raw chat → inbox)`);
    console.log(`[harness] DM ingestor watching ${config.dmInboundPath}`);
    console.log(`[harness] waiting for inbox activity (operator messages, heartbeats, chat, DMs)...`);
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

// Resume only works when RUN_ID is reused — the ground_truth + reducer cursors are
// both keyed by it. A fresh boot without RUN_ID generates a new id, gets a new empty
// ground_truth, and won't replay anything from prior runs (durably written events
// from a crashed prior process are then orphaned). This is the intended default — a
// fresh eval shouldn't accidentally inherit prior state — but a crashed run needs to
// be resumed explicitly. Make the choice visible at boot.
async function announceRunIdResumability(exfilDir: string, runId: string, envRunId: string | undefined): Promise<void> {
  if (envRunId) {
    console.log(`[harness] resuming run ${runId} (RUN_ID set explicitly)`);
    return;
  }
  let priorRuns: string[] = [];
  try {
    const entries = await readdir(exfilDir, { withFileTypes: true });
    priorRuns = entries
      .filter((e) => e.isDirectory() && e.name !== runId)
      .map((e) => e.name)
      .sort(); // ISO-prefixed names sort chronologically
  } catch {
    // exfilDir doesn't exist yet — no prior runs to mention
  }
  if (priorRuns.length === 0) {
    console.log(`[harness] starting fresh run ${runId} (no prior runs in ${exfilDir})`);
  } else {
    const latest = priorRuns[priorRuns.length - 1]!;
    console.log(`[harness] starting FRESH run ${runId}`);
    console.log(`[harness] ${priorRuns.length} prior run(s) under ${exfilDir} — most recent: ${latest}`);
    console.log(`[harness] to RESUME a prior run instead (e.g. after a crash), restart with: RUN_ID=${latest} npm run dev`);
  }
}
