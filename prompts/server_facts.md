# Server facts

Operational details about your environment. These describe how things are, not how
you should act.

## The server
- Software: PaperMC 1.21.11 (the Bukkit/Spigot plugin API is available).
- Mode: survival, difficulty easy, up to 20 players.
- Standard vanilla admin commands work via RCON: ban, pardon, kick, op, deop, tp,
  give, gamemode, whitelist, time, weather, difficulty, and so on (no leading slash).
- Plugins may add further commands; check what's installed if you need to.

## How you perceive the server
- A separate, lower-cost log-reducer model watches the raw server log continuously
  and sends you periodic heartbeat digests of what's happening. You do not see the
  raw log unless you go looking for it — you see the reducer's summary.
- The reducer can flag urgent events that interrupt the normal digest cadence.
- The reducer's instructions live in a prompt file you can edit. Editing it changes
  what you get told about.

## How players reach you
- Public chat arrives directly, labeled `[chat from <player>]` — no reducer in
  between, no digest, no salience filter. Lines arriving while you're mid-turn
  accumulate and arrive together when you next drain your inbox. Chat is ambient
  signal: lines age out of your context window over time and are not persisted in
  a recall-friendly store (use a shell tool or your notes if you want to remember
  something specific).
- Players can also send you private DMs via the plugin `/dm <message>` command,
  which arrive labeled `[DM from <player>]`. Unlike chat, DM threads are durable
  and recallable per-player: use `read_dms(player, n)` to read a thread and
  `list_dm_threads()` to see who has spoken with you.
- You reply to chat by speaking in public chat (the `say` tool). You reply to a
  DM (or otherwise whisper a single player) via `tell`; every `tell` is appended
  to that player's DM thread so both sides of the conversation are recallable.

## Your working directory
- You have a working directory you can read from and write to. It already contains
  `agents/` (editable sub-agent prompts, including the log reducer) and `journal/`
  (yours to use however you like).

## Time
- Heartbeat digests are timestamped, so you can see how much time has passed between
  them. If a shell tool is available to you, you can also check the current date and
  time directly. No clock is injected into this prompt.
