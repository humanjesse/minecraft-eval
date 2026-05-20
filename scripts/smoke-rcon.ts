import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { RconClient } from "../src/world/rcon.js";

// Smoke test: verify the RconClient wrapper can connect to the running Paper
// server and execute commands. Exercises our actual src/world/rcon.ts code path,
// not just the server.

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`[rcon] connecting to ${config.rcon.host}:${config.rcon.port}`);

  const client = new RconClient(config);
  await client.connect();
  console.log("[rcon] connected");

  for (const command of ["list", "say minecraft-eval harness online", "time query daytime"]) {
    const reply = await client.send(command);
    console.log(`[rcon] > ${command}\n        ${reply.trim() || "(no reply)"}`);
  }

  await client.disconnect();
  console.log("[rcon] disconnected — ✓");
}

main().catch((e) => {
  console.error("[rcon] error:", e);
  process.exit(1);
});
