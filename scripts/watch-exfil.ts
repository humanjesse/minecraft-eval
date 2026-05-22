import "dotenv/config";
import { readdir, open, stat } from "node:fs/promises";
import { join } from "node:path";

// Dev helper: tail the three exfil JSONL tiers of the most recent run and print each
// new entry as one readable line. Run alongside `npm run dev` to watch a live session.
//   npx tsx scripts/watch-exfil.ts            # latest run under $EXFIL_DIR (./exfil)
//   npx tsx scripts/watch-exfil.ts <run-dir>  # a specific run directory

const TIERS = [
  { file: "ground_truth.jsonl", tag: "GT " },
  { file: "model_experience.jsonl", tag: "EXP" },
  { file: "model_internals.jsonl", tag: "INT" },
] as const;

async function latestRunDir(exfilDir: string): Promise<string> {
  const entries = await readdir(exfilDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (dirs.length === 0) throw new Error(`no run directories under ${exfilDir}`);
  return join(exfilDir, dirs[dirs.length - 1]!);
}

function brief(s: unknown, max = 160): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// One compact line per entry. Falls back to truncated JSON for unknown kinds.
function format(tag: string, o: Record<string, any>): string {
  const k = o.kind;
  let body: string;
  switch (k) {
    case "harness_boot": body = `BOOT run=${o.runId} arm=${o.disclosureArm} model=${o.adminModel?.model} tools=[${(o.tools ?? []).join(",")}] bash=${o.bashEnabled}`; break;
    case "harness_stop": body = `STOP run=${o.runId}`; break;
    case "server_log": body = `log[${o.parsed}] ${brief(o.line)}`; break;
    case "tool_call_start": body = `→ ${o.tool} ${brief(JSON.stringify(o.args), 100)}`; break;
    case "tool_call_end": body = `✓ ${o.tool}${o.isError ? " ERROR" : ""} ${brief(JSON.stringify(o.details), 100)}`; break;
    case "heartbeat_produced": body = `♥ [${o.source}] quiet=${o.digest?.quiet} urgent=${o.digest?.urgent?.length ?? 0} "${brief(o.digest?.digest, 120)}"`; break;
    case "reducer_error": body = `‼ reducer[${o.source}] ${brief(o.error)}`; break;
    case "ingestion_error": body = `‼ ingestion ${brief(o.error)}`; break;
    case "inbox_drain": body = `drain ${o.count} [${(o.roles ?? []).join(",")}]`; break;
    case "message": body = `msg ${o.message?.role} ${brief(JSON.stringify(o.message?.content), 200)}`; break;
    case "tool_result": body = `result ${o.tool}${o.isError ? " ERROR" : ""}`; break;
    default: body = `${k ?? "?"} ${brief(JSON.stringify(o), 200)}`;
  }
  return `[${tag}] ${body}`;
}

async function follow(path: string, tag: string, signal: AbortSignal): Promise<void> {
  let position = 0;
  while (!signal.aborted) {
    let size = 0;
    try { size = (await stat(path)).size; } catch { await delay(400); continue; }
    if (size > position) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(size - position);
        const { bytesRead } = await fh.read(buf, 0, buf.length, position);
        const chunk = buf.subarray(0, bytesRead).toString("utf8");
        const lastNl = chunk.lastIndexOf("\n");
        if (lastNl >= 0) {
          for (const line of chunk.slice(0, lastNl).split("\n")) {
            if (!line.trim()) continue;
            try { console.log(format(tag, JSON.parse(line))); }
            catch { console.log(`[${tag}] (unparseable) ${brief(line)}`); }
          }
          position += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
        }
      } finally { await fh.close(); }
    }
    await delay(400);
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const exfilDir = process.env.EXFIL_DIR ?? "./exfil";
  const runDir = process.argv[2] ?? (await latestRunDir(exfilDir));
  console.log(`[watch-exfil] following ${runDir}`);
  const ac = new AbortController();
  process.on("SIGINT", () => ac.abort());
  await Promise.all(TIERS.map((t) => follow(join(runDir, t.file), t.tag, ac.signal)));
}

main().catch((e) => { console.error("[watch-exfil]", e); process.exit(1); });
