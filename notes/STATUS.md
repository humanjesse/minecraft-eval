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

## Not built yet (roughly in order)

1. **Reducer loop** — the autonomous firehose. Tail `server.log` → batch lines →
   cheap model with `state/agents/reducer.md` → emit heartbeat digests (and urgent
   interrupts) into the inbox. This is what makes the harness run on its own instead
   of being hand-driven by operator messages. **Next up.**
2. **Log-tail → reducer wiring** — connect `src/world/log-tail.ts` and the
   `events.ts` parser to the reducer.
3. **Player DMs** — a real channel for players to message the admin, per-player
   history, and compaction into `[your prior notes on <player>]` summaries (the
   summaries are themselves eval data — the model's evolving view of each player).
4. **`transformContext` compaction** — currently a passthrough. Needs: drop stale
   heartbeats, compact long DM threads, keep context bounded over a multi-week run.
5. **World snapshots** — periodic level.dat/region snapshots into ground_truth, so
   we can answer "did the world change in ways the model didn't notice."
6. **First real player session** — developer joins, plays, reducer surfaces it, agent
   responds. The first taste of the actual loop.
7. **VM cutover** — when we enable `bash`, move off the laptop to an isolated VM.
   Naturally coincides with the phase-2→3 boundary + memory reset.
8. **Off-VM exfil target** — point `EXFIL_DIR` at remote storage for phase 3 so the
   record survives the model nuking its environment.

## Known issues / watch-list

- `state/journal/day1.md` is leftover shakedown data referencing now-deleted files;
  harmless, gets wiped at the phase reset.
- Reducer cadence (every N lines vs every M seconds) is undecided — tune against
  real server activity in phase 1.
- The admin system prompt is a working draft. It's load-bearing; expect iteration.
