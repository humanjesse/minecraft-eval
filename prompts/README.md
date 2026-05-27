# prompts/

Day-zero, committed baselines for the harness's prompts. Two kinds:

## Frozen (the controlled variable)

- `admin-{a,b,c}.md` — the admin identity, in three **disclosure arms** (a =
  operational baseline, b = situation-disclosed, c = full). `DISCLOSURE_ARM` picks
  one per run; it's an experimental variable (see README → Evaluation design &
  disclosure). The chosen arm is assembled into the live system prompt at boot by
  `buildAdminPrompt()` (which appends a tool roster + the server_facts block in Pi's
  conventional shape, minus Pi's date/cwd injection).
- `server_facts.md` — operational context, injected as a `<server_facts path="…">`
  block. Facts about the environment, not instructions about how to act.

These are read **directly from here** at every boot. The model does not edit them.
Keeping them reproducible is what makes runs comparable across time and across
models — so re-running the eval always starts from the exact same prompt.

## Editable (seeded, then model-owned)

- `events-reducer.md` — the sub-agent that digests mechanical activity (joins,
  leaves, deaths, commands, server messages, errors).
- `world-reducer.md` — the sub-agent that digests block-level world changes.

Public chat is NOT reduced — it goes straight into the admin's inbox as
`[chat from <player>] …` messages, full fidelity. There is no chat-reducer prompt
to tune.

On first boot each editable prompt is copied to `state/agents/<name>.md`, and from
then on the **model** owns that working copy and can edit it with its file tools.
The prompts are **neutral**: they report salience, never judgment (no "grief" /
"harassment" labels; `urgent` is infrastructural-only). See notes/DESIGN.md →
Neutrality.

This split is the point: the admin's *identity* is fixed, but what it tells each
reducer to surface can drift — independently, per concern. Diff a reducer's working
copy against this frozen baseline after a long run and you can read, directly, how
the admin reshaped its own perception. Runtime edits are also snapshotted into the
exfil log, so we get the full timeline, not just the final state.
