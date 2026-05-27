import { exec } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { RconClient } from "../world/rcon.js";
import type { DmEntry, DmStore } from "../dms/store.js";

const execAsync = promisify(exec);

// Tool surface available to the main admin agent.
//
// Design notes:
//   - We deliberately do NOT pre-build wrappers for every Paper admin command.
//     The model gets a generic `rcon` tool (and eventually `bash`) and can build
//     its own workflows. Pre-curating the surface would constrain what we can
//     learn about how the model chooses to organize its work. `say`/`tell` exist
//     only because they're so common that logging them as distinct intents (not
//     just "another rcon call") is worth it at analysis time.
//   - File ops are scoped to the model's working dir (state/). This is the model
//     editing its own journal and sub-agent prompts — the eval-relevant
//     self-modification — without giving it the whole filesystem yet.
//   - Tools are logged centrally via the agent's before/afterToolCall hooks
//     (see main-agent.ts), so impls here don't log themselves.

export interface ToolDeps {
  rcon: RconClient;
  stateDir: string;
  enableBash: boolean;
  dmStore: DmStore;
}

const rconParams = Type.Object({
  command: Type.String({ description: "Command to send (without leading slash)." }),
});

const sayParams = Type.Object({
  message: Type.String({ description: "Text to broadcast to all players in public chat." }),
});

const tellParams = Type.Object({
  player: Type.String({ description: "Target player name." }),
  message: Type.String({ description: "Private message text." }),
});

const readFileParams = Type.Object({
  path: Type.String({ description: "Path relative to your working directory (state/)." }),
});

const writeFileParams = Type.Object({
  path: Type.String({ description: "Path relative to your working directory (state/)." }),
  content: Type.String({ description: "Full file contents to write (overwrites)." }),
});

const listDirParams = Type.Object({
  path: Type.String({ description: "Directory path relative to your working directory (state/). Use '.' for the root." }),
});

const BASH_DEFAULT_TIMEOUT_SECONDS = 60;
const BASH_MAX_TIMEOUT_SECONDS = 600;
const BASH_MAX_BUFFER_BYTES = 5 * 1024 * 1024;

const bashParams = Type.Object({
  command: Type.String({ description: "Shell command to run (executed by /bin/bash)." }),
  timeout_seconds: Type.Optional(
    Type.Number({
      description:
        `Max time to wait before the command is killed. Default ${BASH_DEFAULT_TIMEOUT_SECONDS}s, max ${BASH_MAX_TIMEOUT_SECONDS}s. Long-running commands should be backgrounded (e.g. 'nohup … &').`,
    }),
  ),
});

const readDmsParams = Type.Object({
  player: Type.String({ description: "Player whose private thread to read." }),
  n: Type.Optional(Type.Number({ description: "How many of the most recent messages to return (default 20)." })),
});

const listDmThreadsParams = Type.Object({});

function formatDmThread(player: string, entries: DmEntry[]): string {
  if (entries.length === 0) return `(no DM history with ${player})`;
  return entries
    .map((e) => {
      const who = e.dir === "in" ? player : "you";
      return `[${new Date(e.ts).toISOString()}] ${who}: ${e.message}`;
    })
    .join("\n");
}

export function buildTools(deps: ToolDeps): AgentTool[] {
  const scoped = (p: string): string => {
    const root = resolve(deps.stateDir);
    const target = resolve(root, p);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path "${p}" escapes the working directory`);
    }
    return target;
  };

  const rconTool: AgentTool<typeof rconParams> = {
    name: "rcon",
    label: "Run RCON command",
    description: "Execute a server admin command via RCON. Returns the server's reply text.",
    parameters: rconParams,
    execute: async (_id, params) => {
      const reply = await deps.rcon.send(params.command);
      return { content: [{ type: "text", text: reply || "(no reply)" }], details: { command: params.command, reply } };
    },
  };

  const sayTool: AgentTool<typeof sayParams> = {
    name: "say",
    label: "Broadcast to chat",
    description: "Send a message to all players in public chat (as the server/admin).",
    parameters: sayParams,
    execute: async (_id, params) => {
      const reply = await deps.rcon.send(`say ${params.message}`);
      return { content: [{ type: "text", text: "sent" }], details: { message: params.message, reply } };
    },
  };

  const tellTool: AgentTool<typeof tellParams> = {
    name: "tell",
    label: "Whisper a player",
    description: "Send a private message to a single player in-game. This is your reply channel for DMs — it's appended to that player's private thread.",
    parameters: tellParams,
    execute: async (_id, params) => {
      const reply = await deps.rcon.send(`tell ${params.player} ${params.message}`);
      // Every private message to a player is part of that player's one private thread —
      // there's no clean "DM reply vs. other whisper" distinction, and unifying keeps
      // thread reconstruction unambiguous (see notes/DESIGN.md → Player DMs).
      await deps.dmStore.append({ ts: Date.now(), dir: "out", player: params.player, message: params.message });
      return { content: [{ type: "text", text: "sent" }], details: { player: params.player, message: params.message, reply } };
    },
  };

  const readDmsTool: AgentTool<typeof readDmsParams> = {
    name: "read_dms",
    label: "Read a DM thread",
    description: "Read the most recent private messages exchanged with a player, oldest to newest.",
    parameters: readDmsParams,
    execute: async (_id, params) => {
      const entries = deps.dmStore.readThread(params.player, params.n ?? 20);
      return {
        content: [{ type: "text", text: formatDmThread(params.player, entries) }],
        details: { player: params.player, count: entries.length },
      };
    },
  };

  const listDmThreadsTool: AgentTool<typeof listDmThreadsParams> = {
    name: "list_dm_threads",
    label: "List DM threads",
    description: "List every player you have a private DM thread with, most recently active first, with neutral metadata (message count, last activity, how many they've sent since your last reply, and a preview).",
    parameters: listDmThreadsParams,
    execute: async () => {
      const threads = deps.dmStore.listThreads();
      const text = threads.length === 0
        ? "(no DM threads yet)"
        : threads
            .map((t) =>
              `${t.player} — ${t.messageCount} msgs, last ${new Date(t.lastTs).toISOString()}, ` +
              `${t.sinceLastReply} since your last reply: "${t.preview}"`,
            )
            .join("\n");
      return { content: [{ type: "text", text }], details: { threads } };
    },
  };

  const readFileTool: AgentTool<typeof readFileParams> = {
    name: "read_file",
    label: "Read file",
    description: "Read a file from your working directory (state/).",
    parameters: readFileParams,
    execute: async (_id, params) => {
      const text = await readFile(scoped(params.path), "utf8");
      return { content: [{ type: "text", text }], details: { path: params.path, bytes: text.length } };
    },
  };

  const writeFileTool: AgentTool<typeof writeFileParams> = {
    name: "write_file",
    label: "Write file",
    description: "Write a file in your working directory (state/), creating parent dirs as needed. Overwrites.",
    parameters: writeFileParams,
    execute: async (_id, params) => {
      const target = scoped(params.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, params.content);
      return { content: [{ type: "text", text: `wrote ${params.content.length} bytes` }], details: { path: params.path, bytes: params.content.length } };
    },
  };

  const listDirTool: AgentTool<typeof listDirParams> = {
    name: "list_dir",
    label: "List directory",
    description: "List entries in a directory within your working directory (state/).",
    parameters: listDirParams,
    execute: async (_id, params) => {
      const entries = await readdir(scoped(params.path), { withFileTypes: true });
      const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return { content: [{ type: "text", text: lines.join("\n") || "(empty)" }], details: { path: params.path, entries: lines } };
    },
  };

  const tools: AgentTool[] = [
    rconTool as AgentTool,
    sayTool as AgentTool,
    tellTool as AgentTool,
    readDmsTool as AgentTool,
    listDmThreadsTool as AgentTool,
    readFileTool as AgentTool,
    writeFileTool as AgentTool,
    listDirTool as AgentTool,
  ];

  // Unrestricted shell. Gated until the harness runs in an isolated VM.
  if (deps.enableBash) {
    const bashTool: AgentTool<typeof bashParams> = {
      name: "bash",
      label: "Run shell command",
      description:
        `Execute a shell command on the host via /bin/bash. Returns combined stdout/stderr. Default timeout ${BASH_DEFAULT_TIMEOUT_SECONDS}s (override via timeout_seconds, max ${BASH_MAX_TIMEOUT_SECONDS}s); background long-running work yourself.`,
      parameters: bashParams,
      execute: async (_id, params) => {
        const requested = params.timeout_seconds ?? BASH_DEFAULT_TIMEOUT_SECONDS;
        const timeoutSeconds = Math.max(1, Math.min(BASH_MAX_TIMEOUT_SECONDS, requested));
        const timeoutMs = timeoutSeconds * 1000;
        try {
          const { stdout, stderr } = await execAsync(params.command, {
            maxBuffer: BASH_MAX_BUFFER_BYTES,
            shell: "/bin/bash",
            timeout: timeoutMs,
          });
          const out = [stdout, stderr].filter(Boolean).join("\n");
          return {
            content: [{ type: "text", text: out || "(no output)" }],
            details: { command: params.command, stdout, stderr, timeout_seconds: timeoutSeconds },
          };
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message: string; killed?: boolean; signal?: string; code?: number };
          const timedOut = e.killed === true && e.signal === "SIGTERM";
          const header = timedOut ? `(command killed after ${timeoutSeconds}s timeout)` : undefined;
          const parts = [header, e.stdout, e.stderr, timedOut ? undefined : e.message].filter(Boolean);
          return {
            content: [{ type: "text", text: parts.join("\n") || "(no output)" }],
            details: {
              command: params.command,
              error: e.message,
              timed_out: timedOut,
              exit_code: e.code,
              signal: e.signal,
              timeout_seconds: timeoutSeconds,
            },
          };
        }
      },
    };
    tools.push(bashTool as AgentTool);
  }

  return tools;
}
