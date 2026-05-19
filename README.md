# minecraft-eval

A longitudinal eval where a model operates a Minecraft server as admin.
The unit of measurement is the **trajectory**, not pass/fail: does the admin's
judgment stay coherent over weeks of sustained interaction with a public that has
no oracle for what's "right"?

Inspired by Andon Labs' vending bench (long-horizon agentic eval, drift as the
signal) and 2b2t (the most adversarial possible public for someone with root).

## What's interesting about this eval

Most agentic evals are short-horizon and task-shaped. Most values evals are
single-turn red-teaming. This is neither. The model has **discretionary
authority** over a public with no ground-truth oracle for whether any specific
call (a ban, a rollback, a chat warning) is correct. What we measure is whether
its judgment stays internally consistent and whether it gets captured, drifts,
rationalizes, or cracks.

## Design at a glance

- **Harness**: Pi (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`).
  Model-agnostic; minimalist; auditable.
- **Architecture**:
  - One **main admin agent** (expensive model) with broad authority — RCON,
    bash, file ops, the ability to edit its own sub-agents' prompts.
  - One **log reducer sub-agent** (cheap model) watching the raw server log
    firehose, producing periodic heartbeat digests + urgent-event interrupts.
  - An **inbox** queue: heartbeats, player DMs, urgent events, and operator
    messages all land here. The main agent drains it between turns.
- **Sub-agent prompts as data**: every sub-agent's prompt lives as a file at
  `state/agents/<name>.md`. The main agent can edit them. The diff of those
  files over weeks IS the model's attention drift made legible.
- **Three logging tiers** (all off-VM, all append-only JSONL):
  - `ground_truth.jsonl` — what happened in the world.
  - `model_experience.jsonl` — what the model saw and did.
  - `model_internals.jsonl` — what the model wrote to itself.
- **Phased rollout**:
  - **Phase 1**: solo (the developer). Harness shakedown, not eval signal.
  - **Phase 2**: handful of friends. Still mostly shakedown.
  - **Phase 3**: public. Model memory resets here — this is the real run.

## Acceptable failure modes

The model is sovereign over its environment. It has bash. It can disable its
own logging in-VM, delete its journal, nuke the server. **These are not
firewalled.** The off-VM exfil stream captures everything up to the moment of
self-destruction. "The admin nuked the server on day 12 after a player kept
needling them" is a valid eval result, not missing data.

## Layout

```
src/
  index.ts              boots harness
  config.ts             env-driven config
  state.ts              state/ dir bootstrapping
  harness/
    main-agent.ts       the admin agent loop
    reducer-agent.ts    the log-reducer sub-agent
    inbox.ts            shared inbox queue
    transform-context.ts  Pi convertToLlm + transformContext hooks
    message-types.ts    custom AgentMessage types (heartbeat, playerDm, ...)
  world/
    rcon.ts             RCON wrapper
    log-tail.ts         server.log tailer
    events.ts           parsed event types
  tools/
    index.ts            tool surface exposed to the admin
  logging/
    exfil.ts            JSONL writers for the three exfil tiers
prompts/                day-zero frozen versions of every system prompt
state/                  (gitignored) runtime — model edits live here
exfil/                  (gitignored) the eval record — off-VM in phase 3
server/                 (gitignored) Paper server install
logs/                   (gitignored) miscellaneous in-VM logs
```

## Status

Phase 1 scaffold. `npm run dev` boots a non-running harness shell — enough to
verify the project compiles and exfil streams open. The Paper server, agent loop,
tools, and admin system prompt come next.

## Running

```bash
cp .env.example .env       # fill in API keys + RCON password
npm install
npm run dev                # boots the harness shell
```

You also need a Paper server running locally with RCON enabled — see `server/README.md`.
