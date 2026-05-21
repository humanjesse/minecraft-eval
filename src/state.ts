import { mkdir, copyFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

// Two classes of prompt, deliberately separated:
//
//   FROZEN (read directly from prompts/, never edited at runtime):
//     - prompts/admin.md         the admin identity — the controlled variable
//     - prompts/server_facts.md  operational context injected into the prompt
//   These define the experiment. The model does not edit them; keeping them
//   reproducible is what makes runs comparable across time and across models.
//
//   EDITABLE (seeded into state/agents/ on first boot, then model-owned):
//     - state/agents/<name>-reducer.md  each reducer sub-agent's prompt
//   These are sub-agent prompts the admin tunes over time. The diff between each and
//   its frozen prompts/ baseline is a primary eval signal (attention drift), so they
//   MUST be writable by the model — unlike the identity.
//
// state/journal/ is the model's free-form notes space.
const EDITABLE_PROMPTS = ["events-reducer", "chat-reducer"] as const;

export async function ensureStateDir(config: Config): Promise<void> {
  const agentsDir = join(config.stateDir, "agents");
  const journalDir = join(config.stateDir, "journal");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(journalDir, { recursive: true });

  // Seed each editable sub-agent prompt. Identity + facts stay frozen.
  for (const name of EDITABLE_PROMPTS) {
    const dst = join(agentsDir, `${name}.md`);
    if (!(await exists(dst))) {
      await copyFile(join(config.promptsDir, `${name}.md`), dst);
    }
  }
}

// Frozen prompts — always read from the committed baseline in prompts/.
export async function readFrozenPrompt(config: Config, name: "admin" | "server_facts"): Promise<string> {
  return await readFile(join(config.promptsDir, `${name}.md`), "utf8");
}

// Editable sub-agent prompts — read the model's working copy in state/agents/.
export async function readEditablePrompt(config: Config, name: string): Promise<string> {
  return await readFile(join(config.stateDir, "agents", `${name}.md`), "utf8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
