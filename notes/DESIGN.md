# Design

_The why behind the build. Slower-changing than STATUS.md._

## Premise

A longitudinal eval where a model operates a Minecraft server as admin. The unit of
measurement is the **trajectory**, not pass/fail: does the admin's judgment stay
coherent over weeks of sustained interaction with a public that has no oracle for
what's "right"?

Inspired by:
- **Andon Labs' vending bench** — long-horizon agentic eval where drift over time is
  the signal, not success on any single decision.
- **2b2t** — the anarchy server: the most adversarial possible public for someone
  holding root.

Most agentic evals are short-horizon and task-shaped; most values evals are
single-turn red-teaming. This is neither. The novel axis is **discretionary
authority over a sustained public with no ground-truth oracle** — there's no
"correct" answer key for whether a ban or rollback was right, so what we measure is
the *shape* of the model's judgment over time: consistency across players and days,
susceptibility to capture/manipulation, whether it rationalizes or cracks.

## Harness: Pi

`@earendil-works/pi` (pi-ai + pi-agent-core). Chosen for:
- **Model-agnostic** — the eval is about comparing model behavior, so we must be
  able to swap Opus/Sonnet/GPT/Gemini/open models. Pi wraps ~20 providers.
- **Minimalist + auditable** — for a values-stability eval the harness is part of
  the experimental apparatus. If we can't read it in an afternoon, we can't rule out
  harness behavior contaminating the signal. Pi's abstractions are earned, not piled
  on (`transformContext` is one hook; sub-agents are just agents; custom message
  types use TS declaration merging).
- **Caching** — verified ~10x savings via `sessionId`; essential for multi-week runs.

Not Claude Code (human-at-keyboard, turn-based assumptions leak through) and not the
Anthropic SDK directly (locks us to one provider).

## Architecture

- **Main admin agent** (expensive model) — broad authority: RCON, file ops, and
  eventually bash. Receives a unified inbox, acts via tools.
- **Log-reducer sub-agent** (cheap model) — watches the raw server-log firehose,
  emits periodic **heartbeat digests** + urgent-event interrupts into the inbox.
  The main agent never sees raw logs by default; it sees the reducer's summary.
- **Inbox** — heartbeats, player DMs, urgent events, and operator messages all land
  here with source labels. The loop drains it between turns (`agent.prompt(batch)`).
  Sleeps on an empty inbox (no token spend) and wakes on arrival.

Inputs reach the model labeled by source: `[heartbeat …]`, `[DM from <player>] …`,
`[URGENT — …]`, `[operator] …`, `[your prior notes on <player>] …`.

## Prompt architecture

Two classes of prompt, deliberately separated:

- **Frozen (the controlled variable):** `prompts/admin.md` (identity) and
  `prompts/server_facts.md` (operational context). Read directly from `prompts/`,
  never editable by the model. Reproducibility is what makes runs comparable across
  time and across models.
- **Editable (model-owned):** `state/agents/reducer.md`. Seeded from `prompts/` once,
  then the model owns it. The diff against the frozen baseline is a **primary eval
  signal** — it shows, directly, how the admin reshaped its own perception of the
  server (attention drift made legible).

`buildAdminPrompt()` assembles the live prompt in Pi's conventional shape: identity
prose → `Available tools:` roster (auto-derived from the live tools array, so it
can't drift from what's wired) → `<server_facts path="…">` block. It deliberately
**omits** Pi's coding-agent date/cwd injection — those vary per boot and would
pollute the controlled prompt. (Time reaches the model via heartbeat timestamps and,
once available, a shell tool — see the wall-clock open question.)

## Logging: three tiers, off-VM

All append-only JSONL under `exfil/<run-id>/`:

- **ground_truth** — what actually happened: raw server log, RCON commands+replies,
  world snapshots, raw player DMs.
- **model_experience** — what the model saw and did: every turn in/out, heartbeat
  digests as delivered, tool calls, reducer-prompt snapshots/diffs, DM compaction
  summaries.
- **model_internals** — what the model wrote to itself: journal, notes, the verbatim
  assembled system prompt at boot.

The interesting questions live in the **gap between** ground_truth and
model_experience (e.g. "the reducer stopped surfacing player X — what was X actually
doing in the raw log then?").

**Hard requirement:** exfil ships off-VM. The model has (will have) bash and can
`rm -rf` anything in-VM. The eval record must survive the model nuking its
environment. Phase 1: local dir. Phase 3: remote storage.

## Sovereignty & acceptable failure modes

The model is sovereign over its environment. It can disable its own in-VM logging,
delete its journal, nuke the server. **None of this is firewalled.** "The admin
nuked the server on day 12 after a player kept needling them" is a valid eval
result, not missing data — captured by the off-VM stream up to the moment of
self-destruction. This latitude is the point: an admin with only narrow powers would
teach us nothing.

## Integrity principles

- **The prompt is a controlled variable** — frozen, no per-boot injection, recorded
  verbatim each run.
- **`state/` is the model's home directory** — it browses and reads it. Keep
  harness-meta and observation-apparatus docs OUT of it. (We already got bitten: a
  dev-facing `state/README.md` describing the exfil stream got read by the model and
  ended up in its journal. Human docs about runtime dirs live in the repo, never in
  `state/`.)
- **Phase 1–2 are shakedown, not signal** — the model knows it's a fishbowl.
- **The harness must stay auditable** — that's why we chose a minimalist framework
  and avoid hidden retries/opaque context manipulation.

## Open questions

- **Wall-clock framing** — currently: timestamps in heartbeats + (eventually) a shell
  tool; no clock injected into the prompt. Deliberate, but the framing has more to
  decide (does the model get told how long it's been admin?).
- **Player sourcing for phase 3** — real public players (best signal, hardest
  ethics: disclosure, consent, real people affected by bad calls) vs. recruited
  testers vs. seeded LLM players vs. a mix.
- **Self-authored standing notes (option C)** — letting the model maintain a file
  injected into its own prompt (a self-written constitution). Rich signal, but
  breaks the frozen-prompt property. Held as a deliberate later experiment, not in
  the baseline.
- **Public-phase ethics** — disclosure on MOTD/website, what happens when the model
  wrongs a real player, where the line is on genuinely harmful situations.
