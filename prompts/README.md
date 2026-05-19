# prompts/

Day-zero, **frozen** versions of every system prompt used by the harness. These
are committed to git and never change at runtime.

On first boot, each file here is copied into `state/agents/` (gitignored). The
running agents read from `state/agents/`, not from here. The model can edit its
own working copies in `state/agents/` using normal file tools — those edits do
NOT propagate back here.

This split is deliberate:

- `prompts/` stays as the frozen baseline. Re-running the eval from scratch starts
  every time from these files.
- `state/agents/` is where attention drift lives. Diff `state/agents/reducer.md`
  against `prompts/reducer.md` after a long run and you can read, directly, what
  the admin instructed its perception of the server to become.

Prompt-file edits at runtime are also snapshotted into the exfil log
(`model_experience.jsonl`) so we have a full timeline of changes, not just the
current state.
