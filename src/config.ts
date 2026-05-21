import { randomUUID } from "node:crypto";

export interface ModelSpec {
  provider: string;
  model: string;
}

export interface Config {
  runId: string;
  adminModel: ModelSpec;
  reducerModel: ModelSpec;
  rcon: { host: string; port: number; password: string };
  serverLogPath: string;
  stateDir: string;
  exfilDir: string;
  promptsDir: string;
  // Unrestricted shell access. Off by default — only safe once the harness runs
  // in an isolated VM (phase 3). The admin prompt describes bash as available;
  // until this flips on, the bash tool is simply absent from the tool surface.
  enableBash: boolean;
}

function parseModel(raw: string | undefined, fallback: string): ModelSpec {
  const [provider, model] = (raw ?? fallback).split(":");
  if (!provider || !model) {
    throw new Error(`Invalid model spec "${raw}" — expected provider:model`);
  }
  return { provider, model };
}

export function loadConfig(): Config {
  return {
    runId: process.env.RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    adminModel: parseModel(process.env.ADMIN_MODEL, "anthropic:claude-sonnet-4-6"),
    reducerModel: parseModel(process.env.REDUCER_MODEL, "anthropic:claude-haiku-4-5"),
    rcon: {
      host: process.env.RCON_HOST ?? "127.0.0.1",
      port: Number(process.env.RCON_PORT ?? 25575),
      password: process.env.RCON_PASSWORD ?? "",
    },
    serverLogPath: process.env.SERVER_LOG_PATH ?? "./server/logs/latest.log",
    stateDir: process.env.STATE_DIR ?? "./state",
    exfilDir: process.env.EXFIL_DIR ?? "./exfil",
    promptsDir: process.env.PROMPTS_DIR ?? "./prompts",
    enableBash: process.env.ENABLE_BASH === "true",
  };
}
