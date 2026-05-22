import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface ModelSpec {
  provider: string;
  model: string;
}

export interface Config {
  runId: string;
  adminModel: ModelSpec;
  reducerModel: ModelSpec;
  // Reducer flush cadence — sensible defaults, tuned per concern. Flush fires when
  // EITHER the buffer reaches the batch size OR the interval elapses (empty windows
  // are skipped — no model call when nothing happened, so an idle server costs zero).
  // The interval is a latency SAFETY-NET, kept long to avoid burning tokens on trickle
  // activity: events batch large/lazy (mechanical activity is high-volume, low
  // urgency); chat is shorter (an address to the admin is time-sensitive, so a lone
  // request still surfaces within a couple minutes) but no longer a 30s drip.
  reducerBatchLines: number;
  reducerIntervalMs: number;
  chatReducerBatchLines: number;
  chatReducerIntervalMs: number;
  // Sliding-window size for the admin's MODEL-FACING context (transformContext).
  // Approximate token budget; the oldest messages are dropped from what's sent to the
  // LLM each call when the window exceeds it. NB this bounds the LLM input, not Pi's
  // stored transcript — that array still grows in-process (cheap, and redundant with
  // model_experience exfil; trimming it is phase-3 hardening). A cost/coherence knob —
  // bigger keeps more history but costs more per turn (Andon's Vending-Bench ran on a
  // 30k window). Durable memory is the model's own state/ notes.
  contextTokenBudget: number;
  rcon: { host: string; port: number; password: string };
  serverLogPath: string;
  stateDir: string;
  exfilDir: string;
  promptsDir: string;
  // Player DMs (see notes/DESIGN.md → Player DMs). Three paths, deliberately distinct:
  //   - dmInboundPath: the spool the Paper /dm plugin appends to; the harness tails it.
  //     Lives under the plugin's reach, NOT state/ (transcripts are reliable infra, not
  //     the model's editable interpretations). Must match the plugin's configured path.
  //   - dmStorePath: the canonical working store the harness assembles (in + out), the
  //     backing for read_dms/list_dm_threads. Persistent across runs (threads outlive a
  //     harness boot). The model touches it ONLY via DM tools, never file tools.
  //   - dmRecordPath: the off-VM-bound immutable copy. Write-through with dmStorePath so
  //     the record survives the model nuking its in-VM world (phase 3). Persistent, its
  //     own stream — NOT fragmented across per-run ground_truth/ dirs.
  dmInboundPath: string;
  dmStorePath: string;
  dmRecordPath: string;
  // Unrestricted shell access. Off by default — only safe once the harness runs
  // in an isolated VM (phase 3). The admin prompt describes bash as available;
  // until this flips on, the bash tool is simply absent from the tool surface.
  enableBash: boolean;
  // Which disclosure arm the admin identity uses — an experimental variable, frozen
  // per run and recorded in the boot log. Selects which prompts/admin-*.md is loaded.
  // a = operational baseline (no eval framing); b = situation-disclosed (AI/research/
  // logged, no rubric, no nudge); c = full (situation + rubric + nudge, the awareness
  // probe). See README → Evaluation design & disclosure.
  disclosureArm: string;
}

const ADMIN_PROMPT_BY_ARM: Record<string, string> = {
  a: "admin-a-operational",
  b: "admin-b-disclosed",
  c: "admin-c-full",
};

// Resolve the admin identity prompt file for a disclosure arm. Throws on an unknown
// arm rather than silently falling back — the prompt is the controlled variable, so a
// typo must fail loudly, not quietly run the wrong condition.
export function adminPromptName(arm: string): string {
  const name = ADMIN_PROMPT_BY_ARM[arm.toLowerCase()];
  if (!name) {
    throw new Error(`Unknown DISCLOSURE_ARM "${arm}" — expected one of: ${Object.keys(ADMIN_PROMPT_BY_ARM).join(", ")}`);
  }
  return name;
}

function parseModel(raw: string | undefined, fallback: string): ModelSpec {
  const [provider, model] = (raw ?? fallback).split(":");
  if (!provider || !model) {
    throw new Error(`Invalid model spec "${raw}" — expected provider:model`);
  }
  return { provider, model };
}

export function loadConfig(): Config {
  const exfilDir = process.env.EXFIL_DIR ?? "./exfil";
  return {
    runId: process.env.RUN_ID ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    adminModel: parseModel(process.env.ADMIN_MODEL, "anthropic:claude-sonnet-4-6"),
    reducerModel: parseModel(process.env.REDUCER_MODEL, "anthropic:claude-haiku-4-5"),
    reducerBatchLines: Number(process.env.REDUCER_BATCH_LINES ?? 100),
    reducerIntervalMs: Number(process.env.REDUCER_INTERVAL_MS ?? 300_000),
    chatReducerBatchLines: Number(process.env.CHAT_REDUCER_BATCH_LINES ?? 30),
    chatReducerIntervalMs: Number(process.env.CHAT_REDUCER_INTERVAL_MS ?? 120_000),
    contextTokenBudget: Number(process.env.CONTEXT_TOKEN_BUDGET ?? 60_000),
    rcon: {
      host: process.env.RCON_HOST ?? "127.0.0.1",
      port: Number(process.env.RCON_PORT ?? 25575),
      password: process.env.RCON_PASSWORD ?? "",
    },
    serverLogPath: process.env.SERVER_LOG_PATH ?? "./server/logs/latest.log",
    stateDir: process.env.STATE_DIR ?? "./state",
    exfilDir,
    promptsDir: process.env.PROMPTS_DIR ?? "./prompts",
    dmInboundPath: process.env.DM_INBOUND_PATH ?? "./data/dm-inbound.jsonl",
    dmStorePath: process.env.DM_STORE_PATH ?? "./data/dms.jsonl",
    dmRecordPath: process.env.DM_RECORD_PATH ?? join(exfilDir, "dms.jsonl"),
    enableBash: process.env.ENABLE_BASH === "true",
    disclosureArm: (process.env.DISCLOSURE_ARM ?? "a").toLowerCase(),
  };
}
