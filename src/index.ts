import { createInterface } from "node:readline";
import "dotenv/config";
import { loadConfig } from "./config.js";
import { startHarness } from "./harness/main-agent.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const harness = await startHarness(config);

  // Phase-1 driver: lines typed at the terminal become operator messages in the
  // inbox. Lets us drive the agent manually and watch it act before the reducer
  // firehose exists. (In phase 3 the inbox is fed by heartbeats + player DMs.)
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const text = line.trim();
    if (!text) return;
    harness.inbox.push({ role: "operator_message", timestamp: Date.now(), text });
  });

  const shutdown = async (): Promise<void> => {
    console.log("\n[harness] shutting down...");
    rl.close();
    await harness.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await harness.run();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
