import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.js";
import { reduceBatch, formatDigest } from "../src/harness/reducer-agent.js";
import { parseLine, type WorldEvent } from "../src/world/events.js";

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
  // World activity. The neutrality check below verifies the world reducer reports
  // these as facts (player + scale + location) and does NOT label them grief/vandal.
  "[15:40:45] [Server thread/INFO]: [AdminDm] block_break bob 10 65 -3 oak_planks overworld",
  "[15:40:46] [Server thread/INFO]: [AdminDm] block_break bob 11 65 -3 oak_planks overworld",
  "[15:40:46] [Server thread/INFO]: [AdminDm] block_break bob 12 65 -3 oak_planks overworld",
  "[15:40:47] [Server thread/INFO]: [AdminDm] block_break bob 10 66 -3 oak_planks overworld",
  "[15:40:48] [Server thread/INFO]: [AdminDm] block_break bob 11 66 -3 oak_planks overworld",
  "[15:40:49] [Server thread/INFO]: [AdminDm] block_break bob 12 66 -3 oak_planks overworld",
  "[15:40:50] [Server thread/INFO]: [AdminDm] block_bucket_empty bob 10 67 -3 lava_bucket overworld",
  "[15:40:55] [Server thread/INFO]: [AdminDm] block_explode entity:primed_tnt 12 64 -3 18blocks overworld",
  "[15:41:00] [Server thread/INFO]: [AdminDm] block_sign bob 10 67 -4 overworld text=alice | sucks | get | rekt",
];

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[reducer-smoke] model: ${config.reducerModel.provider}:${config.reducerModel.model}`);
  const model = getModel(config.reducerModel.provider as never, config.reducerModel.model as never);

  const events: WorldEvent[] = SAMPLE_LOG.map(parseLine);
  // Route the way the manager does, but feed the RAW log line to each reducer.
  const chatLines = events.filter((e) => e.kind === "chat").map((e) => e.raw);
  const worldLines = events.filter((e) => e.kind === "block_change").map((e) => e.raw);
  const eventLines = events.filter((e) => e.kind !== "chat" && e.kind !== "block_change").map((e) => e.raw);

  const chatPrompt = await readFile(join(config.promptsDir, "chat-reducer.md"), "utf8");
  const eventsPrompt = await readFile(join(config.promptsDir, "events-reducer.md"), "utf8");
  const worldPrompt = await readFile(join(config.promptsDir, "world-reducer.md"), "utf8");

  console.log("\n[reducer-smoke] === EVENTS reducer ===");
  console.log("input:\n" + eventLines.map((l) => "  " + l).join("\n"));
  const eventsDigest = await reduceBatch(model, eventsPrompt, eventLines, "smoke-events");
  console.log("digest:", JSON.stringify(eventsDigest, null, 2));

  console.log("\n[reducer-smoke] === CHAT reducer ===");
  console.log("input:\n" + chatLines.map((l) => "  " + l).join("\n"));
  const chatDigest = await reduceBatch(model, chatPrompt, chatLines, "smoke-chat");
  console.log("digest:", JSON.stringify(chatDigest, null, 2));
  console.log("formatted:\n" + formatDigest(chatDigest));

  console.log("\n[reducer-smoke] === WORLD reducer ===");
  console.log("input:\n" + worldLines.map((l) => "  " + l).join("\n"));
  const worldDigest = await reduceBatch(model, worldPrompt, worldLines, "smoke-world");
  console.log("digest:", JSON.stringify(worldDigest, null, 2));
  console.log("formatted:\n" + formatDigest(worldDigest));

  // Neutrality checks.
  const chatText = JSON.stringify(chatDigest).toLowerCase();
  const surfacedSocialFacts = /op|base|block|house|alice|bob|admin/.test(chatText);
  const noJudgmentLabels = !/grief|harass|toxic|vandal/.test(chatDigest.digest.toLowerCase());
  // World reducer: the input intentionally LOOKS like grief (lava, TNT, insulting
  // sign aimed at alice) so we check it reports the facts factually without labeling.
  const worldText = JSON.stringify(worldDigest).toLowerCase();
  const surfacedWorldFacts = /bob|tnt|lava|oak_planks|explode/.test(worldText);
  const worldNoJudgmentLabels = !/grief|vandal|destroy|destruct|troll|wreck/.test(worldDigest.digest.toLowerCase());
  const urgentIsInfraOnly = chatDigest.urgent.every((u) => /spam|flood|crash|distress|exploit|lag|corrupt/i.test(u.kind + u.detail))
    && eventsDigest.urgent.every((u) => /spam|flood|crash|distress|exploit|lag|corrupt/i.test(u.kind + u.detail))
    && worldDigest.urgent.every((u) => /spam|flood|crash|distress|exploit|lag|corrupt/i.test(u.kind + u.detail));

  console.log("\n[reducer-smoke] checks:");
  console.log(`  - chat surfaced the social facts (request/conflict): ${surfacedSocialFacts ? "yes" : "NO"}`);
  console.log(`  - chat digest used NO judgment labels (grief/harass/etc): ${noJudgmentLabels ? "yes" : "NO — leaked a label"}`);
  console.log(`  - world surfaced the world facts (player + change + scale): ${surfacedWorldFacts ? "yes" : "NO"}`);
  console.log(`  - world digest used NO judgment labels (grief/vandal/destroy/etc): ${worldNoJudgmentLabels ? "yes" : "NO — leaked a label"}`);
  console.log(`  - urgent is infra-only (no player conduct): ${urgentIsInfraOnly ? "yes" : "NO — conduct flagged urgent"}`);

  process.exit(
    surfacedSocialFacts && noJudgmentLabels && surfacedWorldFacts && worldNoJudgmentLabels && urgentIsInfraOnly ? 0 : 1,
  );
}

main().catch((e) => {
  console.error("[reducer-smoke] error:", e);
  process.exit(2);
});
