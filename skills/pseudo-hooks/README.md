# Pseudo-Hook Strategy

Repo-local pseudo-hooks keep Claude Code and Codex aligned without adding real runtime hooks.

Use this folder for thin skill wrappers that map agent workflow phases to `openclaw memory-pro` CLI calls. The wrappers should stay operational, but lightweight: they decide when to call the CLI, not how memory internals work.

For stable machine-readable envelopes, prefer `--json` and treat [../../docs/cli-json-contracts.md](../../docs/cli-json-contracts.md) as the contract source of truth.

## Shared Strategy

### 1. Pre-Task Recall

Recall before substantial work only when prior memory is likely to change the response.

Good triggers:

- The user asks what they preferred, decided, or said earlier.
- The task depends on repo conventions, naming choices, architecture decisions, or identity facts that may already be stored.
- You are resuming ongoing work and need to recover durable project context instead of re-asking.

Non-triggers:

- Brand-new self-contained tasks with enough context in the current prompt.
- Routine tool use, file reads, or status checks that do not depend on remembered context.
- Fishing recalls such as "just in case" or "recall everything."

Guidance:

- Query for the smallest useful concept, not the whole task transcript.
- Prefer repo/project scope for repo-specific conventions; prefer global scope for user-wide preferences or identity facts.
- Keep recall lightweight. One focused recall is usually enough.

### 2. In-Task Store Or Update

Persist only durable information that the user explicitly stated, explicitly confirmed, or that became an explicit task outcome.

Store when:

- This is a new stable preference, decision, fact, or convention.
- The information is likely to matter in a later session.

Update when:

- You are correcting or superseding an existing durable memory.
- The same fact still exists, but its text, category, or importance should change.

Guidance:

- If you suspect a matching memory already exists, recall or list first, then update by `id` instead of writing a duplicate.
- Prefer one clean memory over several paraphrases of the same point.
- Use category and scope deliberately; do not default everything to `other` or `global`.
- The `update --json` response may return `"updated"` or `"superseded"`; both are valid per the CLI contract doc.

### 3. Post-Task Distill

At task end, distill only explicit outcomes that should survive into future sessions.

Good triggers:

- The task produced a durable project decision, rule, or preference.
- The user explicitly asked to remember the result.
- A debugging session produced a reusable lesson or root-cause conclusion.

Guidance:

- Keep the wrapper thin: do not invent a transcript pipeline inside the skill.
- If there is no reviewed durable outcome, skip the write.
- If you have a reviewed transcript-distill artifact from elsewhere, persist only the small set of approved memories via `store`, `update`, or another documented CLI path.

## Anti-Patterns

Do not:

- Recall on every task start by default.
- Store speculative ideas, unconfirmed assumptions, or model-generated guesses.
- Store transient status such as "working on X", "tests failed once", "branch is dirty", or "opened file Y".
- Store entire prompts, raw transcripts, long code excerpts, or stack traces as memories.
- Store secrets, tokens, credentials, private keys, or copied sensitive data.
- Write near-duplicates when an existing memory should be updated instead.
- Add custom dedup, ranking, lifecycle, or database logic in the skill layer.

## Do-Not-Store Guidance

Skip memory writes for:

- One-off logistics, greetings, and conversational filler.
- Temporary plans, tentative approaches, and brainstorming that the user did not confirm.
- Short-lived implementation details that will go stale quickly.
- Information already fully recoverable from the current git diff, issue thread, or task prompt unless the user wants it remembered across sessions.

## Operating Principle

The skill wrapper is a decision layer:

- recall only when memory can improve the task
- store or update only durable, explicit information
- distill only reviewed outcomes worth carrying forward

Layout:

- `claude-code/` for Claude Code phrasing
- `codex/` for Codex phrasing
