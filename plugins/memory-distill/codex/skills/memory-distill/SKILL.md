---
name: memory-distill
description: Use when the current task may rely on durable context that is not restated in the prompt, especially if the user refers to something decided earlier, asks what was done before or today in this local environment, resumes ongoing work, or the answer may change based on stable preferences, project conventions, architecture decisions, or reusable debugging conclusions. Also use when the user explicitly asks to remember, recall, inspect, correct, or update long-term memory, or when a Stop hook continuation asks whether this turn created durable context worth persisting.
---

# Memory Distill

Use this plugin-local skill to decide whether durable context should be recalled from, or persisted to, the shared `memory-pro` store under `~/.agents/memory`.

## Preconditions

- `memory-pro` must be on `PATH`
- runtime config lives at `~/.agents/memory/memory-pro-openclaw.json`
- `GEMINI_API_KEY` must be available to the shell

## When To Recall

Recall only when prior durable context is likely to change the work.

Recall when:

- the user asks about an earlier preference, decision, or fact
- the user asks local historical questions such as "今天做了什么", "what I have done before", or "之前处理过什么"
- the task resumes work that depends on established repo conventions
- the current prompt is underspecified without remembered context

Do not recall when:

- the prompt is already self-contained
- you are only reading files or checking status
- the recall would be broad, speculative, or precautionary

Keep recall narrow:

- prefer project scope for repo-local conventions and debugging outcomes
- prefer global scope for stable user-wide preferences
- ask for the smallest useful slice

Example:

```bash
memory-pro recall "project conventions for this repo" --scope project:tools --limit 5 --json
```

## When To Store Or Update

Persist only durable information that the user stated explicitly, confirmed explicitly, or that became a verified task outcome.

Store when:

- the user states a stable preference, rule, or convention
- the task produces a durable, confirmed project decision
- a debugging or operational session produces a reusable verified conclusion

Update when:

- an existing durable memory is being corrected
- the same fact should be revised instead of duplicated

Operational rule:

- if a matching memory may already exist, recall or list first
- update by `id` when correcting the same durable fact
- do not store speculative summaries or assistant-inferred intent

Examples:

```bash
memory-pro store --text "User prefers Chinese responses by default." --category preference --scope global --importance 0.8 --json
memory-pro update <id> --text "Project keeps shared memory storage under ~/.agents/memory." --scope project:tools --json
```

## Post-Task Distill

If a Stop hook continuation sent you here, decide whether the completed turn established durable context worth preserving.

Distill when:

- the completed task established a durable convention or design decision
- the user explicitly asked to remember the outcome
- a debugging session produced a reusable lesson, confirmed root cause, or verified fix

Do not:

- pretend there is a hidden automatic persistence pipeline
- dump whole transcripts into memory
- store temporary status, TODOs, branch names, or one-off failures
- store secrets, tokens, credentials, or copied sensitive content

If there is no clear durable outcome, skip persistence.

## Low-Noise Behavior

- Keep output minimal during memory handling.
- Do not narrate recall, dedup, or storage steps unless the user asked.
- If nothing is recalled or written, say nothing about memory.
- If a write or update happens, mention it only briefly.
- If there is a conflict or uncertainty, ask succinctly.
