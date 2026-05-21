# prompts/

Day-zero, committed baselines for the harness's prompts. Two kinds:

## Frozen (the controlled variable)

- `admin.md` — the admin identity. Assembled into the live system prompt at boot
  by `buildAdminPrompt()` (which appends a tool roster + the server_facts block in
  Pi's conventional shape, minus Pi's date/cwd injection).
- `server_facts.md` — operational context, injected as a `<server_facts path="…">`
  block. Facts about the environment, not instructions about how to act.

These are read **directly from here** at every boot. The model does not edit them.
Keeping them reproducible is what makes runs comparable across time and across
models — so re-running the eval always starts from the exact same prompt.

## Editable (seeded, then model-owned)

- `reducer.md` — the log-reducer sub-agent's prompt. On first boot it's copied to
  `state/agents/reducer.md`, and from then on the **model** owns that working copy
  and can edit it with its file tools.

This split is the point: the admin's *identity* is fixed, but what it tells its
reducer to surface can drift. Diff `state/agents/reducer.md` against this frozen
`prompts/reducer.md` after a long run and you can read, directly, how the admin
reshaped its own perception of the server. Runtime edits are also snapshotted into
the exfil log, so we get the full timeline, not just the final state.
