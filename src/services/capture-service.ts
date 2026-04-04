import type { Embedder } from "../embedder.js";
import { buildSmartMetadata, stringifySmartMetadata } from "../smart-metadata.js";
import type { SmartExtractor } from "../smart-extractor.js";
import { isUserMdExclusiveMemory, type WorkspaceBoundaryConfig } from "../workspace-boundary.js";
import type { MemoryService, ServiceLogger } from "./memory-service.js";

const AUTO_CAPTURE_INBOUND_META_SENTINELS = [
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

const AUTO_CAPTURE_SESSION_RESET_PREFIX =
  "A new session was started via /new or /reset. Execute your Session Startup sequence now";
const AUTO_CAPTURE_ADDRESSING_PREFIX_RE = /^(?:<@!?[0-9]+>|@[A-Za-z0-9_.-]+)\s*/;
const AUTO_CAPTURE_MAP_MAX_ENTRIES = 2000;
const AUTO_CAPTURE_EXPLICIT_REMEMBER_RE =
  /^(?:请|請)?(?:记住|記住|记一下|記一下|别忘了|別忘了)[。.!?？!]*$/u;

const MEMORY_TRIGGERS = [
  /zapamatuj si|pamatuj|remember/i,
  /preferuji|radši|nechci|prefer/i,
  /rozhodli jsme|budeme používat/i,
  /\b(we )?decided\b|we'?ll use|we will use|switch(ed)? to|migrate(d)? to|going forward|from now on/i,
  /\+\d{10,}/,
  /[\w.-]+@[\w.-]+\.\w+/,
  /můj\s+\w+\s+je|je\s+můj/i,
  /my\s+\w+\s+is|is\s+my/i,
  /i (like|prefer|hate|love|want|need|care)/i,
  /always|never|important/i,
  /記住|记住|記一下|记一下|別忘了|别忘了|備註|备注/,
  /偏好|喜好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/,
  /決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用/,
  /我的\S+是|叫我|稱呼|称呼/,
  /老是|講不聽|總是|总是|從不|从不|一直|每次都/,
  /重要|關鍵|关键|注意|千萬別|千万别/,
  /幫我|筆記|存檔|存起來|存一下|重點|原則|底線/,
] as const;

const CAPTURE_EXCLUDE_PATTERNS = [
  /\b(memory-pro|memory_store|memory_recall|memory_forget|memory_update)\b/i,
  /\bopenclaw\s+memory-pro\b/i,
  /\b(delete|remove|forget|purge|cleanup|clean up|clear)\b.*\b(memory|memories|entry|entries)\b/i,
  /\b(memory|memories)\b.*\b(delete|remove|forget|purge|cleanup|clean up|clear)\b/i,
  /\bhow do i\b.*\b(delete|remove|forget|purge|cleanup|clear)\b/i,
  /(删除|刪除|清理|清除).{0,12}(记忆|記憶|memory)/i,
] as const;

type MessageBlock = Record<string, unknown>;
type AgentEndMessage = Record<string, unknown>;

function sanitizeForContext(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/</g, "\uFF1C")
    .replace(/>/g, "\uFF1E")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function summarizeCaptureDecision(text: string, isNoise: (text: string) => boolean): string {
  const trimmed = text.trim();
  const preview = sanitizeForContext(trimmed).slice(0, 120);
  return `len=${trimmed.length}, trigger=${shouldCapture(trimmed) ? "Y" : "N"}, noise=${isNoise(trimmed) ? "Y" : "N"}, preview=${JSON.stringify(preview)}`;
}

function isAutoCaptureInboundMetaSentinelLine(line: string): boolean {
  const trimmed = line.trim();
  return AUTO_CAPTURE_INBOUND_META_SENTINELS.some((sentinel) => sentinel === trimmed);
}

function stripLeadingInboundMetadata(text: string, logger?: ServiceLogger): string {
  if (!text || !AUTO_CAPTURE_INBOUND_META_SENTINELS.some((sentinel) => text.includes(sentinel))) {
    return text;
  }

  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length && lines[index].trim() === "") {
    index++;
  }

  while (index < lines.length && isAutoCaptureInboundMetaSentinelLine(lines[index])) {
    index++;
    if (index < lines.length && lines[index].trim() === "```json") {
      index++;
      while (index < lines.length && lines[index].trim() !== "```") {
        index++;
      }
      if (index < lines.length && lines[index].trim() === "```") {
        index++;
      }
    } else {
      logger?.debug?.(
        `memory-lancedb-pro: stripLeadingInboundMetadata: sentinel line not followed by json fenced block at line ${index}, returning original text`,
      );
      return text;
    }

    while (index < lines.length && lines[index].trim() === "") {
      index++;
    }
  }

  return lines.slice(index).join("\n").trim();
}

function pruneMapIfOver<K, V>(map: Map<K, V>, maxEntries: number): void {
  if (map.size <= maxEntries) return;
  const excess = map.size - maxEntries;
  const iter = map.keys();
  for (let i = 0; i < excess; i++) {
    const key = iter.next().value;
    if (key !== undefined) map.delete(key);
  }
}

function stripAutoCaptureSessionResetPrefix(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith(AUTO_CAPTURE_SESSION_RESET_PREFIX)) {
    return trimmed;
  }

  const blankLineIndex = trimmed.indexOf("\n\n");
  if (blankLineIndex >= 0) {
    return trimmed.slice(blankLineIndex + 2).trim();
  }

  const lines = trimmed.split("\n");
  if (lines.length <= 2) {
    return "";
  }
  return lines.slice(2).join("\n").trim();
}

function stripAutoCaptureAddressingPrefix(text: string): string {
  return text.replace(AUTO_CAPTURE_ADDRESSING_PREFIX_RE, "").trim();
}

function shouldSkipReflectionMessage(role: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith("/")) return true;

  if (role === "user") {
    if (
      trimmed.includes("<relevant-memories>") ||
      trimmed.includes("UNTRUSTED DATA") ||
      trimmed.includes("END UNTRUSTED DATA")
    ) {
      return true;
    }
  }

  return false;
}

function stripAutoCaptureInjectedPrefix(role: string, text: string, logger?: ServiceLogger): string {
  if (role !== "user") {
    return text.trim();
  }

  let normalized = text.trim();
  normalized = normalized.replace(/^<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/i, "");
  normalized = normalized.replace(
    /^\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/i,
    "",
  );
  normalized = stripAutoCaptureSessionResetPrefix(normalized);
  normalized = stripLeadingInboundMetadata(normalized, logger);
  normalized = stripAutoCaptureAddressingPrefix(normalized);
  return normalized.trim();
}

export function normalizeAutoCaptureText(
  role: unknown,
  text: string,
  logger?: ServiceLogger,
): string | null {
  if (typeof role !== "string") return null;
  const normalized = stripAutoCaptureInjectedPrefix(role, text, logger);
  if (!normalized) return null;
  if (shouldSkipReflectionMessage(role, normalized)) return null;
  return normalized;
}

function buildAutoCaptureConversationKeyFromIngress(
  channelId: string | undefined,
  conversationId: string | undefined,
): string | null {
  const channel = typeof channelId === "string" ? channelId.trim() : "";
  const conversation = typeof conversationId === "string" ? conversationId.trim() : "";
  if (!channel || !conversation) return null;
  return `${channel}:${conversation}`;
}

function buildAutoCaptureConversationKeyFromSessionKey(sessionKey: string): string | null {
  const trimmed = sessionKey.trim();
  if (!trimmed) return null;
  const match = /^agent:[^:]+:(.+)$/.exec(trimmed);
  const suffix = match?.[1]?.trim();
  return suffix || null;
}

function isExplicitRememberCommand(text: string): boolean {
  return AUTO_CAPTURE_EXPLICIT_REMEMBER_RE.test(text.trim());
}

function collectTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((block): block is MessageBlock => Boolean(block) && typeof block === "object")
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
}

export function shouldCapture(text: string): boolean {
  let s = text.trim();

  const metadataPattern = /^(Conversation info|Sender) \(untrusted metadata\):[\s\S]*?\n\s*\n/gim;
  s = s.replace(metadataPattern, "");

  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(s);
  const minLen = hasCJK ? 4 : 10;
  if (s.length < minLen || s.length > 500) {
    return false;
  }
  if (s.includes("<relevant-memories>")) {
    return false;
  }
  if (s.startsWith("<") && s.includes("</")) {
    return false;
  }
  if (s.includes("**") && s.includes("\n-")) {
    return false;
  }
  const emojiCount = (s.match(/[\u{1F300}-\u{1F9FF}]/gu) || []).length;
  if (emojiCount > 3) {
    return false;
  }
  if (CAPTURE_EXCLUDE_PATTERNS.some((pattern) => pattern.test(s))) {
    return false;
  }

  return MEMORY_TRIGGERS.some((pattern) => pattern.test(s));
}

export function detectCategory(
  text: string,
): "preference" | "fact" | "decision" | "entity" | "other" {
  const lower = text.toLowerCase();
  if (
    /prefer|radši|like|love|hate|want|偏好|喜歡|喜欢|討厭|讨厌|不喜歡|不喜欢|愛用|爱用|習慣|习惯/i.test(
      lower,
    )
  ) {
    return "preference";
  }
  if (
    /rozhodli|decided|we decided|will use|we will use|we'?ll use|switch(ed)? to|migrate(d)? to|going forward|from now on|budeme|決定|决定|選擇了|选择了|改用|換成|换成|以後用|以后用|規則|流程|SOP/i.test(
      lower,
    )
  ) {
    return "decision";
  }
  if (
    /\+\d{10,}|@[\w.-]+\.\w+|is called|jmenuje se|我的\S+是|叫我|稱呼|称呼/i.test(
      lower,
    )
  ) {
    return "entity";
  }
  if (/\b(is|are|has|have|je|má|jsou)\b|總是|总是|從不|从不|一直|每次都|老是/i.test(lower)) {
    return "fact";
  }
  return "other";
}

type MemoryServiceLike = Pick<MemoryService, "findNearDuplicates" | "storeMemory">;
type EmbedderLike = Pick<Embedder, "embedPassage">;
type SmartExtractorLike = Pick<SmartExtractor, "filterNoiseByEmbedding" | "extractAndPersist">;

export interface CaptureServiceDeps {
  memoryService: MemoryServiceLike;
  embedder: EmbedderLike;
  smartExtractor?: SmartExtractorLike | null;
  workspaceBoundary?: WorkspaceBoundaryConfig;
  captureAssistant?: boolean;
  extractMinMessages?: number;
  logger?: ServiceLogger;
  isNoise?: (text: string) => boolean;
}

export function createCaptureService(deps: CaptureServiceDeps) {
  const autoCaptureSeenTextCount = new Map<string, number>();
  const autoCapturePendingIngressTexts = new Map<string, string[]>();
  const autoCaptureRecentTexts = new Map<string, string[]>();
  const isNoise = deps.isNoise ?? (() => false);

  return {
    recordIngressMessage(params: {
      channelId?: string;
      conversationId?: string;
      content: string;
    }): void {
      const conversationKey = buildAutoCaptureConversationKeyFromIngress(
        params.channelId,
        params.conversationId,
      );
      const normalized = normalizeAutoCaptureText("user", params.content, deps.logger);
      if (conversationKey && normalized) {
        const queue = autoCapturePendingIngressTexts.get(conversationKey) || [];
        queue.push(normalized);
        autoCapturePendingIngressTexts.set(conversationKey, queue.slice(-6));
        pruneMapIfOver(autoCapturePendingIngressTexts, AUTO_CAPTURE_MAP_MAX_ENTRIES);
      }
    },

    collectAgentEndTexts(params: {
      sessionKey: string;
      messages: unknown[];
      captureAssistant?: boolean;
    }): {
      texts: string[];
      eligibleTexts: string[];
      pendingIngressTexts: string[];
      skippedAutoCaptureTexts: number;
    } {
      const captureAssistant = params.captureAssistant ?? deps.captureAssistant === true;
      const eligibleTexts: string[] = [];
      let skippedAutoCaptureTexts = 0;

      for (const msg of params.messages) {
        if (!msg || typeof msg !== "object") continue;
        const msgObj = msg as AgentEndMessage;
        const role = msgObj.role;
        if (role !== "user" && !(captureAssistant && role === "assistant")) {
          continue;
        }

        const contentTexts = collectTextBlocks(msgObj.content);
        for (const text of contentTexts) {
          const normalized = normalizeAutoCaptureText(role, text, deps.logger);
          if (!normalized) {
            skippedAutoCaptureTexts++;
          } else {
            eligibleTexts.push(normalized);
          }
        }
      }

      const conversationKey = buildAutoCaptureConversationKeyFromSessionKey(params.sessionKey);
      const pendingIngressTexts = conversationKey
        ? [...(autoCapturePendingIngressTexts.get(conversationKey) || [])]
        : [];
      if (conversationKey) {
        autoCapturePendingIngressTexts.delete(conversationKey);
      }

      const previousSeenCount = autoCaptureSeenTextCount.get(params.sessionKey) ?? 0;
      let newTexts = eligibleTexts;
      if (pendingIngressTexts.length > 0) {
        newTexts = pendingIngressTexts;
      } else if (previousSeenCount > 0 && eligibleTexts.length > previousSeenCount) {
        newTexts = eligibleTexts.slice(previousSeenCount);
      }
      autoCaptureSeenTextCount.set(params.sessionKey, eligibleTexts.length);
      pruneMapIfOver(autoCaptureSeenTextCount, AUTO_CAPTURE_MAP_MAX_ENTRIES);

      const priorRecentTexts = autoCaptureRecentTexts.get(params.sessionKey) || [];
      let texts = newTexts;
      if (
        texts.length === 1 &&
        isExplicitRememberCommand(texts[0]) &&
        priorRecentTexts.length > 0
      ) {
        texts = [...priorRecentTexts.slice(-1), ...texts];
      }
      if (newTexts.length > 0) {
        const nextRecentTexts = [...priorRecentTexts, ...newTexts].slice(-6);
        autoCaptureRecentTexts.set(params.sessionKey, nextRecentTexts);
        pruneMapIfOver(autoCaptureRecentTexts, AUTO_CAPTURE_MAP_MAX_ENTRIES);
      }

      return {
        texts,
        eligibleTexts,
        pendingIngressTexts,
        skippedAutoCaptureTexts,
      };
    },

    async processAgentEnd(params: {
      messages: unknown[];
      agentId: string;
      sessionKey: string;
      accessibleScopes?: string[];
      defaultScope: string;
    }): Promise<void> {
      const minMessages = deps.extractMinMessages ?? 2;
      const {
        texts,
        eligibleTexts,
        pendingIngressTexts,
        skippedAutoCaptureTexts,
      } = this.collectAgentEndTexts({
        sessionKey: params.sessionKey,
        messages: params.messages,
      });

      if (skippedAutoCaptureTexts > 0) {
        deps.logger?.debug?.(
          `memory-lancedb-pro: auto-capture skipped ${skippedAutoCaptureTexts} injected/system text block(s) for agent ${params.agentId}`,
        );
      }
      if (pendingIngressTexts.length > 0) {
        deps.logger?.debug?.(
          `memory-lancedb-pro: auto-capture using ${pendingIngressTexts.length} pending ingress text(s) for agent ${params.agentId}`,
        );
      }
      if (texts.length !== eligibleTexts.length) {
        deps.logger?.debug?.(
          `memory-lancedb-pro: auto-capture narrowed ${eligibleTexts.length} eligible history text(s) to ${texts.length} new text(s) for agent ${params.agentId}`,
        );
      }
      deps.logger?.debug?.(
        `memory-lancedb-pro: auto-capture collected ${texts.length} text(s) for agent ${params.agentId} (minMessages=${minMessages}, smartExtraction=${deps.smartExtractor ? "on" : "off"})`,
      );
      if (texts.length === 0) {
        deps.logger?.debug?.(
          `memory-lancedb-pro: auto-capture found no eligible texts after filtering for agent ${params.agentId}`,
        );
        return;
      }

      deps.logger?.debug?.(
        `memory-lancedb-pro: auto-capture text diagnostics for agent ${params.agentId}: ${texts.map((text, idx) => `#${idx + 1}(${summarizeCaptureDecision(text, isNoise)})`).join(" | ")}`,
      );

      if (deps.smartExtractor) {
        const cleanTexts = await deps.smartExtractor.filterNoiseByEmbedding(texts);
        if (cleanTexts.length === 0) {
          deps.logger?.debug?.(
            `memory-lancedb-pro: all texts filtered as embedding noise for agent ${params.agentId}`,
          );
          return;
        }

        if (cleanTexts.length >= minMessages) {
          deps.logger?.debug?.(
            `memory-lancedb-pro: auto-capture running smart extraction for agent ${params.agentId} (${cleanTexts.length} clean texts >= ${minMessages})`,
          );
          const conversationText = cleanTexts.join("\n");
          const stats = await deps.smartExtractor.extractAndPersist(
            conversationText,
            params.sessionKey,
            { scope: params.defaultScope, scopeFilter: params.accessibleScopes },
          );
          if (stats.created > 0 || stats.merged > 0) {
            deps.logger?.info?.(
              `memory-lancedb-pro: smart-extracted ${stats.created} created, ${stats.merged} merged, ${stats.skipped} skipped for agent ${params.agentId}`,
            );
            return;
          }

          if ((stats.boundarySkipped ?? 0) > 0) {
            deps.logger?.info?.(
              `memory-lancedb-pro: smart extraction skipped ${stats.boundarySkipped} USER.md-exclusive candidate(s) for agent ${params.agentId}; continuing to regex fallback for non-boundary texts`,
            );
          }

          deps.logger?.info?.(
            `memory-lancedb-pro: smart extraction produced no persisted memories for agent ${params.agentId} (created=${stats.created}, merged=${stats.merged}, skipped=${stats.skipped}); falling back to regex capture`,
          );
        } else {
          deps.logger?.debug?.(
            `memory-lancedb-pro: auto-capture skipped smart extraction for agent ${params.agentId} (${cleanTexts.length} < ${minMessages})`,
          );
        }
      }

      deps.logger?.debug?.(
        `memory-lancedb-pro: auto-capture running regex fallback for agent ${params.agentId}`,
      );

      const toCapture = texts.filter((text) => text && shouldCapture(text) && !isNoise(text));
      if (toCapture.length === 0) {
        deps.logger?.debug?.(
          `memory-lancedb-pro: regex fallback diagnostics for agent ${params.agentId}: ${texts.map((text, idx) => `#${idx + 1}(${summarizeCaptureDecision(text, isNoise)})`).join(" | ")}`,
        );
        deps.logger?.info?.(
          `memory-lancedb-pro: regex fallback found 0 capturable texts for agent ${params.agentId}`,
        );
        return;
      }

      deps.logger?.info?.(
        `memory-lancedb-pro: regex fallback found ${toCapture.length} capturable text(s) for agent ${params.agentId}`,
      );

      let stored = 0;
      for (const text of toCapture.slice(0, 3)) {
        if (isUserMdExclusiveMemory({ text }, deps.workspaceBoundary)) {
          deps.logger?.info?.(
            `memory-lancedb-pro: skipped USER.md-exclusive auto-capture text for agent ${params.agentId}`,
          );
          continue;
        }

        const category = detectCategory(text);
        const vector = await deps.embedder.embedPassage(text);

        let existing: Array<{ score: number }> = [];
        try {
          existing = await deps.memoryService.findNearDuplicates(vector, params.defaultScope);
        } catch (err) {
          deps.logger?.warn?.(
            `memory-lancedb-pro: auto-capture duplicate pre-check failed, continue store: ${String(err)}`,
          );
        }

        if (existing.length > 0 && existing[0].score > 0.95) {
          continue;
        }

        await deps.memoryService.storeMemory(
          {
            text,
            vector,
            importance: 0.7,
            category,
            scope: params.defaultScope,
            metadata: stringifySmartMetadata(
              buildSmartMetadata(
                { text, category, importance: 0.7 },
                {
                  l0_abstract: text,
                  l1_overview: `- ${text}`,
                  l2_content: text,
                  source_session: params.sessionKey || "unknown",
                },
              ),
            ),
          },
          { source: "auto-capture", agentId: params.agentId },
        );
        stored++;
      }

      if (stored > 0) {
        deps.logger?.info?.(
          `memory-lancedb-pro: auto-captured ${stored} memories for agent ${params.agentId} in scope ${params.defaultScope}`,
        );
      }
    },
  };
}

export type CaptureService = ReturnType<typeof createCaptureService>;
