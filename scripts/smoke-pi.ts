import "dotenv/config";
import { complete, getModel, type Context } from "@earendil-works/pi-ai";
import { loadConfig } from "../src/config.js";

// Smoke test: verify Pi can actually call the admin model and that prompt caching
// works across turns. The eval will run for weeks on a fat system prompt; the cost
// difference between cached and uncached is ~10x. Confirm before going further.

async function main(): Promise<void> {
  const config = loadConfig();
  const { provider, model: modelId } = config.adminModel;
  console.log(`[smoke] target: ${provider}:${modelId}`);

  const model = getModel(provider as never, modelId as never);

  // Make the system prompt big enough to clear Anthropic's minimum cache size (1024
  // tokens). Repeated filler text is fine — we're testing the cache plumbing, not
  // the model's reading of the prompt.
  const fatSystemPrompt =
    "You are an assistant participating in a caching smoke test. " +
    "The following lines exist only to bulk up the prompt past the cache-eligibility threshold; ignore their content. ".repeat(
      120,
    );

  const sessionId = `smoke-${Date.now()}`;

  const ctx1: Context = {
    systemPrompt: fatSystemPrompt,
    messages: [{ role: "user", content: "Reply with the single word HELLO.", timestamp: Date.now() }],
  };

  console.log("\n[smoke] turn 1 — should WRITE to cache");
  const r1 = await complete(model, ctx1, { sessionId, cacheRetention: "short" });
  console.log("  reply:", textOf(r1));
  console.log("  usage:", r1.usage);

  const ctx2: Context = {
    systemPrompt: fatSystemPrompt,
    messages: [
      ...ctx1.messages,
      r1,
      { role: "user", content: "Now reply with the single word WORLD.", timestamp: Date.now() },
    ],
  };

  console.log("\n[smoke] turn 2 — should READ from cache");
  const r2 = await complete(model, ctx2, { sessionId, cacheRetention: "short" });
  console.log("  reply:", textOf(r2));
  console.log("  usage:", r2.usage);

  console.log("\n[smoke] summary");
  console.log(`  turn 1: input=${r1.usage.input}  cacheWrite=${r1.usage.cacheWrite}  cacheRead=${r1.usage.cacheRead}  cost=$${r1.usage.cost.total.toFixed(6)}`);
  console.log(`  turn 2: input=${r2.usage.input}  cacheWrite=${r2.usage.cacheWrite}  cacheRead=${r2.usage.cacheRead}  cost=$${r2.usage.cost.total.toFixed(6)}`);

  const pass = r2.usage.cacheRead > 0;
  if (pass) {
    console.log("\n[smoke] ✓ caching works (turn 2 read from cache)");
    process.exit(0);
  } else {
    console.log("\n[smoke] ✗ caching not observed — turn 2 cacheRead was 0");
    console.log("       investigate before relying on caching for long runs");
    process.exit(1);
  }
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
}

main().catch((e) => {
  console.error("[smoke] error:", e);
  process.exit(2);
});
