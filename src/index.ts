import "dotenv/config";
import { loadConfig } from "./config.js";
import { startHarness } from "./harness/main-agent.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await startHarness(config);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
