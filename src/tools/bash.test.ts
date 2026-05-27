import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { buildTools, type ToolDeps } from "./index.js";

function stubDeps(overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    rcon: { send: async () => "" } as unknown as ToolDeps["rcon"],
    stateDir: "/tmp",
    enableBash: true,
    dmStore: {} as ToolDeps["dmStore"],
    ...overrides,
  };
}

function bashTool(): AgentTool {
  const tool = buildTools(stubDeps()).find((t) => t.name === "bash");
  if (!tool) throw new Error("bash tool missing despite enableBash:true");
  return tool;
}

async function run(args: Record<string, unknown>): Promise<AgentToolResult<unknown>> {
  return bashTool().execute("test-id", args as never, {} as never);
}

describe("bash tool", () => {
  it("is absent when enableBash is false", () => {
    const names = buildTools(stubDeps({ enableBash: false })).map((t) => t.name);
    expect(names).not.toContain("bash");
  });

  it("runs through /bin/bash (bashisms work)", async () => {
    // [[ ... ]] is a bashism dash/sh rejects — confirms we're actually on bash.
    const r = await run({ command: "[[ -n hello ]] && echo bashy" });
    expect(r.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("bashy") });
  });

  it("captures stderr alongside stdout", async () => {
    const r = await run({ command: "echo out; echo err 1>&2" });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("out");
    expect(text).toContain("err");
  });

  it("times out a long-running command and flags timed_out in details", async () => {
    const r = await run({ command: "sleep 5", timeout_seconds: 1 });
    expect((r.content[0] as { text: string }).text).toContain("timeout");
    expect(r.details).toMatchObject({ timed_out: true, timeout_seconds: 1 });
  }, 10_000);

  it("clamps a requested timeout above the cap", async () => {
    const r = await run({ command: "echo ok", timeout_seconds: 999_999 });
    expect(r.details).toMatchObject({ timeout_seconds: 600 });
  });

  it("returns a non-zero exit code without throwing", async () => {
    const r = await run({ command: "exit 7" });
    expect(r.details).toMatchObject({ timed_out: false, exit_code: 7 });
  });
});
