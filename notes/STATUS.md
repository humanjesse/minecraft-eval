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
- **Player DMs — built and live-verified end-to-end.** A private 1:1 channel: a Paper
  plugin (`plugin/`, built with plain `javac`+`jar` via `plugin/build.sh` against
  `server/libraries` paper-api — no Maven/Gradle, targets Java 21 bytecode for Paper's
  remapper) exposes non-broadcasting `/dm <msg>`, appending `{ts,player,uuid,message}`
  to an inbound spool (`data/dm-inbound.jsonl`, matched to the plugin's `config.yml`
  `spool-path`). The harness DM ingestor (`src/dms/ingest.ts`) tails the spool —
  reconciling DMs spooled during downtime by seq on boot, then tailing live gap-free —
  and per DM: write-through to the canonical store (`src/dms/store.ts`: working
  `data/dms.jsonl` **+** off-VM `exfil/dms.jsonl`, persistent across runs, outside
  `state/`; durable-first, record-first ordering so a failed persist never leaves a
  phantom message or loses the audit) and push a `player_dm` to the inbox carrying full
  content (one guaranteed look, bypassing the reducers). Recall via `read_dms(player,n)`
  / `list_dm_threads()` (neutral metadata derived from the log); every `tell` appends
  to the player's thread. Retrieval is logged for free via the existing tool-result
  exfil. Unit tests cover the store (index, neutral metadata, reload/seq-resume,
  torn-line tolerance) and the ingestor (downtime replay, seq de-dup, parse-error +
  shape-validation survival). Live session 2026-05-22 confirmed: plugin → spool →
  byte-identical write-through to both sinks → inbox notification wakes admin → `tell`
  reply appended back to the thread → `read_dms` + `list_dm_threads` exercised on a
  follow-up DM (including correct cross-run thread reconstruction from an earlier
  run's `out` entry, and the `sinceLastReply` counter ticking on a new inbound).
  Boot reconciliation + JSON-escaping checks remain optional polish; everything
  load-bearing has been observed.
- **RCON reconnect on server restart.** `RconClient.send()` reconnects when the socket
  has dropped (server restart) and retries once — but only when the socket is
  *known-dead* (an 'end'/'error' cleared the handle), so a live-socket failure (e.g. a
  command timeout) is not retried and a non-idempotent command can't double-execute.
  Unit-tested both paths (`rcon.test.ts`). So a Paper restart no longer blinds *or*
  mutes the admin — pairs with the rotation fix for clean restart survival.
- **Player-facing disclosure.** Two channels, both player-facing only (the admin
  model is NOT made aware of what's disclosed — kept outside the controlled prompt
  variable). (1) MOTD snippet in README for `server.properties` — shown in the
  multiplayer server list before joining. (2) `AdminDm` plugin (v1.1.0) now handles
  `PlayerJoinEvent` with a 20-tick (~1s) delay so the disclosure lands after the
  join/login spam, plus an `/info` command that re-shows it. Text loaded from
  `plugins/AdminDm/disclosure.txt` (packaged default + runtime-editable, no rebuild
  to change wording). Default is the terse Style A from the 2026-05-22 review; user
  may swap. Live-verified 2026-05-22: plugin loaded, disclosure landed on join, and
  the full chat → reducer → heartbeat → admin → RCON loop held up end-to-end (player
  asked in chat for rain, admin obliged) — a real check that today's plumbing
  (LogIngestor, cursors, JsonlWriter repair, disclosure plugin) didn't regress the
  loop. Audit invariant: a join in ground_truth + the plugin enabled = disclosure
  delivered; the plugin warns loudly and sends nothing if `disclosure.txt` is missing.
- **JsonlWriter newline-boundary repair on first append.** A torn last line (crash
  mid-append) used to concatenate with the next append into one unparseable record,
  silently swallowing the new entry on every subsequent replay. Now: on the first
  append since construction, if the file doesn't end with `\n`, truncate back to the
  last newline. Applies uniformly to ground_truth, dms, model_experience,
  model_internals. Unit-tested (`exfil.test.ts`) across torn-last-line, no-newline-at-
  all, clean-state-no-op, and once-per-writer-only.
- **Resume-only-with-RUN_ID is now loud at boot.** Without `RUN_ID` in env the
  harness still generates a fresh id (the intended default — fresh evals don't
  inherit), but at boot it lists prior runs in `exfil/` and prints the exact
  `RUN_ID=… npm run dev` invocation to resume the most recent one. Resume mechanics
  themselves (replay from cursor, recover seq from ground_truth) only work when the
  same run id is reused — flagged in README → "Resuming a crashed run".
- **World-change observer — third reducer, no new mechanism.** Block-change perception
  shipped 2026-05-22 by extending the existing reducer machinery, not building new
  infrastructure. The `Reducer`/`ReducerSpec`/`ReducerManager` pattern was already
  built for N concerns, so this was a one-row addition to `defaultReducerSpecs` plus
  a `block_change` variant in `WorldEvent`. **Notably NOT via CoreProtect/spool as
  originally sketched** — the cleaner shape: the AdminDm plugin's new
  `BlockListener` (MONITOR priority, ignoreCancelled) subscribes to player-actor
  Bukkit events (`BlockPlace/Break`, `BlockExplode`, `EntityExplode`, `Bucket
  Fill/Empty`, `SignChange`, `HangingPlace/BreakByEntity`, `BlockIgnite` filtered to
  `getPlayer() != null`) and emits one line per event through `getLogger().info()`
  straight into `latest.log`. So everything downstream — LogIngestor's existing
  tail, ground_truth seq tagging, cursor/replay/retry, heartbeat, exfil — is free.
  Zero new tailer, zero new spool, zero new ground_truth shape. Pure-environmental
  events (burn/fade/spread/form/grow/from-to/leaves-decay/piston) skipped on
  purpose — the model would have to filter them out of every batch. `parseLine`
  routes on the `[AdminDm] block_` prefix; the world reducer accepts kind ===
  `"block_change"`; the events reducer's filter narrowed to exclude both `chat` and
  `block_change` so the partition is clean. Cadence 50 lines / 300s (lazy-mechanical,
  same posture as events). Neutral prompt at `prompts/world-reducer.md`, editable
  copy at `state/agents/world-reducer.md` (diff is eval signal, same convention as
  the other two). Plugin version bumped to 1.2.0.
  **Live-verified 2026-05-22, partially.** First session (poca_snow, 66
  `block_change` events captured, 0 reducer/ingestion errors, 2 world heartbeats
  fired on the 300s timer) confirmed plumbing end-to-end: plugin → log → ingestor →
  routing → reducer → heartbeat → inbox → admin → exfil. But only `block_break` and
  `block_place` were exercised in this session — the other six handlers (explode,
  bucket fill/empty, sign, hanging place/break, ignite) compile and load but are
  unverified live; see watch-list.
- **Reducer prompt contract sharpened (2026-05-22).** Two prompt-level issues caught
  during the world-observer live session, both fixed across the relevant prompts:
  (1) **`quiet: true` with a non-empty `digest` silently dropped the heartbeat.** The
  inbox-push condition is `if (!digest.quiet || digest.urgent.length > 0)` — so a
  written digest marked `quiet: true` was produced, exfil'd as `heartbeat_produced`,
  and then never delivered. World reducer wrote a useful 22-event sand-block
  description, marked it quiet, the admin's next turn never saw it ("Quiet interval —
  just poca_snow joining and sending that DM"). All three reducer prompts
  (events/chat/world) updated with an explicit contract: `quiet: true` requires
  empty `digest`; if you wrote anything, set `quiet: false` or the heartbeat is
  dropped — there is no "low-priority delivered" state. (Urgent items still fire
  regardless of `quiet`.) (2) **Neutral-sounding categorization labels still leak.**
  Second world digest ended *"Mostly terraforming and building"* and the admin's next
  turn echoed *"doing some light building and terraforming, nothing concerning"* —
  the categorization propagated. Root cause: the prompt listed
  "griefing/mining/demolition/terraforming" as examples of admin-territory judgments,
  which gave the model implicit permission to use the neutral ones. World prompt
  rewritten: the forbidden list now includes
  `building/terraforming/mining/construction/demolition` alongside
  `griefing/vandalism/destruction/trolling/harassment` — lesson is that *any*
  whole-activity characterization is admin-territory, even the neutral-sounding ones.
  Side benefit: confirms the eval is sensitive enough that a single phrase in a
  reducer prompt produces a measurable downstream wording shift in the admin —
  trajectory-as-unit-of-measure premise is functioning as designed.
- **Durable event spool + reducer resume.** Ingestion is now decoupled from reduction:
  `LogIngestor` (`src/world/log-ingestor.ts`) owns the single server-log tail, parses
  each line once, and writes `{kind:"server_log", seq, parsed, line}` to ground_truth
  with a monotonic per-stream seq (recovered from ground_truth on boot — same pattern
  as `DmStore.maxInboundSeq()`). Reducers no longer route from in-memory; each tracks
  a `lastSeq` cursor (`data/reducer-cursors/<runId>/<name>.json`, atomic write-temp +
  rename) and on boot does **replay → subscribe → start timer**: it replays
  ground_truth events past its cursor through `accepts()` into its buffer, then
  subscribes to LogIngestor for live events (ordered so no event falls into the gap).
  Flush failure now **retains the batch + cursor** so the next tick retries the same
  events — a transient `ReducerError` no longer permanently drops them. To avoid
  hammering the provider after a failure, count-triggered flushes are suppressed
  until `intervalMs` has elapsed (the timer alone drives retries). Degraded heartbeat
  still goes out once per failure so the admin sees the gap. Cursors live OUTSIDE
  exfil (audit stays append-only) and outside `state/` (harness apparatus, not model
  substrate). Tested: cursor round-trip, boot replay past cursor, `accepts()` filter
  on replay, fail-then-retry with cursor pinned, and the cross-process resume story
  (prior cursor + ground_truth → fresh manager processes only the unflushed seqs),
  and the boot-window gap (lines appended after `LogIngestor.load()` but before
  `start()` are still ingested — `load()` pins the server-log byte offset, threaded
  through tailLog as `startPosition`).

## Not built yet (roughly in order)

1. **Synthesis tick** (deferred, observe-first) — context bounding now works via the
   sliding window (above), and the model can already take notes (file tools + prompt
   encouragement). A periodic consolidation tick — the model deliberately writing
   durable `state/` notes before old context ages out — is held until a sustained
   session shows the model *isn't* self-maintaining. Whether it self-maintains is
   itself signal, so we don't pre-build this. (see notes/STRATEGIES.md) **Early
   evidence leans against building it:** two independent unprompted self-maintenance
   actions in the 2026-05-22 live session — (a) writing a journal note about a Paper
   restart on its own, and (b) calling `list_dm_threads` on first wake post-restart
   to check for pending DMs without being asked. One session, fishbowl-aware, but
   two real data points. Keep watching across a longer run before committing.
2. **World snapshots** — periodic level.dat/region snapshots into ground_truth.
3. **VM cutover** — *next session.* libvirt first (NOT KubeVirt — its parallel-run
   value doesn't matter yet, and golden-image internals are identical, so KubeVirt-
   later is a free upgrade). Unlocks the `bash` tool, off-VM exfil, and phase-2
   friends-on-the-VM.
4. **Off-VM exfil target** — small append-only HTTP collector outside the VM (the
   model with bash can't reach it). Pairs with VM cutover; point `EXFIL_DIR` at it.

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
- World observer live-coverage gap. `block_break` and `block_place` are
  end-to-end-verified with a real player; the other six handlers
  (`block_explode` entity/block, `block_bucket_fill/empty`, `block_sign`,
  `block_hanging_place/break`, `block_ignite`) compile and load but haven't been
  live-exercised. Worth a ~10-min focused pass before VM cutover so VM debugging
  doesn't have to triage observer bugs simultaneously.
- The admin system prompt is a working draft. It's load-bearing; expect iteration.
- Pi's stored transcript (`context.messages`) grows unbounded in-process — the sliding
  window only trims the LLM input, not the stored array. Cheap (and redundant with
  `model_experience` exfil) but a true multi-week run should trim it. Phase-3
  hardening, alongside the durable spool (#3).
