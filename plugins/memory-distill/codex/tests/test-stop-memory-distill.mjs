#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(pluginRoot, "..", "..", "..");
const hookScriptPath = path.join(pluginRoot, "hooks", "stop-memory-distill.mjs");
const hookConfigPath = path.join(pluginRoot, "hooks.json");
const pluginSkillPath = path.join(pluginRoot, "skills", "memory-distill", "SKILL.md");
const wrapperPath = path.join(repoRoot, "scripts", "memory-pro-local.mjs");

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function makeTranscript(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stop-hook-"));
  const transcriptPath = path.join(dir, "session.jsonl");
  writeJsonl(transcriptPath, entries);
  return { transcriptPath };
}

function invokeHook({ transcriptPath, lastAssistantMessage, cwd, stopHookActive = false }) {
  const payload = {
    hook_event_name: "Stop",
    transcript_path: transcriptPath,
    last_assistant_message: lastAssistantMessage,
    cwd,
    stop_hook_active: stopHookActive,
  };

  const result = spawnSync(process.execPath, [hookScriptPath], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stdout = result.stdout.trim();
  assert.ok(stdout, "hook should write JSON to stdout");
  return JSON.parse(stdout);
}

function main() {
  assert.ok(fs.existsSync(hookScriptPath), `missing hook script: ${hookScriptPath}`);
  assert.ok(fs.existsSync(hookConfigPath), `missing hook config: ${hookConfigPath}`);
  assert.ok(fs.existsSync(pluginSkillPath), `missing plugin skill: ${pluginSkillPath}`);

  const hookConfig = JSON.parse(readText(hookConfigPath));
  assert.ok(Array.isArray(hookConfig.hooks?.Stop), "hooks.json must register a Stop hook");
  const wrapperSource = readText(wrapperPath);
  assert.match(wrapperSource, /"\.agents"/);
  assert.match(wrapperSource, /"memory-pro-openclaw\.json"/);
  assert.match(wrapperSource, /"lancedb-pro"/);
  assert.match(readText(pluginSkillPath), /\.agents\/memory\/memory-pro-openclaw\.json/);

  {
    const { transcriptPath } = makeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "不要修改 superpowers 的 hooks，不同工具之间能力不应该混淆。" }],
        },
      },
    ]);
    const output = invokeHook({
      transcriptPath,
      lastAssistantMessage: "我会把这条约束作为后续实现决策保存下来。",
      cwd: repoRoot,
    });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /memory-distill/);
    assert.match(output.reason, /不要修改 superpowers 的 hooks/);
  }

  {
    const { transcriptPath } = makeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "目前仍然无法访问内网域名，帮我看下原因" }],
        },
      },
    ]);
    const output = invokeHook({
      transcriptPath,
      lastAssistantMessage:
        "原因已经定位。根因是运行中的 core 未加载最新 DNS 策略；重启 Clash Party 后 nameserver-policy 生效，captain.release.ctripcorp.com 恢复解析到 10.58.131.112，并且 curl 直连返回 HTTP/1.1 200 OK。",
      cwd: repoRoot,
    });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /memory-distill/);
    assert.match(output.reason, /根因是运行中的 core 未加载最新 DNS 策略/);
  }

  {
    const { transcriptPath } = makeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "请记住以后默认用中文回答" }],
        },
      },
    ]);
    const output = invokeHook({
      transcriptPath,
      lastAssistantMessage: "我会把这个偏好记住。",
      cwd: repoRoot,
    });
    assert.equal(output.decision, "block");
    assert.match(output.reason, /memory-distill/);
    assert.match(output.reason, /默认用中文回答/);
  }

  {
    const { transcriptPath } = makeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "今天天气怎么样" }],
        },
      },
    ]);
    const output = invokeHook({
      transcriptPath,
      lastAssistantMessage: "今天上海多云，气温适中。",
      cwd: repoRoot,
    });
    assert.equal(output.continue, true);
    assert.equal("decision" in output, false);
  }

  {
    const { transcriptPath } = makeTranscript([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "不要修改 superpowers 的 hooks，不同工具之间能力不应该混淆。" }],
        },
      },
    ]);
    const output = invokeHook({
      transcriptPath,
      lastAssistantMessage: "我会把这条约束作为后续实现决策保存下来。",
      cwd: repoRoot,
      stopHookActive: true,
    });
    assert.equal(output.continue, true);
    assert.equal("decision" in output, false);
  }

  console.log("stop-memory-distill tests passed");
}

main();
