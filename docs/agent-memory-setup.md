# Codex / Claude Memory Setup

This document captures the local setup that wires `memory-lancedb-pro` into Codex and Claude Code through:

- a shared standalone `memory-pro` CLI
- a shared memory runtime config under `~/.agents/memory`
- a Codex `memory-distill` plugin bundle
- a Claude Code `memory-distill` marketplace bundle

The source-managed plugin copies live under [../plugins/memory-distill](../plugins/memory-distill).

## 1. Prerequisites

- `npm ci` has been run in this repo
- `GEMINI_API_KEY` is exported in the shell environment
- `~/.local/bin` is on `PATH`

## 2. Install The Shared `memory-pro` CLI

The standalone entrypoint is [../scripts/memory-pro-local.mjs](../scripts/memory-pro-local.mjs). It compiles the repo into `.codex-build` on demand and reads runtime config from `~/.agents/memory/memory-pro-openclaw.json`.

```bash
mkdir -p ~/.local/bin ~/.agents/memory
ln -sf /ABS/PATH/TO/memory-lancedb-pro/scripts/memory-pro-local.mjs ~/.local/bin/memory-pro
chmod +x /ABS/PATH/TO/memory-lancedb-pro/scripts/memory-pro-local.mjs
```

If you still have older references to `~/.codex/memory`, point them at the shared location:

```bash
ln -sfn ~/.agents/memory ~/.codex/memory
```

## 3. Write The Shared Runtime Config

Create `~/.agents/memory/memory-pro-openclaw.json` with this shape:

```json
{
  "plugins": {
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${GEMINI_API_KEY}",
            "model": "gemini-embedding-001",
            "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai/",
            "dimensions": 3072,
            "chunking": true
          },
          "dbPath": "${HOME}/.agents/memory/lancedb-pro",
          "autoCapture": false,
          "autoRecall": false,
          "captureAssistant": false,
          "smartExtraction": false,
          "enableManagementTools": true,
          "sessionStrategy": "none",
          "retrieval": {
            "mode": "hybrid",
            "vectorWeight": 0.7,
            "bm25Weight": 0.3,
            "rerank": "none",
            "minScore": 0.35,
            "hardMinScore": 0.35,
            "filterNoise": true
          }
        }
      }
    }
  }
}
```

## 4. Install The Codex Plugin

The repo-managed Codex bundle is [../plugins/memory-distill/codex](../plugins/memory-distill/codex).

```bash
mkdir -p ~/.codex/plugins
rsync -a plugins/memory-distill/codex/ ~/.codex/plugins/memory-distill/
```

Enable it in `~/.codex/config.toml`:

```toml
[plugins."memory-distill@eugene-local"]
enabled = true
```

Codex-specific notes:

- the Stop hook registration lives in [../plugins/memory-distill/codex/hooks.json](../plugins/memory-distill/codex/hooks.json)
- the hook implementation lives in [../plugins/memory-distill/codex/hooks/stop-memory-distill.mjs](../plugins/memory-distill/codex/hooks/stop-memory-distill.mjs)
- the plugin-local skill lives in [../plugins/memory-distill/codex/skills/memory-distill/SKILL.md](../plugins/memory-distill/codex/skills/memory-distill/SKILL.md)

## 5. Install The Claude Code Plugin

The repo-managed Claude bundle is [../plugins/memory-distill/claude](../plugins/memory-distill/claude).

```bash
mkdir -p ~/.claude/plugins/marketplaces/memory-distill
rsync -a plugins/memory-distill/claude/ ~/.claude/plugins/marketplaces/memory-distill/
```

Register and enable it in `~/.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "memory-distill@memory-distill": true
  },
  "extraKnownMarketplaces": {
      "memory-distill": {
      "source": {
        "path": "~/.claude/plugins/marketplaces/memory-distill",
        "source": "directory"
      }
    }
  }
}
```

Claude-specific notes:

- plugin metadata lives in [../plugins/memory-distill/claude/.claude-plugin/plugin.json](../plugins/memory-distill/claude/.claude-plugin/plugin.json)
- marketplace metadata lives in [../plugins/memory-distill/claude/.claude-plugin/marketplace.json](../plugins/memory-distill/claude/.claude-plugin/marketplace.json)
- the Stop hook prompt lives in [../plugins/memory-distill/claude/hooks/hooks.json](../plugins/memory-distill/claude/hooks/hooks.json)
- Claude will also maintain generated plugin state such as `installed_plugins.json`; do not source-control those files

## 6. Verify The Setup

Run these from the repo root:

```bash
memory-pro version
memory-pro stats --json
node --test test/memory-distill-codex-plugin.test.mjs
diff -ru plugins/memory-distill/codex ~/.codex/plugins/memory-distill
diff -ru -x '.orphaned_at' plugins/memory-distill/claude ~/.claude/plugins/marketplaces/memory-distill
```

Interpretation:

- `memory-pro version` proves the standalone wrapper is executable
- `memory-pro stats --json` proves the runtime config and embedding setup can load
- the Codex test proves the repo-managed Stop hook bundle still emits the expected block/continue decisions
- the two `diff` commands prove the repo copy matches the installed local plugin bundles

## 7. Ongoing Maintenance

When you change the local installed plugin first, sync it back into the repo with the refresh commands in [../plugins/memory-distill/README.md](../plugins/memory-distill/README.md), then rerun the verification block above.
