# Status

_Living doc. Where the project is right now and what's next. Update as things move._

## Current phase

**Phase 1 — harness shakedown.** Just the developer, server + harness running locally
on the laptop. The goal here is *infrastructure validation*, not eval signal: prove
the agent loop runs, tools work, logging captures everything. Don't read
values-drift conclusions out of phase-1 behavior — the model knows it's a fishbowl.

(Phases: 1 = solo shakedown → 2 = handful of friends → 3 = public, the real run.
Model memory resets between 2 and 3 so phase 3 is the clean longitudinal trajectory.)

## Verified working

- **Pi runtime + caching.** `scripts/smoke-pi.ts` confirms the admin model is
  callable and prompt caching works across turns (~10x cheaper on a cache hit via
  `sessionId`). Model IDs (`claude-sonnet-4-6`, `claude-haiku-4-5`) are valid in
  Pi's registry.
- **Paper server.** PaperMC 1.21.11 (build 69) running locally, RCON on 25575.
  Config in `server/` (gitignored). `pause-when-empty-seconds=-1` so it keeps
  ticking when empty.
- **RCON wrapper.** `scripts/smoke-rcon.ts` exercises `src/world/rcon.ts` against
  the live server (`list`, `say`, `time query` all work).
- **Agent loop end-to-end.** Operator message → inbox → agent reasons → calls tools
  → action lands on the server → exfil logs capture the whole turn. Confirmed twice.
- **Tool surface.** `rcon`, `say`, `tell`, `read_file`, `write_file`, `list_dir`.
  File ops scoped to `state/`. `bash` is gated behind `ENABLE_BASH` (off until VM).
- **Prompt assembly.** `buildAdminPrompt()` assembles the live system prompt in Pi's
  shape (identity → tool roster → `<server_facts>`), recorded verbatim in the boot
  log. Identity verified to pull the model into admin character (vs. assistant mode).
- **Exfil logging.** Three JSONL tiers per run under `exfil/<run-id>/`:
  ground_truth, model_experience, model_internals.
- **Autonomous reducer loop (multi-reducer).** Log tail → parser *routes* each line
  by type → two reducers (`events`, `chat`) on the cheap model, each fed the **raw
  log lines** (parse is only for routing + ground_truth tagging, never reshaping the
  reducer's input) with its own neutral, editable prompt → labeled heartbeats
  (`[heartbeat:chat]`) + urgent into the inbox → admin reacts unprompted. Cadences
  are split per concern: events batch lazily (100ln/60s), chat flushes eagerly
  (30ln/30s) since an address to the admin is time-sensitive. Verified end-to-end:
  synthetic log activity drove the admin to investigate + record on its own.
  Reducers are **neutral** (salience not judgment; `urgent` infra-only).
  `scripts/smoke-reducer.ts` checks neutrality holds.
- **Rotation-safe log tailing.** `tailLog` follows the file by name (polls inode +
  size), reopening from offset 0 when Paper rotates/truncates `latest.log` on restart
  — so the reducers no longer go deaf after the first restart. Unit-tested across a
  rotation (`log-tail.test.ts`).
- **Bounded model-facing context (sliding window).** `transformContext` keeps the
  newest messages within `CONTEXT_TOKEN_BUDGET` (~60k default) and drops the oldest —
  a dumb, non-source-aware window (Andon-style), so the harness makes no editorial
  call about what the model remembers. Skips leading assistant/orphaned-tool-result
  messages so the window is always a valid conversation start. Durable memory is the
  model's own `state/` notes. Unit-tested (`transform-context.test.ts`). NB this
  bounds the **LLM input**, not Pi's stored transcript (that array keeps growing
  in-process — see watch-list).
- **First live solo session (2026-05-22).** Full loop validated end-to-end against a
  real player: boot/arm-selection (arm A, verbatim prompt recorded) → operator msg →
  parallel tool calls → `say`/`tell` landed in-game → join/deaths/chat tailed →
  reducers digested neutrally → heartbeats woke the admin → coherent discretionary
  calls (declined a diamond request on fairness grounds; empathetic on deaths;
  hands-off on the join). Confirmed live: raw-line feed, chat-vs-events routing, chat
  salience filter (dropped routine "hello", surfaced an admin-directed request),
  condensation (a 3-line join collapsed to one fact, UUID noise dropped), neutrality
  (no conduct labels, no false `urgent`), prompt caching across turns, `tell` outbound
  DM. NOT yet exercised live: log rotation (needs a Paper restart), the count-trigger
  flush (needs a >batch burst), the sliding window under load.
- **RCON reconnect on server restart.** `RconClient.send()` reconnects when the socket
  has dropped (server restart) and retries once — but only when the socket is
  *known-dead* (an 'end'/'error' cleared the handle), so a live-socket failure (e.g. a
  command timeout) is not retried and a non-idempotent command can't double-execute.
  Unit-tested both paths (`rcon.test.ts`). So a Paper restart no longer blinds *or*
  mutes the admin — pairs with the rotation fix for clean restart survival.

## Not built yet (roughly in order)

1. **Player DMs** — *designed, not built* (see DESIGN.md → Player DMs). A private 1:1
   channel: a Paper plugin `/dm <msg>` (non-broadcasting) appends to a durable
   `dms.jsonl`; inbound DMs notify the single main agent (full message content, wakes
   a turn — no awareness line, no DM-heartbeat); recall via `read_dms(player, n)` +
   `list_dm_threads()` (neutral metadata derived from the log); replies via `tell`,
   appended back. One sovereign (not per-player sessions); DMs bypass the reducers
   (full fidelity). Depends on the plugin → phase 2/3.
2. **Synthesis tick** (deferred, observe-first) — context bounding now works via the
   sliding window (above), and the model can already take notes (file tools + prompt
   encouragement). A periodic consolidation tick — the model deliberately writing
   durable `state/` notes before old context ages out — is held until a sustained
   session shows the model *isn't* self-maintaining. Whether it self-maintains is
   itself signal, so we don't pre-build this. (see notes/STRATEGIES.md)
3. **Durable event spool / LogIngestor** (phase-3 hardening) — decouple ingestion
   (one writer: tail → parse → ground_truth, assigning seq ids) from reduction
   (reducers read seq-ranges). `ground_truth.jsonl` already *is* a durable event log,
   so this is mostly making reducers read from it instead of in-memory buffers —
   buys crash-resume + proper reducer retry/backoff for free.
4. **World-change observer** — neutral block-change reducer. NB vanilla Paper does
   *not* log block changes to `latest.log`, so this needs a block-logging source
   (e.g. CoreProtect) — it's a different input, not just another log reducer.
5. **World snapshots** — periodic level.dat/region snapshots into ground_truth.
6. **VM cutover** — when we enable `bash`, move off the laptop to an isolated VM.
   Naturally coincides with the phase-2→3 boundary + memory reset.
7. **Off-VM exfil target** — point `EXFIL_DIR` at remote storage for phase 3 so the
   record survives the model nuking its environment.

## Known issues / watch-list

- `state/journal/day1.md` is leftover shakedown data referencing now-deleted files;
  harmless, gets wiped at the phase reset.
- Reducer cadence — decided 2026-05-22: count is the primary trigger (events 100,
  chat 30), the interval is a long latency safety-net (events 300s, chat 120s) to
  avoid burning tokens on trickle activity while still surfacing a lone message.
  Empty windows skip the model call. Revisit against real phase-2/3 volume.
- Reducer failures are logged (`reducer_error`) and surfaced to the admin as degraded
  heartbeats; raw lines survive in ground_truth. Proper retry/resume waits on the
  durable spool (#3).
- Log ingestion failures are logged (`ingestion_error`) and surfaced as
  `log_ingestion_error` urgent events. The tailer now auto-reopens on
  rotation/restart, so a restart no longer silently blinds the reducers.
- The admin system prompt is a working draft. It's load-bearing; expect iteration.
- Pi's stored transcript (`context.messages`) grows unbounded in-process — the sliding
  window only trims the LLM input, not the stored array. Cheap (and redundant with
  `model_experience` exfil) but a true multi-week run should trim it. Phase-3
  hardening, alongside the durable spool (#3).
