import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { createTransformContext } from "./transform-context.js";

const user = (text: string): AgentMessage =>
  ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as unknown as AgentMessage;
const assistant = (text: string): AgentMessage =>
  ({ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }) as unknown as AgentMessage;
const toolResult = (): AgentMessage =>
  ({ role: "toolResult", content: [{ type: "text", text: "ok" }], timestamp: 0 }) as unknown as AgentMessage;

const HUGE = 10_000_000;

describe("transformContext sliding window", () => {
  it("returns everything when under budget", async () => {
    const t = createTransformContext(HUGE);
    const msgs = [user("a"), assistant("b"), user("c")];
    expect(await t(msgs)).toEqual(msgs);
  });

  it("keeps a newest-first suffix and drops the oldest when over budget", async () => {
    const t = createTransformContext(50);
    const msgs = Array.from({ length: 8 }, (_, i) => user("x".repeat(400) + i));
    const out = await t(msgs);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(msgs.length);
    expect(out).toEqual(msgs.slice(msgs.length - out.length)); // a suffix (newest)
  });

  it("never starts the window on a leading assistant turn", async () => {
    const t = createTransformContext(HUGE);
    const out = await t([assistant("thinking"), user("hi"), user("again")]);
    expect(out.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("drops a dangling leading tool result", async () => {
    const t = createTransformContext(HUGE);
    const out = await t([toolResult(), user("hi")]);
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps at least the newest message even if it exceeds budget", async () => {
    const t = createTransformContext(1);
    const huge = user("z".repeat(1000));
    expect(await t([user("a"), huge])).toEqual([huge]);
  });
});
