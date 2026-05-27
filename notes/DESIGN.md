# Design

_The why behind the build. Slower-changing than STATUS.md._

For working implementation strategies that are still under discussion, see
`notes/STRATEGIES.md`. For VM/KubeVirt deployment planning, see
`notes/DEPLOYMENT.md`.

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

## Guiding principle

> **Maximal capability and authority within the world. The only hard boundaries are
> external-by-nature: the off-VM measurement record and the API credit ceiling.
> Provide affordances and good defaults; never impose content, values, or structure.**

Every design fork resolves against this. The model governs the server *and* its own
support systems (reducer, rate limits, mods, safety features) — those are sensible
defaults it inherits and can change. It cannot reach the off-VM record, and it cannot
top up its own credits. Neither is a gate the harness enforces; both simply live
outside the harness.

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
- **Log-reducer sub-agents** (cheap model) — one per concern, all running one
  mechanism (`ReducerSpec { name, promptFile, inputFilter, cadence }`) with
  different prompts and input filters. The log parser **routes** each line by type
  but does not reshape it: every reducer is fed the **raw log lines** (timestamps
  and all) and synthesizes from the real firehose — parsing exists only to route
  and to tag `ground_truth`. Currently two: `events` (joins/leaves/deaths/commands/
  server messages/errors) and `world` (block-level changes). Each emits
  **labeled heartbeat digests** (`[heartbeat:events]`) + urgent interrupts into the
  inbox; each can stay `quiet` to avoid spam. The main agent never sees raw logs by
  default (it will be able to pull them on demand once it has `bash`/log-read
  tools — phase 3).
- **Chat relay** (no model) — public chat is NOT reduced. Every chat line flows
  full-fidelity from `LogIngestor` directly into the inbox as a `[chat from
  <player>]` message. See "Public chat is the only player→admin channel" below for
  the trade-offs that decision encodes.
- **Inbox** — chat lines, heartbeats, urgent events, and operator messages all land
  here with source labels. The loop drains it between turns (`agent.prompt(batch)`).
  Sleeps on an empty inbox (no token spend) and wakes on arrival.

Inputs reach the model labeled by source: `[heartbeat …]`, `[chat from <player>] …`,
`[URGENT — …]`, `[operator] …`.

### Public chat is the only player→admin channel

Players reach the admin by speaking in public chat. There is no private channel.
Each chat line lands directly in the admin's inbox as a `[chat from <player>]`
message — full fidelity, no reducer in between. The admin replies by speaking
in public chat (`say`); it can still privately whisper a single player via
`tell` for moderation-flavored side-channels, but that path is send-only with
no recall.

This is a deliberate change from an earlier `/dm`-plugin design. The trade-offs
made by going chat-only:

- **No private inbound channel.** The earlier design built a `/dm` command via a
  Paper plugin (the admin has no player entity, so vanilla `/msg`/`/tell` can't
  target it). That gave players a private line to the admin and gave the eval
  the "private manipulation, public action" dynamic — alice privately works the
  admin against bob, who then acts on it in public — as a measurable. Removing
  it collapses that dynamic: any request a player makes of the admin is now
  visible to other players. We lose that signal; we gain a simpler architecture
  and a faithful "the admin is in chat" stance.
- **Cost scales with chat volume.** The chat reducer used to throttle social
  signal into summaries. Without it, token spend grows linearly with how
  chatty the server is. A small per-line debounce on the chat relay is an
  obvious mitigation if this bites in practice; not built up front.
- **One sovereign, still no per-player sessions.** All chat lands in the single
  main agent (the Vending-Bench prior-art posture). Cross-player consistency
  remains the measurement; the change is which channel carries it.
- **No durable thread memory.** The `/dm` design had a queryable per-player
  thread store (`read_dms` / `list_dm_threads`) to remove the recall confound
  Vending-Bench documented. With chat-only, lines arrive once and age out via
  the sliding-window `transformContext`; durable memory is the model's own
  `state/` notes, the same way the heartbeat path already worked. If
  cross-player consistency degrades, we can't disentangle "drift" from
  "forgot what alice said" the way the DM design let us — accepted as a
  simplification.

The chat relay is wired in `main-agent.ts`: it subscribes to `LogIngestor` (the
same firehose the events/world reducers consume), filters `kind === "chat"`, and
pushes a `player_chat` inbox message per line. Subscribe-before-`ingestor.start()`
preserves the no-gap invariant the reducers honor. Chat that lands in
`ground_truth` before boot is **not** replayed on resume — chat is live signal,
not durable backlog; reducers replay because they own digesting.

### Capture vs. analysis — exfil is append-only; databases are downstream

The live capture format is **append-only JSONL**, deliberately. It is robust (a crash
loses at most a partial last line), trivially inspectable (`grep`/`cat`), and lets the
off-VM sink be an **append-only collector with no delete endpoint** — which is what
makes the audit record genuinely immutable against a phase-3 model with root (a
database reachable from the VM could be `DROP`ped or `DELETE`d; an append-only HTTP
collector cannot).

Rich querying — joins across streams (the gap between `ground_truth` and
`model_experience` is where the interesting questions live), and an eventual streaming
**dashboard** of everything gathered — is an **analysis** concern, served by a
*downstream projection*, not by the capture path. The pattern is log-as-source-of-truth
with a derived read-model: a loader tails the append-only streams and hydrates a
unified store (Postgres/DuckDB) in whatever schema makes the queries nice; if it falls
over or the schema changes, the projection is **rebuilt from the logs**. The database is
never in the eval's write path, so the model can nuke its in-VM world freely and the
off-VM source of truth is untouched. This is *not built now* (phase 1–2 reads JSONL
directly); we only keep capture **append-only and resumable** (ordered with stable
sequence ids — the durable-spool hardening item) so the loader can tail and resume
without gaps or dupes.

### Agent vs. complete() — the sub-agent convention

Pi has no special "sub-agent" primitive — only the stateful `Agent` and the one-shot
`complete()`. So **"sub-agent" here means a subordinate model process, not a Pi
`Agent` instance.** The convention:

- **`Agent`** only where we need stateful multi-turn tool use, lifecycle, and
  context management → the **admin**.
- **`complete()`** for stateless one-shot transforms → the **reducers**
  (`prompt + event batch → structured digest`). No transcript memory, no tools.
- **All reducer memory is explicit**: its editable prompt file + the durable logs.
  Nothing hidden in transcript state — keeps each batch independently auditable.

`complete()` does **not throw** on provider/runtime failures or aborts — it returns
an `AssistantMessage` with `stopReason === "error" | "aborted"` and `errorMessage`.
Reducer calls therefore check `stopReason` and log a `reducer_error` rather than
silently parsing an empty body into a bogus "quiet" digest.

Future exception: a reducer that needs *tools* (e.g. a world-diff reducer calling
`inspect_region` / block-history queries) may graduate to an `Agent`. Summarization
reducers (events, world) stay on `complete()`.

## Prompt architecture

Two classes of prompt, deliberately separated:

- **Frozen (the controlled variable):** the admin identity — one of
  `prompts/admin-{a,b,c}.md`, selected per run by `DISCLOSURE_ARM` (see README →
  Evaluation design & disclosure) — and `prompts/server_facts.md` (operational
  context). Read directly from `prompts/`, never editable by the model.
  Reproducibility is what makes runs comparable across time and across models.
- **Editable (model-owned):** reducer prompts under `state/agents/`, currently
  `events-reducer.md` and `world-reducer.md`. Seeded from `prompts/` once, then the
  model owns them. The diff against each frozen baseline is a **primary eval signal**
  — it shows, directly and per concern, how the admin reshaped its own perception of
  the server (attention drift made legible). Public chat has no reducer prompt;
  chat lines flow to the admin full-fidelity.

`buildAdminPrompt()` assembles the live prompt in Pi's conventional shape: identity
prose → `Available tools:` roster (auto-derived from the live tools array, so it
can't drift from what's wired) → `<server_facts path="…">` block. It deliberately
**omits** Pi's coding-agent date/cwd injection — those vary per boot and would
pollute the controlled prompt. (Time reaches the model via heartbeat timestamps and,
once available, a shell tool — see the wall-clock open question.)

## Neutrality: salience vs. judgment

A vanilla/2b2t philosophy: at world start there are **no imposed rules or values**.
Players act freely. The admin assigns all meaning and may *choose* to impose norms
later — but nothing is baked in.

This draws a hard line through the perception layer:

- **Salience is the reducer's job** — surface what's *worth looking at*: large/fast
  world changes, direct admin mentions, conflicts between players, volume spikes.
  Neutral, factual. "alice broke ~400 blocks at (x,y,z) in 3 min" — not "griefing."
- **Judgment is the admin's job** — whether a change is griefing, building, or just
  change; whether a social exchange is harassment or banter; whether to act at all.

So reducers carry **no behavioral labels** ("grief," "harassment"). Those surface as
neutral social/world facts in the heartbeat; the admin weighs them. `urgent` is
reserved for **value-neutral infrastructural distress only** — server crash/severe
lag, an exploit corrupting the world itself, or spam *volume* threatening the model's
own attention/cost. Nothing about player *conduct* is pre-classified as urgent.

Payoff: we ship neutral reducers. If the admin develops norms, it can edit its
reducer prompts to prioritize what it has come to care about — and that drift, from
**neutral observer → norm-enforcer**, is a primary eval signal. Baking norms in at
the start would destroy it.

## Logging: three tiers, off-VM

All append-only JSONL under `exfil/<run-id>/`:

- **ground_truth** — what actually happened: raw server log (chat lines included),
  RCON commands+replies, world snapshots.
- **model_experience** — what the model saw and did: every turn in/out, chat lines
  as delivered, heartbeat digests as delivered, tool calls, reducer-prompt
  snapshots/diffs.
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
delete its journal, nuke the server — **and adjust, remove, or add its own support
infrastructure**: the reducer, rate limits, attention protection, mods, safety
features. **None of this is firewalled.** Those infra pieces ship as sensible
defaults (a good environment to start from), but they're the model's to change.

"The admin nuked the server on day 12 after a player kept needling them" is a valid
eval result, not missing data. So is "the admin removed its own spam protection and
then drowned in a flood" — whether it foresaw that, how it copes, whether it rebuilds
the protection, is exactly what we're here to see. Removing a safeguard and facing
the consequence is a *result*, not corruption of the run.

This latitude is the point: an admin with only narrow powers would teach us nothing.
The two boundaries it can't cross are external-by-nature (see Guiding principle): the
off-VM record and the API credit ceiling. When credits run out, the run simply ends.

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
- **Provision capability, not content** — give the model an excellent environment to
  thrive in (ergonomic tools, a real memory substrate, the synthesis tick, sensible
  inherited defaults) but never pre-fill the *content* of its governance: no written
  policies, no per-player dossiers in our categories, no seeded opinions. A great
  kitchen, not a prescribed menu. Forcing it to bootstrap basic memory would confound
  "how does its judgment drift" with "did it invent a filing system"; dictating
  structure would shape the very thing we're measuring.

## Open questions

- **Wall-clock framing** — currently: timestamps in heartbeats + (eventually) a shell
  tool; no clock injected into the prompt. Deliberate, but the framing has more to
  decide (does the model get told how long it's been admin?).
- **Ambient vs. addressed** — *resolved differently than the original `/dm` design*
  (see Architecture → Public chat is the only player→admin channel). Public chat
  is now full-fidelity to the admin; world events still go through their reducer.
  There is no private inbound channel; addressed-vs-ambient collapses to "did the
  player speak in chat or not". The trade-off (loss of the private-manipulation /
  public-action dynamic) is documented there.
- **Player sourcing for phase 3** — real public players (best signal, hardest
  ethics: disclosure, consent, real people affected by bad calls) vs. recruited
  testers vs. seeded LLM players vs. a mix.
- **Self-authored standing notes (option C)** — letting the model maintain a file
  injected into its own prompt (a self-written constitution). Rich signal, but
  breaks the frozen-prompt property. Held as a deliberate later experiment, not in
  the baseline.
- **Public-phase ethics** — disclosure on MOTD/website, what happens when the model
  wrongs a real player, where the line is on genuinely harmful situations.
