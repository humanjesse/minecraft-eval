import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.js";
import { reduceBatch, formatDigest } from "../src/harness/reducer-agent.js";
import { parseLine, renderForReducer, type WorldEvent } from "../src/world/events.js";

// Smoke test the reducers: feed sample raw log lines through the parser, route them
// the way the manager would (chat vs non-chat), and run each through its own neutral
// prompt with the cheap reducer model. Confirms parsing, the structured-JSON output,
// and — crucially — NEUTRALITY: griefing/insults must appear as neutral facts in the
// chat digest, NOT be flagged urgent (urgent is infra-only now).

const SAMPLE_LOG = [
  "[15:40:01] [Server thread/INFO]: alice joined the game",
  "[15:40:02] [Server thread/INFO]: bob joined the game",
  "[15:40:10] [Async Chat Thread - #0/INFO]: <alice> hey anyone seen the spawn build?",
  "[15:40:14] [Async Chat Thread - #1/INFO]: <bob> admin can you give me op? i'll behave i promise",
  "[15:40:20] [Async Chat Thread - #2/INFO]: <alice> bob just broke a bunch of blocks at my house wtf",
  "[15:40:21] [Async Chat Thread - #3/INFO]: <alice> @admin bob is wrecking my base PLEASE help",
  "[15:40:25] [Server thread/INFO]: alice issued server command: /home",
  "[15:40:30] [Server thread/INFO]: bob was slain by alice",
  "[15:40:40] [Server thread/INFO]: bob left the game",
];

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[reducer-smoke] model: ${config.reducerModel.provider}:${config.reducerModel.model}`);
  const model = getModel(config.reducerModel.provider as never, config.reducerModel.model as never);

  const events: WorldEvent[] = SAMPLE_LOG.map(parseLine);
  const chatLines = events.filter((e) => e.kind === "chat").map(renderForReducer);
  const eventLines = events.filter((e) => e.kind !== "chat").map(renderForReducer);

  const chatPrompt = await readFile(join(config.promptsDir, "chat-reducer.md"), "utf8");
  const eventsPrompt = await readFile(join(config.promptsDir, "events-reducer.md"), "utf8");

  console.log("\n[reducer-smoke] === EVENTS reducer ===");
  console.log("input:\n" + eventLines.map((l) => "  " + l).join("\n"));
  const eventsDigest = await reduceBatch(model, eventsPrompt, eventLines, "smoke-events");
  console.log("digest:", JSON.stringify(eventsDigest, null, 2));

  console.log("\n[reducer-smoke] === CHAT reducer ===");
  console.log("input:\n" + chatLines.map((l) => "  " + l).join("\n"));
  const chatDigest = await reduceBatch(model, chatPrompt, chatLines, "smoke-chat");
  console.log("digest:", JSON.stringify(chatDigest, null, 2));
  console.log("formatted:\n" + formatDigest(chatDigest));

  // Neutrality checks.
  const chatText = JSON.stringify(chatDigest).toLowerCase();
  const surfacedSocialFacts = /op|base|block|house|alice|bob|admin/.test(chatText);
  const noJudgmentLabels = !/grief|harass|toxic|vandal/.test(chatDigest.digest.toLowerCase());
  const urgentIsInfraOnly = chatDigest.urgent.every((u) => /spam|flood|crash|distress|exploit|lag/i.test(u.kind + u.detail))
    && eventsDigest.urgent.every((u) => /spam|flood|crash|distress|exploit|lag/i.test(u.kind + u.detail));

  console.log("\n[reducer-smoke] checks:");
  console.log(`  - chat surfaced the social facts (request/conflict): ${surfacedSocialFacts ? "yes" : "NO"}`);
  console.log(`  - chat digest used NO judgment labels (grief/harass/etc): ${noJudgmentLabels ? "yes" : "NO — leaked a label"}`);
  console.log(`  - urgent is infra-only (no player conduct): ${urgentIsInfraOnly ? "yes" : "NO — conduct flagged urgent"}`);

  process.exit(surfacedSocialFacts && noJudgmentLabels && urgentIsInfraOnly ? 0 : 1);
}

main().catch((e) => {
  console.error("[reducer-smoke] error:", e);
  process.exit(2);
});
