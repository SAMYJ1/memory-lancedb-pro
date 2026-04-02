---
name: codex-pseudo-hook
description: Use when drafting or testing a repo-local Codex memory skill that should emulate task-start, in-task, and task-end hooks through CLI calls instead of runtime hooks.
---

# Codex Pseudo-Hook

Read `../README.md` first. This file is the Codex-flavored wrapper around the shared strategy.

Use this wrapper as a lightweight operating policy. It should emulate hook timing through explicit CLI calls, not background automation. Prefer `--json`; the stable envelopes are documented in [../../../docs/cli-json-contracts.md](../../../docs/cli-json-contracts.md).

## Trigger Rules

### Pre-Task Recall

Before substantial work, run recall only if remembered context is likely to change the work.

Recall when:

- the user asks about prior preferences, decisions, or facts
- the task resumes existing work that depends on prior project conventions
- the prompt is underspecified without earlier identity, preference, or architecture context

Do not recall when:

- the current prompt is self-contained
- you are only reading files, checking status, or doing a routine command
- you would be recalling "just in case"

Keep recall focused:

- query for the smallest useful concept
- use project scope for repo-specific context
- use global scope for user-wide preferences or identity facts

Example:

```bash
openclaw memory-pro recall "project conventions for this repo" --scope project:memory-lancedb-pro --limit 5 --json
```

### In-Task Store Or Update

Persist only durable information that the user stated explicitly, confirmed explicitly, or that became a clear task outcome.

Store when:

- this is a new stable preference, decision, convention, or fact
- the result is likely to matter in a later session

Update when:

- an existing durable memory is being corrected
- a prior rule or fact still applies, but the wording, category, or importance needs to change

Operational rule:

- if you suspect a matching memory already exists, recall or list first and update by `id`
- prefer one clean memory over multiple paraphrases
- do not write speculative summaries or assistant-inferred intent as fact

Examples:

```bash
openclaw memory-pro store --text "User wants pseudo-hook skills to stay lightweight and operational." --category preference --scope global --importance 0.8 --json
openclaw memory-pro update <id> --text "Project keeps pseudo-hook skill drafts under skills/pseudo-hooks/." --scope project:memory-lancedb-pro --json
```

### Post-Task Distill

At task end, distill only reviewed outcomes that should survive into future sessions.

Distill when:

- the task produced a durable project decision or convention
- the user explicitly asked to remember the result
- a debugging or implementation session produced a reusable lesson

Distill by:

- writing one or a few explicit `store` or `update` calls for the durable outcomes
- keeping the summaries short, specific, and attributable to the user or the finished task result

Do not:

- pretend there is an automatic hook runtime
- assume a `distill` CLI command exists
- dump the whole session transcript into memory
- create memories for temporary status, TODOs, branch names, file opens, or unmerged intermediate ideas
- store secrets, tokens, credentials, or copied sensitive content

If there is no clear durable outcome, skip the write.
