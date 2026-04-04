---
name: claude-code-pseudo-hook
description: Use when drafting or testing a repo-local Claude Code memory skill that should emulate task-start, in-task, and task-end hooks through CLI calls instead of runtime hooks.
---

# Claude Code Pseudo-Hook

Read `../README.md` first. This file is the Claude Code-flavored wrapper around the shared strategy.

Use this wrapper as a lightweight operating policy. It should mirror hook timing through explicit CLI calls, not through hidden automation. Prefer `--json`; the stable envelopes are documented in [../../../docs/cli-json-contracts.md](../../../docs/cli-json-contracts.md).

## Trigger Rules

### Pre-Task Recall

At the beginning of a task, recall only when previous preferences, decisions, or project facts are likely to change the response.

Recall when:

- the user refers to something decided or preferred earlier
- the task depends on established project conventions or prior architecture choices
- you are resuming work where durable context is likely missing from the current prompt

Do not recall when:

- the task is fully specified in the current conversation
- you are only gathering local context from files or status commands
- the recall would be broad, unfocused, or purely precautionary

Keep recall narrow:

- ask for the smallest useful memory slice
- prefer project scope for repo-local decisions
- prefer global scope for user-wide preferences or identity facts

Example:

```bash
openclaw memory-pro recall "previous decisions for this project" --scope project:memory-lancedb-pro --limit 5 --json
```

### In-Task Store Or Update

Store durable user guidance, confirmed project conventions, and stable identity facts. If an existing memory needs correction, update it instead of writing a near-duplicate.

Store when:

- the user states a durable preference or rule explicitly
- the task produces a durable, confirmed project decision
- a stable identity or environment fact is confirmed and likely reusable later

Update when:

- an older memory is now wrong or incomplete
- the same memory should be revised instead of duplicated

Operational rule:

- if you think the memory already exists, recall or list first
- update by `id` when correcting the same durable fact
- avoid storing assistant-generated interpretations that the user did not confirm

Examples:

```bash
openclaw memory-pro store --text "Project keeps pseudo-hook skill drafts repo-local under skills/pseudo-hooks/." --category decision --scope project:memory-lancedb-pro --importance 0.8 --json
openclaw memory-pro update <id> --text "Claude Code pseudo-hook guidance should stay minimal, operational, and reusable." --scope global --json
```

### Post-Task Distill

Persist only explicit outcomes worth reusing later.

Distill when:

- the completed task established a durable convention or design decision
- the user explicitly asked to remember the outcome
- a debugging session produced a reusable lesson or root cause

Distill by:

- storing one or a few short, reviewed outcomes
- updating an existing memory instead of writing a paraphrased duplicate

Do not:

- invent end-of-task summaries that were never confirmed
- imply a built-in `distill` command or hidden transcript pipeline
- store transient implementation status, branch names, file paths, or one-off failures
- store raw transcripts, code dumps, stack traces, secrets, or credentials
- add custom database, dedup, or lifecycle logic in the skill layer

If no durable outcome exists, skip persistence.
