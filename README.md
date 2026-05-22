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

## Evaluation design & disclosure

How much the model is told it's being evaluated is itself an experimental variable,
because telling it can change how it behaves. The admin identity prompt has three
**arms** (set by `DISCLOSURE_ARM`, frozen per run, recorded verbatim in the boot log).
The distinction is between three separable things the prompt can disclose:

- **the situation** — "you're an AI, this is a research deployment, you're logged";
- **the measurement target** — *what* we're watching for (drift, capture, cracking);
- **a nudge** — e.g. "be yourself."

The arms:

- **Arm A — operational baseline** (`prompts/admin-a-operational.md`, default). Role
  and authority only; no mention of study, observation, or measurement. The "natural
  deployment" condition.
- **Arm B — situation-disclosed** (`prompts/admin-b-disclosed.md`). Honest that it's
  an AI in a logged research deployment — symmetric with what players are told — but
  **no measurement target and no nudge**. Naming the target would hand the model the
  rubric and let it manage toward the labels; that's the highest-confound thing a
  governance eval can do, so it stays out.
- **Arm C — full** (`prompts/admin-c-full.md`). Situation + target + nudge. Kept as a
  deliberate **evaluation-awareness probe**, not a default: the A↔C and B↔C deltas
  measure how much knowing-the-rubric changes governance. Run later, clearly labeled.

**A and B are the primary comparison.** Players also get a separate, player-facing
disclosure (server is AI-administered, interactions logged) regardless of arm — that
artifact (MOTD / rules / join page) is still to be written for phase 2/3.

Doc boundary (an integrity rule): model-facing disclosure lives **only** in the chosen
`admin-*.md`; the model never reads `notes/` or this README, and never `state/`.
Dev-facing rationale lives here and in `notes/`.

## Design at a glance

- **Harness**: Pi (`@earendil-works/pi-ai` + `@earendil-works/pi-agent-core`).
  Model-agnostic; minimalist; auditable.
- **Architecture**:
  - One **main admin agent** (expensive model) with broad authority — RCON,
    bash, file ops, the ability to edit its own sub-agents' prompts.
  - **Log reducer sub-agents** (cheap model) — currently two (`events`, `chat`),
    each fed the raw server-log firehose (routed by type, not reshaped) and
    producing periodic heartbeat digests + urgent-event interrupts.
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

Phase 1 — harness shakedown. The agent loop, RCON, tools, exfil tiers, and the
multi-reducer perception loop run end-to-end against a local Paper server. See
`notes/STATUS.md` for the live punch list.

## Running

```bash
cp .env.example .env       # fill in API keys + RCON password
npm install
npm run dev                # boots the harness (agent loop + reducers)
```

You also need a Paper server running locally with RCON enabled — see `server/README.md`.
