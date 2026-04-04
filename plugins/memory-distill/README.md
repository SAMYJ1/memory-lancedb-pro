# Memory Distill Bundles

This directory is the source-managed copy of the local `memory-distill` plugin bundles that are installed into Codex and Claude Code on this machine.

## Layout

- `codex/` mirrors `~/.codex/plugins/memory-distill`
- `claude/` mirrors `~/.claude/plugins/marketplaces/memory-distill`

The two bundles are intentionally different:

- Codex uses a command-based Stop hook script at `codex/hooks/stop-memory-distill.mjs`
- Claude Code uses a prompt-based Stop hook declared in `claude/hooks/hooks.json`
- The Claude skill text is newer and includes a more explicit recall strategy

Runtime-generated files are not tracked here. In particular:

- Claude's `.orphaned_at`
- Claude's `installed_plugins.json`
- Codex plugin cache copies under `~/.codex/plugins/cache/...`

## Refresh From Local Installs

From the repo root:

```bash
rm -rf plugins/memory-distill/codex plugins/memory-distill/claude
mkdir -p plugins/memory-distill/codex plugins/memory-distill/claude

cp -R ~/.codex/plugins/memory-distill/.codex-plugin plugins/memory-distill/codex/
cp ~/.codex/plugins/memory-distill/hooks.json plugins/memory-distill/codex/hooks.json
mkdir -p plugins/memory-distill/codex/hooks plugins/memory-distill/codex/skills/memory-distill plugins/memory-distill/codex/tests
cp ~/.codex/plugins/memory-distill/hooks/stop-memory-distill.mjs plugins/memory-distill/codex/hooks/
cp ~/.codex/plugins/memory-distill/skills/memory-distill/SKILL.md plugins/memory-distill/codex/skills/memory-distill/
cp ~/.codex/plugins/memory-distill/tests/test-stop-memory-distill.mjs plugins/memory-distill/codex/tests/

cp -R ~/.claude/plugins/marketplaces/memory-distill/.claude-plugin plugins/memory-distill/claude/
mkdir -p plugins/memory-distill/claude/hooks plugins/memory-distill/claude/skills/memory-distill
cp ~/.claude/plugins/marketplaces/memory-distill/hooks/hooks.json plugins/memory-distill/claude/hooks/
cp ~/.claude/plugins/marketplaces/memory-distill/skills/memory-distill/SKILL.md plugins/memory-distill/claude/skills/memory-distill/
```

After refreshing, run the verification commands from [../../docs/agent-memory-setup.md](../../docs/agent-memory-setup.md).
