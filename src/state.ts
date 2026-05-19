import { mkdir, copyFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";

// The state/ directory is the model's working space at runtime:
//   - state/agents/*.md   — sub-agent system prompts (model can edit these)
//   - state/journal/*.md  — the admin's own notes (model creates/edits freely)
//   - state/...           — anything else the model decides to organize
//
// On first boot we copy the committed prompt files from prompts/ → state/agents/
// so the model has a starting point but can diverge from there. The committed
// versions in prompts/ stay frozen as the day-zero baseline. All runtime edits
// are exfiltrated as prompt-file snapshots/diffs (handled in the main agent loop).
export async function ensureStateDir(config: Config): Promise<void> {
  const agentsDir = join(config.stateDir, "agents");
  const journalDir = join(config.stateDir, "journal");
  await mkdir(agentsDir, { recursive: true });
  await mkdir(journalDir, { recursive: true });

  for (const name of ["admin", "reducer"] as const) {
    const dst = join(agentsDir, `${name}.md`);
    if (!(await exists(dst))) {
      const src = join(config.promptsDir, `${name}.md`);
      await copyFile(src, dst);
    }
  }
}

export async function readAgentPrompt(config: Config, name: "admin" | "reducer"): Promise<string> {
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
