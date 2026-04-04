#!/usr/bin/env node

import fs from "node:fs";

const RULE_PATTERNS = [
  /以后默认/,
  /默认用/,
  /始终/,
  /统一/,
  /不要修改/,
  /不应该混淆/,
  /不能混淆/,
  /约定/,
  /规则/,
  /作为.*公共.*存储/,
  /记住/,
];
const DEBUG_USER_PATTERN = /(无法|不可达|报错|问题|原因|排查|修复|恢复|访问|失败|bug)/i;
const DEBUG_ASSISTANT_PATTERN =
  /(根因|原因已经定位|结论|恢复解析|重启.+后|HTTP\/1\.1 200 OK|验证结果|可直连访问|恢复访问)/i;
const EXPLICIT_MEMORY_PATTERN = /(记住|写入记忆|memory-pro|remember)/i;

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function normalizeText(value) {
  return String(value || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextParts(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts;
}

function parseTranscript(transcriptPath) {
  const messages = [];
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return messages;
  }

  const lines = fs.readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "response_item" && entry?.payload?.type === "message") {
        const role = entry.payload.role;
        const text = normalizeText(extractTextParts(entry.payload.content).join("\n"));
        if (role && text) {
          messages.push({ role, text });
        }
        continue;
      }

      if (entry?.type === "event_msg" && entry?.payload?.type === "agent_message") {
        const text = normalizeText(entry.payload.message || "");
        if (text) {
          messages.push({ role: "assistant", text });
        }
      }
    } catch {
      // Ignore malformed transcript lines rather than blocking completion.
    }
  }

  return messages;
}

function findRuleCandidate(userTexts) {
  for (let idx = userTexts.length - 1; idx >= 0; idx -= 1) {
    const text = normalizeText(userTexts[idx]);
    if (text.length < 8 || text.length > 220) {
      continue;
    }
    if (RULE_PATTERNS.some((pattern) => pattern.test(text))) {
      return `用户明确给出了可复用规则：${text}`;
    }
  }
  return null;
}

function findExplicitRememberCandidate(userTexts, assistantText) {
  if (!assistantText) {
    return null;
  }
  for (let idx = userTexts.length - 1; idx >= 0; idx -= 1) {
    const text = normalizeText(userTexts[idx]);
    if (EXPLICIT_MEMORY_PATTERN.test(text)) {
      return `用户明确要求处理长期记忆，相关结果是：${assistantText.slice(0, 220)}`;
    }
  }
  return null;
}

function compactAssistantSummary(text) {
  return normalizeText(text)
    .replace(/^.*?(原因已经定位|根因|结论)/, "$1")
    .slice(0, 240);
}

function findDebugCandidate(userTexts, assistantText) {
  if (!assistantText || !DEBUG_ASSISTANT_PATTERN.test(assistantText)) {
    return null;
  }
  if (!userTexts.some((text) => DEBUG_USER_PATTERN.test(text))) {
    return null;
  }
  return `本轮产出了可复用排障结论：${compactAssistantSummary(assistantText)}`;
}

function buildContinuationReason(candidate) {
  return `Use \`memory-distill\` only if this turn created durable context. ${candidate}`;
}

function main() {
  try {
    const input = JSON.parse(readStdin() || "{}");
    if (input.hook_event_name && input.hook_event_name !== "Stop") {
      reply({ continue: true });
      return;
    }
    if (input.stop_hook_active) {
      reply({ continue: true });
      return;
    }

    const messages = parseTranscript(input.transcript_path);
    const userTexts = messages.filter((msg) => msg.role === "user").map((msg) => msg.text);
    const assistantText = normalizeText(input.last_assistant_message || "");

    const candidate =
      findRuleCandidate(userTexts) ||
      findExplicitRememberCandidate(userTexts, assistantText) ||
      findDebugCandidate(userTexts, assistantText);

    if (!candidate) {
      reply({ continue: true });
      return;
    }

    reply({
      decision: "block",
      reason: buildContinuationReason(candidate),
    });
  } catch (error) {
    reply({
      continue: true,
      stopReason: error instanceof Error ? error.message : String(error),
    });
  }
}

main();
