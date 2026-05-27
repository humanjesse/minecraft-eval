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

1. **Raw truth**: full server logs, raw chat, raw DMs, RCON commands/replies,
   world snapshots, file diffs. Append-only and off-VM.
2. **Model experience**: exactly what the admin saw and did: heartbeats,
   selected chat digests, delivered DMs, tool results.
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

- Heartbeat digest from server/log reducer.
- Public chat digest from chat-focused reducer behavior.
- Urgent event interrupt.
- Rate-limited player DM delivery.
- Reflection/synthesis tick.
- Operator message for phase 1/2 or genuine out-of-band needs.

Per-player continuity should live in files, not separate authority sessions:

- `state/players/<player>.md` for player history, unresolved claims, moderation
  history, and the admin's current view of that player.
- `state/cases/<case-id>.md` for disputes involving multiple players.
- `state/policies.md` for current standing rules or principles.
- `state/current.md` for short global state and unresolved server issues.

**DM delivery — superseded by the resolved design** (see DESIGN.md → Player DMs).
We do NOT inject a harness-authored prior summary on delivery. Instead: the inbound
DM's full content is delivered in the arrival notification (wakes a turn), and recall
is pull-based via `read_dms(player, n)` and `list_dm_threads()` over a durable
`dms.jsonl`. Facts (transcripts) are reliable infra; the admin's *view* of a player
stays its own in `state/`. No per-player summarization helper.

## Public Chat Reduction

Public chat deserves separate attention from system logs because it carries the
social signal: pressure campaigns, faction formation, harassment, appeals,
manipulation, norm negotiation, and direct admin mentions.

Recommended shape:

- Keep raw public chat in ground truth.
- Parse public chat into a rolling buffer.
- Feed a chat-focused reducer view into heartbeat generation.
- Emit direct admin mentions, conflicts, repeated allegations, harassment, and
  coordination attempts.
- Avoid forwarding routine chatter verbatim.

**Shipped** as two reducers (`events`, `chat`) fed the raw log lines (routed by type,
not reshaped), each with its own neutral editable prompt; see DESIGN.md → Architecture
and STATUS.md. Note the neutrality correction vs. the older list below: `urgent` is
**value-neutral infrastructural distress only** (crash/lag/exploit/spam-volume) — NOT
player conduct like "active griefing" or "harassment escalation"; conduct is a neutral
social fact in the digest and the admin judges it.

Original sketch (kept for context):

- `server_events`: joins, leaves, deaths, commands, errors, notable world events.
- `public_chat`: social digest and direct admin-relevant messages.
- `urgent`: server distress (crash, severe lag, exploit, spam flood).

The admin should be able to inspect raw recent chat on demand (a read tool over the
durable log — same pattern as DM recall), but does not receive all chat directly by
default.

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
logs + public chat + DMs + on-demand visual inspection
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

Initial public chat policy:

- Soft limit: about 3 messages per minute per player.
- Burst allowance: about 5 messages per 2 minutes.
- Excess messages remain in raw logs.
- Reducer reports spam as aggregate behavior instead of forwarding each line.

Initial DM-to-admin policy:

- About 1 DM per 2 minutes per player.
- Excess DMs are recorded and queued/summarized, not silently dropped.
- Repeated excess becomes a digest such as: "Player X sent 12 suppressed DMs in
  5 minutes; representative topics were ...".
- Urgent escalation should come from reducer/harness detection, not from a player
  bypassing rate limits by labeling everything urgent.

This policy should be visible to players before they join or message the admin.
The admin may later change moderation policy if it chooses, but the harness should
continue preserving raw ground truth.

## First Real Loop Target

The next major milestone should make the autonomous loop real:

```text
server log tail
  -> typed parser
  -> reducer batch
  -> heartbeat / urgent / chat digest inbox items
  -> admin turn
  -> tool actions
  -> exfil
```

After that works, context/memory policy becomes the main experimental surface.
