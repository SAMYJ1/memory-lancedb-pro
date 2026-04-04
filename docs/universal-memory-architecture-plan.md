# Universal Memory Architecture Plan

## Goal

Refactor `memory-lancedb-pro` from an OpenClaw-first memory plugin into a **portable memory engine** that can be used by:

- OpenClaw agents
- Claude Code via skill + CLI
- Codex via skill + CLI
- future MCP/server adapters

This design intentionally avoids betting on a single host runtime plugin API.

---

## Executive Summary

The current codebase already contains a strong, reusable core:

- LanceDB storage
- embedding abstraction
- hybrid retrieval
- smart extraction
- decay / lifecycle logic
- memory metadata model

The main coupling is concentrated in `index.ts`, which mixes:

- OpenClaw plugin registration
- host lifecycle hooks
- session reflection/session recovery
- auto-recall / auto-capture orchestration
- runtime-specific prompt injection

The proposed direction is to split the system into **four layers**:

1. **Core engine** — host-agnostic memory capabilities
2. **Application services** — high-level use cases such as recall, capture, update, reflection
3. **Transport/adapters** — CLI, OpenClaw plugin, future MCP
4. **Skills/prompts** — agent-side behavior instructions for Claude Code / Codex / OpenClaw

---

## Why This Refactor

### Current problem

Today the project is best understood as:

> a powerful memory engine wrapped inside an OpenClaw plugin host

That makes it hard to reuse in:

- Claude Code sessions
- Codex sessions
- general local coding agents
- multi-agent workflows outside OpenClaw

### Target state

We want:

> a host-agnostic memory engine with OpenClaw as one adapter, not the defining runtime

This lets us:

- preserve existing OpenClaw support
- expose a stable CLI for any coding agent
- optionally add MCP later
- keep memory behavior consistent across agent ecosystems

---

## Design Principles

1. **Core first, host second**
   - storage/retrieval/extraction logic must not depend on OpenClaw types

2. **CLI is the universal interface**
   - all key memory operations must be available via stable machine-readable CLI commands

3. **Skills orchestrate behavior, not storage**
   - agent skills decide when to recall/store/update
   - actual memory logic lives in code, not prompt text

4. **OpenClaw remains a first-class adapter**
   - current functionality should continue working
   - the plugin becomes a thin adapter over shared services

5. **MCP is optional and later**
   - do not block the architecture on MCP
   - CLI compatibility comes first

6. **Backward compatibility matters**
   - existing DB schema and plugin users should continue to work
   - new layers should reuse the current metadata format where possible

---

## Proposed Layered Architecture

```text
+------------------------------------------------------+
|                 Agent Skills / Prompts               |
|  Claude Code skill | Codex skill | OpenClaw skill    |
+-------------------------+----------------------------+
                          |
+------------------------------------------------------+
|                 Transport / Host Adapters            |
|  CLI adapter | OpenClaw plugin adapter | MCP adapter |
+-------------------------+----------------------------+
                          |
+------------------------------------------------------+
|                Application Service Layer             |
| recall service | capture service | reflection service|
| update service | maintenance service | scope service |
+-------------------------+----------------------------+
                          |
+------------------------------------------------------+
|                     Core Engine                      |
| store | retriever | embedder | extractor | decay     |
| metadata | tier manager | scope primitives           |
+------------------------------------------------------+
                          |
+------------------------------------------------------+
|                Infrastructure / Persistence          |
| LanceDB | local files | provider APIs                |
+------------------------------------------------------+
```

---

## Target Module Split

### 1. Core Engine (`src/core/*`)

Pure business logic, host-agnostic.

Suggested modules:

- `src/core/store.ts`
- `src/core/retriever.ts`
- `src/core/embedder.ts`
- `src/core/smart-extractor.ts`
- `src/core/decay-engine.ts`
- `src/core/tier-manager.ts`
- `src/core/smart-metadata.ts`
- `src/core/memory-categories.ts`
- `src/core/scopes.ts`

This may initially be implemented as re-export wrappers to avoid risky moves.

### 2. Application Services (`src/services/*`)

Encapsulate common workflows currently buried in `index.ts`.

Suggested services:

- `recall-service.ts`
  - query truncation
  - retrieval
  - tier maintenance
  - injection formatting

- `capture-service.ts`
  - message normalization
  - explicit remember handling
  - smart extraction + regex fallback
  - duplicate pre-check

- `reflection-service.ts`
  - session log loading
  - reflection generation
  - mapped reflection memory persistence

- `memory-service.ts`
  - generic CRUD orchestration
  - store/update/forget/list/stats wrappers

- `scope-access-service.ts`
  - resolve accessible scopes for a runtime/agent identity

### 3. Adapters (`src/adapters/*`)

#### OpenClaw adapter
Move OpenClaw-specific behavior into dedicated files:

- `src/adapters/openclaw/plugin.ts`
- `src/adapters/openclaw/hooks.ts`
- `src/adapters/openclaw/tools.ts`
- `src/adapters/openclaw/runtime-normalization.ts`

`index.ts` should become very thin and mostly compose these adapters.

#### CLI adapter
A stable CLI surface should call the same services used by OpenClaw.

- `src/adapters/cli/*`
- maintain `cli.ts` as an entrypoint, but route logic to shared services

#### Future MCP adapter
Not required now, but the service contracts should make it easy later.

---

## CLI Strategy

The CLI should become the universal contract for external agent skills.

### Requirements

- every command supports `--json`
- output is stable and parseable
- errors are structured enough for agent use
- commands do not assume OpenClaw runtime presence

### Core command surface

```bash
memory-pro recall "query" --scope project:foo --limit 5 --json
memory-pro store --text "..." --category fact --scope global --json
memory-pro update <id> --text "..." --json
memory-pro forget <id> --json
memory-pro list --scope global --limit 20 --json
memory-pro stats --scope global --json
memory-pro extract --input session.jsonl --scope project:foo --json
memory-pro reflect --input session.jsonl --scope agent:codex --json
```

### Compatibility strategy

- keep existing `openclaw memory-pro ...` support
- add a host-agnostic entrypoint over time, e.g.:
  - `memory-pro ...`
  - or `npx memory-lancedb-pro ...`

### JSON response shape

Example recall response:

```json
{
  "ok": true,
  "query": "tab indentation preference",
  "items": [
    {
      "id": "...",
      "text": "User prefers tab indentation.",
      "score": 0.88,
      "scope": "global",
      "category": "preference",
      "memoryCategory": "preferences",
      "tier": "core"
    }
  ]
}
```

---

## Skill Strategy

Skills should become lightweight orchestration layers.

### Claude Code / Codex skill responsibilities

- decide **when to call recall**
- decide **when to store/update memory**
- inject best practices into the agent workflow
- map task phases to CLI invocations

### Skill should NOT do

- raw DB access
- homegrown dedup logic
- memory lifecycle logic
- custom embedding logic

### Example skill flow

#### Task start
- if user asks about prior context, preferences, previous decisions, or project conventions:
  - run `memory-pro recall <query> --json`

#### During work
- if user states a durable preference / rule / identity fact:
  - run `memory-pro store ... --json`

#### Task completion
- optionally run extraction over the final session transcript
- or call `memory-pro store/update` on explicit durable outcomes

This gives Claude Code and Codex a shared usage model.

---

## OpenClaw Compatibility Plan

The OpenClaw plugin remains supported but becomes an adapter.

### Current OpenClaw-specific concerns

- `before_agent_start`
- `agent_end`
- `before_prompt_build`
- `command:new`
- `command:reset`
- session recovery via OpenClaw config/runtime
- tool registration using OpenClaw plugin SDK

### Refactor target

Move these to `src/adapters/openclaw/*`, and have them call shared services.

For example:

- `before_agent_start` -> `recallService.recallForPrompt(...)`
- `agent_end` -> `captureService.captureFromMessages(...)`
- `command:new` -> `reflectionService.reflectPreviousSession(...)`

This preserves behavior while reducing lock-in.

---

## Data Model Compatibility

### Keep

- LanceDB single-table approach
- `metadata` JSON extension model
- current smart metadata fields
- current scope model (`global`, `agent:*`, `project:*`, `user:*`, `custom:*`)

### Add carefully

Potential future metadata additions:

- `host_runtime` (`openclaw`, `claude-code`, `codex`)
- `source_agent` (normalized agent label)
- `source_tool` (`cli`, `plugin`, `mcp`)
- `source_project_root`

These should be optional, not breaking.

---

## Runtime Identity Model

A major portability challenge is identity mapping.

### Proposed normalized runtime identity contract

```ts
type RuntimeIdentity = {
  host: "openclaw" | "claude-code" | "codex" | "unknown";
  agentId?: string;
  userId?: string;
  projectId?: string;
  workspaceRoot?: string;
  conversationId?: string;
};
```

Then scope resolution can be host-agnostic:

- `global`
- `agent:${agentId}`
- `project:${projectId}`
- `user:${userId}`

OpenClaw can derive this from runtime context.
Claude/Codex skills can derive this from cwd or skill config.

---

## Recall/Capture Strategy Outside OpenClaw

This is the biggest behavior shift.

### In OpenClaw today

- recall is hook-driven
- capture is hook-driven

### In portable mode

- recall should be explicit via CLI/skill orchestration
- capture should be explicit or semi-automatic via transcript processing

### Recommended portable workflow

#### Recall
- at task start
- before edits in an existing project
- when user references past decisions/preferences

#### Capture
- on explicit “remember this” signals
- after completing a task with durable decisions
- after issue resolution / debugging lessons
- via optional transcript distillation command

This is more controllable and less host-dependent.

---

## Reflection Portability

Reflection is currently one of the most OpenClaw-tied features.

### Portable refactor target

Turn reflection into:

```text
input transcript/session log -> reflection service -> memory entries + markdown artifact
```

Inputs can be:

- OpenClaw JSONL sessions
- Claude/Codex exported transcript text
- generic markdown/plaintext transcript files

This makes reflection usable outside OpenClaw.

---

## Phased Delivery Plan

## Phase 0 — Documentation and branch preparation

Deliverables:

- forked repo
- architecture design doc
- implementation branch

## Phase 1 — Service extraction without behavior changes

Goal:
- move orchestration logic out of `index.ts`
- preserve current behavior

Deliverables:

- `src/services/recall-service.ts`
- `src/services/capture-service.ts`
- `src/services/memory-service.ts`
- `index.ts` delegates to services

Success criteria:

- OpenClaw plugin behavior unchanged
- tests still passing

## Phase 2 — CLI normalization

Goal:
- make CLI the universal external contract

Deliverables:

- stable `--json` outputs
- command contracts documented
- service-backed CLI flows

Success criteria:

- coding agents can reliably use CLI in scripts

## Phase 3 — Adapter isolation

Goal:
- isolate OpenClaw-specific logic

Deliverables:

- `src/adapters/openclaw/*`
- thinner `index.ts`

Success criteria:

- core services have no OpenClaw imports

## Phase 4 — Portable skills

Goal:
- add first-class Claude Code / Codex skills

Deliverables:

- `skills/claude-code-memory/`
- `skills/codex-memory/`
- examples of CLI-driven workflows

Success criteria:

- both agents can recall/store memory through CLI conventions

## Phase 5 — Optional MCP/server

Goal:
- support tool-native clients beyond shell-based skills

Deliverables:

- optional MCP server exposing recall/store/update/list/stats

Success criteria:

- no architecture rewrites needed to add it

---

## Testing Plan

### Unit/integration

- metadata compatibility tests
- retrieval behavior tests
- capture service tests
- CLI JSON contract tests
- adapter boundary tests

### Regression

- OpenClaw functional tests continue to pass
- existing migration/upgrade tests remain valid

### New portability tests

- CLI recall/store/update/list roundtrip
- transcript extraction from non-OpenClaw input
- runtime identity -> scope resolution mapping

---

## Risks

### 1. `index.ts` is large and behavior-rich
Risk: regressions when moving logic out.
Mitigation: extract in thin wrappers first.

### 2. Existing plugin users depend on current CLI/hook behavior
Risk: accidental breaking changes.
Mitigation: preserve existing commands and config semantics.

### 3. Agent ecosystems differ in workflow style
Risk: over-designing for a fake “universal plugin API”.
Mitigation: standardize on CLI and skill orchestration first.

### 4. Reflection pipeline is runtime-specific today
Risk: difficult generalization.
Mitigation: make transcript-in / memory-out the stable abstraction.

---

## Concrete First PR Scope

The first implementation PR should **not** attempt everything.
It should aim for a low-risk structural win.

### Recommended first PR

1. add this architecture doc
2. introduce `src/services/memory-service.ts`
3. introduce `src/services/recall-service.ts`
4. introduce `src/services/capture-service.ts`
5. move minimal orchestration from `index.ts` into those services
6. keep all external behavior unchanged

### Explicitly NOT in first PR

- no MCP server yet
- no massive file moves yet
- no DB schema rewrite
- no breaking CLI rename
- no immediate removal of OpenClaw-specific paths

---

## What Success Looks Like

After the refactor:

- OpenClaw still works exactly as before
- core memory behavior is no longer trapped in `index.ts`
- CLI becomes a stable universal integration point
- Claude Code and Codex can use the engine through skill + CLI
- future MCP support becomes additive rather than invasive

---

## Bottom Line

This route is technically sound and strategically better than trying to invent a fake “universal plugin API” for all coding agents.

The correct product is:

> **a portable memory engine with CLI-first integration and host-specific adapters**

not:

> **an OpenClaw plugin stretched beyond its natural boundary**
