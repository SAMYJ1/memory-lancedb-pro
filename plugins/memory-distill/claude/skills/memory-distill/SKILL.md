---
name: memory-distill
description: Use when the current task may rely on durable context that is not restated in the prompt, especially if the user refers to something decided earlier, asks what was done before or today in this local environment, resumes ongoing work, or the answer may change based on stable preferences, project conventions, architecture decisions, or reusable debugging conclusions. Also use when the user explicitly asks to remember, recall, inspect, correct, or update long-term memory, or when a Stop hook continuation asks whether this turn created durable context worth persisting.
tools: Bash, Read, Grep, Glob
---

# Memory Distill

Use this plugin-local skill to decide whether durable context should be recalled from, or persisted to, the shared `memory-pro` store under `~/.agents/memory`.

## Preconditions

- `memory-pro` must be on `PATH`
- runtime config lives at `~/.agents/memory/memory-pro-openclaw.json`
- `GEMINI_API_KEY` must be available in the shell environment

## When To Recall

Recall only when prior durable context is likely to change the response.

Recall when:

- the user asks about an earlier preference, decision, or fact
- the user asks local historical questions such as "今天做了什么", "what I have done before", or "之前处理过什么"
- the task resumes work that depends on established repo conventions
- the current prompt is underspecified without remembered context

Do not recall when:

- the prompt is already self-contained
- you are only reading files or checking local status
- the recall would be broad, speculative, or precautionary

### Recall Strategy

Follow this sequence — do not guess scopes or fire blind queries.

**Step 1 — Scope discovery via stats:**

```bash
memory-pro stats --json
```

Read `scopeCounts` to learn which scopes actually contain memories (e.g. `project:tools`, `global`). Only query scopes that exist. Do not invent scope keys like `project:<repo-name>` — the actual key depends on what was used at store time and may not match the current directory or repo name.

**Step 2 — Targeted recall:**

Use discovered scopes. Prefer keyword-dense queries over full sentences — the retrieval is vector + BM25 hybrid, so concise terms with high specificity recall better.

```bash
# Good: keyword-dense
memory-pro recall "proxy DNS convention memory storage" --scope project:tools --limit 5 --json

# Bad: natural language padding
memory-pro recall "what were the previous durable decisions made for this project" --scope project:tools --limit 5 --json
```

Scope priority:

- `project:*` for repo-local conventions, debugging outcomes, architecture decisions
- `global` for stable user-wide preferences and cross-project rules

**Step 3 — Fallback on empty results:**

If a scoped recall returns 0 items and you expected results:

1. Try `memory-pro list --scope <scope> --limit 10 --json` to see what actually exists
2. Try broadening: drop the `--scope` flag or use a different scope from stats
3. If list also returns 0, the store is genuinely empty for that scope — do not retry

### Query Construction Tips

- 2–5 keywords > full sentence
- Include the domain noun (e.g. "memory", "proxy", "auth") and the aspect (e.g. "convention", "decision", "root cause")
- Avoid filler words ("previous", "durable", "this project") — they dilute vector similarity
- For debugging recall, include the symptom or tool name (e.g. "mihomo DNS unreachable")

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

Before storing, always check for duplicates:

```bash
# 1. Check if a similar memory already exists
memory-pro recall "Chinese response preference" --scope global --limit 3 --json

# 2a. No match — store new
memory-pro store --text "User prefers Chinese responses by default." --category preference --scope global --importance 0.8 --json

# 2b. Match found — update existing by id
memory-pro update <id> --text "Project keeps shared memory storage under ~/.agents/memory." --scope project:tools --json
```

Scope selection for storage:

- `global` — user preferences, cross-project rules
- `project:<key>` — use the **same key** that `memory-pro stats` shows for this project area; do not invent new keys unless starting a genuinely new scope

## Post-Task Distill

If a Stop hook continuation sent you here, decide whether the completed turn established durable context worth preserving.

Distill when:

- the completed task established a durable convention or design decision
- the user explicitly asked to remember the outcome
- a debugging session produced a reusable lesson, confirmed root cause, or verified fix

Do not:

- imply there is a hidden automatic persistence pipeline beyond the hook continuation
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
