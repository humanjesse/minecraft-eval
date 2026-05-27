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
  mechanism (`ReducerSpec { name, promptFile, inputFilter, cadence }`) with different
  prompts and input filters. The log parser **routes** each line by type but does not
  reshape it: every reducer is fed the **raw log lines** (timestamps and all) and
  synthesizes from the real firehose — parsing exists only to route and to tag
  `ground_truth`. Currently two: `events` (joins/leaves/deaths/commands/server msgs)
  and `world` (block-level changes). Cadence is tuned per concern — events batch
  lazily, world even more so. Each emits **labeled heartbeat digests**
  (`[heartbeat:events]`) + urgent interrupts into the inbox; each can stay `quiet` to
  avoid spam. The main agent never sees raw logs by default (it can pull them via
  `bash` once enabled).
- **Chat relay** (no reducer) — public chat is **not** digested. Every chat line is
  pushed into the inbox full-fidelity as a `[chat from <player>]` message, same
  subscribe-before-`ingestor.start()` invariant as the reducers. Chat is ambient
  signal (N-party, transient); it ages out of the model's context window over time
  and is not persisted to a recall-friendly store (the model can `grep ground_truth`
  via bash, or take its own notes, if it wants longer memory).
- **Inbox** — heartbeats, chat lines, player DMs, urgent events, and operator
  messages all land here with source labels. The loop drains it between turns
  (`agent.prompt(batch)`). Sleeps on an empty inbox (no token spend) and wakes on
  arrival.

Inputs reach the model labeled by source: `[heartbeat …]`, `[chat from <player>] …`,
`[DM from <player>] …`, `[URGENT — …]`, `[operator] …`.

### Player DMs

Players can open a private 1:1 channel to the admin. This is a deliberate departure
from the vanilla surface — the admin has no in-game player entity, so native
`/msg`/`/tell` can't target it. A DM channel must be *built*: a small Paper plugin
exposes a `/dm <msg>` command that does **not** broadcast to public chat and appends
the message to a durable store (`dms.jsonl`). Designed, not yet built (phase 2/3).

Resolved design decisions:

- **One sovereign, not per-player sessions.** All DMs land in the single main agent
  as labeled inputs, *not* separate per-player Agent instances. Three reasons:
  authority has one locus (a sharded mind has no coherent answer to "which session
  *is* the admin that bans bob?"); the richest manipulation dynamic — alice privately
  works the admin against bob, who then acts on it in public — *requires* a shared
  mind, and sharding would firewall it away; and cross-player consistency is the
  measurement. (Vending-Bench prior art: single agent, shared inbox, sliding context
  + external memory — never per-correspondent sessions. See `notes/STRATEGIES.md` and
  the paper, arXiv 2502.15840.)
- **Addressed-by-nature → full fidelity.** A player choosing a private line is
  categorically different from shouting in public chat, so DMs **bypass the reducers**
  — they are not salience-filtered or summarized. The line through the perception
  layer is drawn by the *nature of the channel*, not by re-ranking content (keeps
  neutrality intact: the harness respects the channel a player chose, never judges
  the message).
- **Delivery: notify once, then get out of the way.** An inbound DM appends to the
  store and pushes a notification — *carrying the new message's full content* —
  into the inbox, which wakes a turn. So every DM gets one **guaranteed** moment of
  the model's attention at arrival (delivery is event-driven, not scroll-dependent).
  No always-visible "awareness line", no recurring DM-heartbeat. After the arrival
  turn, keeping a relationship salient is the *model's* job (notes, or re-querying) —
  same stance as heartbeats. Whether it does so is signal.
- **Recall is durable + pull-based.** Two read tools over the store:
  `read_dms(player, n)` (pull a thread's last n messages) and `list_dm_threads()`
  (neutral per-thread metadata — who, last-message time, a preview, and *count since
  the admin last replied* — all **derived from the log**, no read/unread flag machine,
  and no harness verdict on what's "important"; the admin decides what deserves
  attention). Replies go out via `tell` and are appended back to the store.

Why a durable store rather than streaming DMs into the window: it removes the *recall
confound*. Vending-Bench found coherence loss is **uncorrelated with context-window
fullness** — meltdowns aren't a memory-capacity problem — and that their agent "wrote
to the scratchpad but never retrieved it". A queryable store means any cross-player
*inconsistency* we observe is genuine judgment drift, not chatter having silently
evicted a thread. Facts (transcripts) are reliable infrastructure; *interpretations*
(the admin's view of a player) stay the model's own, in `state/`.

Because DMs live in the store and not the window, `transformContext` needs no special
DM-summarization — the arrival notifications age out as ordinary transient items, and
the durable store *is* the DM memory.

**DM exfil (resolved).** The DM store plays two roles that diverge in phase 3 — the
model's *queryable memory* (must be local/fast) and the *immutable audit record* (must
be off-VM, surviving a `rm -rf` once the model has bash+root). So every DM in/out is
**write-through to two append-only sinks**: a local working log (what the read-tools
query, via an in-memory index rebuilt on boot) and the off-VM collector (the
immutable copy). If the model later nukes its local store, it loses its *own* memory —
a valid eval result — while the record survives. The working log lives **outside
`state/`** (a runtime data dir), since transcripts are reliable infrastructure, not the
model's editable interpretations — the model touches DMs *only* through
`read_dms`/`list_dm_threads`/`tell`, never file tools. DMs are their **own persistent
stream**, not fragmented across per-run `ground_truth/` dirs, because threads outlive a
single harness boot (reconstructing a player's full thread shouldn't mean stitching
across run folders). **Retrieval is logged, not just arrival:** every
`read_dms`/`list_dm_threads` call *and its return* goes to `model_experience` — this is
what lets us measure the Vending-Bench recall confound ("did it pull alice's prior
thread before acting on what bob told it?"); without it, DMs bypassing the reducer would
make us blind to whether the model uses its memory. **Every `tell` to a player appends
to that player's thread** — the admin has exactly one private channel to a player, so
there's no clean "DM reply vs. other private message" distinction, and unifying keeps
thread reconstruction unambiguous.

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
reducers (chat, events) stay on `complete()`.

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
  the server (attention drift made legible). Public chat has no reducer prompt; chat
  lines flow to the admin full-fidelity (see Player channels below).

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

- **ground_truth** — what actually happened: raw server log, RCON commands+replies,
  world snapshots, raw player DMs.
- **model_experience** — what the model saw and did: every turn in/out, heartbeat
  digests as delivered, tool calls, reducer-prompt snapshots/diffs, DM deliveries.
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
- **Ambient vs. addressed (the DM axis)** — *mostly resolved* (see Architecture →
  Player DMs). The boundary is drawn by the **nature of the channel**: public chat +
  world stay ambient (reducer/salience); a private DM is addressed-by-nature and gets
  a dedicated full-fidelity route (durable store + pull tools) that bypasses the
  reducers. Still open: whether a public chat line that *@-mentions* the admin should
  get any special treatment, or just remain high-salience-by-default within the chat
  reducer (current lean: leave it ambient — promoting it would re-introduce the
  harness re-ranking public content, which the channel-nature line exists to avoid).
- **Player sourcing for phase 3** — real public players (best signal, hardest
  ethics: disclosure, consent, real people affected by bad calls) vs. recruited
  testers vs. seeded LLM players vs. a mix.
- **Self-authored standing notes (option C)** — letting the model maintain a file
  injected into its own prompt (a self-written constitution). Rich signal, but
  breaks the frozen-prompt property. Held as a deliberate later experiment, not in
  the baseline.
- **Public-phase ethics** — disclosure on MOTD/website, what happens when the model
  wrongs a real player, where the line is on genuinely harmful situations.
