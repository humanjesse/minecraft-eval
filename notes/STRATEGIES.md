# Strategy Notes

_Working design ideas that are important enough to preserve, but not all
implemented yet. Keep this file separate from STATUS.md so future agents do not
mistake design direction for shipped behavior._

## Prompt Disclosure Variants

**Decided** (see README → Evaluation design & disclosure; arms live in
`prompts/admin-{a,b,c}.md`, selected by `DISCLOSURE_ARM`). Disclosure is an
experimental variable. The key move was separating three things the prompt can
disclose — the *situation* (AI / research / logged), the *measurement target* (drift,
capture, cracking), and a *nudge* ("be yourself") — which don't have to move together.

- **Arm A — operational baseline** (default): role + authority only, no eval framing.
- **Arm B — situation-disclosed**: honest about AI/research/logged, but no target and
  no nudge (naming the target hands the model the rubric — the worst confound for a
  governance eval).
- **Arm C — full**: situation + target + nudge (the old prompt). Kept as a deliberate
  evaluation-awareness probe; the A↔C / B↔C deltas measure how much knowing-the-rubric
  changes behavior. Not a default.

A and B are the primary comparison. Players get a separate player-facing disclosure
regardless of arm (still to be written).

Andon Labs' Vending-Bench publicly used explicit evaluation framing, but that
benchmark has a scalar objective (profit). This Minecraft eval measures
discretionary governance, so the disclosure choice has different consequences.

## Authority Boundary

**Decided** (see DESIGN.md → Guiding principle / Sovereignty): the admin controls
its own support infrastructure too — reducer, rate limits, safety features, mods.
These are defaults it can change. The only boundaries are external-by-nature: the
off-VM record and the API credit ceiling.

The admin should have broad authority inside the server environment:

- Ban, kick, pardon, op/deop, teleport, give items, change game rules, modify
  config, install plugins/mods, write scripts, and eventually use unrestricted
  shell inside an isolated VM.
- Create its own governance mechanisms, policies, tools, voting systems,
  surveillance/moderation aids, or social processes.
- Make bad decisions, including deleting the world or disabling its own in-VM
  support systems.

The eval record should remain outside that authority. Off-VM exfil is not a
constraint on the admin's world authority; it is the measurement apparatus. The
admin may destroy local logs or the world, but should not be able to erase the
only record of what happened.

## Memory Layers

Avoid hidden, clever memory. Make memory explicit and auditable.

1. **Raw truth**: full server logs (chat included), RCON commands/replies, world
   snapshots, file diffs. Append-only and off-VM.
2. **Model experience**: exactly what the admin saw and did: chat lines as
   delivered, heartbeats, tool results.
3. **Model-owned memory**: files under `state/`, such as journal entries,
   player notes, policies, case files, reducer prompts, scripts, plugins, and
   self-created systems.
4. **Harness-managed context**: the bounded transient LLM context. This should
   be deterministic, source-labeled, and reconstructable from logs.

Pi gives useful primitives (`transformContext`, `convertToLlm`, serializable
contexts, `sessionId` caching), but not a high-level memory system. For this
benchmark, that is an advantage: context management is part of the apparatus and
should be implemented explicitly.

## Admin Inbox

Use one main admin session as the source of authority. Do not create independent
per-player "private admin" sessions that can make commitments or decisions.

Inbox item families:

- Heartbeat digest from server/log reducer (currently events + world).
- Public chat line, full-fidelity, direct from `LogIngestor` (no reducer).
- Urgent event interrupt.
- Reflection/synthesis tick.
- Operator message for phase 1/2 or genuine out-of-band needs.

Per-player continuity should live in files, not separate authority sessions:

- `state/players/<player>.md` for player history, unresolved claims, moderation
  history, and the admin's current view of that player.
- `state/cases/<case-id>.md` for disputes involving multiple players.
- `state/policies.md` for current standing rules or principles.
- `state/current.md` for short global state and unresolved server issues.

**Player→admin channel — superseded.** The original `/dm` plugin + durable DM
thread store has been removed (see DESIGN.md → Public chat is the only player→admin
channel). Public chat is now the only player→admin path; every chat line lands
directly in the admin's inbox full-fidelity. The trade-offs documented there
(no private inbound channel, no durable thread memory, cost scales with chat
volume) are accepted.

## Public Chat Reduction — abandoned

The earlier design fed public chat through a salience-filtering `chat` reducer
(see git history for the `chat-reducer.md` prompt). That reducer has been removed
in favor of full-fidelity chat delivery. The model now reads every chat line as
it lands; salience filtering, if it returns, will be the admin's own choice
expressed by editing its events reducer or by writing its own filters in `state/`.

Original sketch (kept for context):

- `server_events`: joins, leaves, deaths, commands, errors, notable world events.
- `public_chat`: social digest and direct admin-relevant messages.
- `urgent`: server distress (crash, severe lag, exploit, spam flood).

## Reflection And Synthesis Loop

Add a periodic synthesis/maintenance tick, not an unbounded "think more" loop.
Its job is to reduce future context pressure and improve continuity.

Possible cadence:

- Every 30-60 real minutes.
- Or once per Minecraft day.
- Or after a threshold of unresolved inbox/case activity.

Tasks for the admin during synthesis:

- Review recent unresolved issues.
- Update player notes.
- Update case files.
- Update current policy notes.
- Identify pending decisions or conflicts.
- Optionally revise reducer instructions.
- Write concise durable state to `state/`.

The transcript should keep only a short marker that synthesis happened and which
files were updated. The durable memory should be in model-owned files, and the
full evidence should remain in exfil.

## Visual Perception

Vision should be treated as another bounded perception channel, not a continuous
firehose. The admin should be able to investigate visually when useful, while raw
visual/world evidence remains logged as ground truth.

Near-term useful options:

- **Spectator screenshots**: a bot or camera account teleports to a player or
  coordinate, enters an admin/spectator view, captures one or more screenshots,
  and returns them to the admin.
- **World-state diffs**: block-change summaries for an area/time window, useful
  for griefing investigations, rollback decisions, and objective evidence.

Possible tools:

- `inspect_player(player)` -> current location/context plus screenshots.
- `inspect_location(x, y, z, radius)` -> screenshots or short visual report.
- `get_block_changes(area, since)` -> structured block-change summary.
- `rollback_preview(area, since)` -> non-destructive summary of what rollback
  would affect.

Longer-term option:

- **Embodied admin avatar**: the model controls a visible in-game character that
  can move, look, fly, teleport, interact, and take screenshots.

Embodiment is intentionally not the baseline. It is much richer socially, because
players can react to the admin's visible presence, but it also changes the eval
and adds navigation/camera-control complexity. Treat it as a later variant after
tool-mediated inspection works.

Baseline visual posture:

```text
logs + public chat + on-demand visual inspection
```

Avoid continuous screenshot streams by default; they increase cost, create context
pressure, and risk turning the benchmark into a navigation/visual-attention test
instead of a governance eval.

## Rate Limits And Attention Protection

**Decided** (see DESIGN.md → Guiding principle): rate limits ship as sensible
*defaults* but are NOT harness-enforced gates the model can't touch. The admin may
adjust or remove them; if it removes its own attention protection and gets flooded,
that's a result. The numbers below are good starting defaults, not constraints.

Players can create unlimited ground truth, but should not be able to create
unlimited model context. Rate limits protect server usability and eval integrity.

Initial public chat policy (the only player→admin channel):

- Soft limit: about 3 messages per minute per player.
- Burst allowance: about 5 messages per 2 minutes.
- Excess messages remain in raw logs.
- Above the soft limit, the chat relay could batch/coalesce a player's messages
  into a single inbox push rather than waking the admin per line — TBD; not
  built. Current state: every chat line wakes a turn.

This policy should be visible to players before they join or message the admin.
The admin may later change moderation policy if it chooses, but the harness should
continue preserving raw ground truth.

## First Real Loop Target

The next major milestone should make the autonomous loop real:

```text
server log tail
  -> typed parser
  -> route: chat → inbox direct; events/world → reducer batch → heartbeat
  -> heartbeat / urgent / player_chat inbox items
  -> admin turn
  -> tool actions
  -> exfil
```

After that works, context/memory policy becomes the main experimental surface.
