/**
 * CLI Commands for Memory Management
 */

import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as readline from "node:readline";
import JSON5 from "json5";
import { createDecayEngine } from "./src/decay-engine.js";
import { loadLanceDB, type MemoryEntry, type MemoryStore } from "./src/store.js";
import { createRetriever, type MemoryRetriever, type RetrievalResult } from "./src/retriever.js";
import type { MemoryScopeManager } from "./src/scopes.js";
import type { MemoryMigrator } from "./src/migrate.js";
import { createMemoryUpgrader } from "./src/memory-upgrader.js";
import type { LlmClient } from "./src/llm-client.js";
import { TEMPORAL_VERSIONED_CATEGORIES } from "./src/memory-categories.js";
import {
  appendRelation,
  buildSmartMetadata,
  deriveFactKey,
  parseSmartMetadata,
  stringifySmartMetadata,
} from "./src/smart-metadata.js";
import { createMemoryService } from "./src/services/memory-service.js";
import { createRecallService, MAX_RECALL_QUERY_LENGTH } from "./src/services/recall-service.js";
import { createTierManager } from "./src/tier-manager.js";
import {
  getDefaultOauthModelForProvider,
  getOAuthProviderLabel,
  isOauthModelSupported,
  listOAuthProviders,
  normalizeOauthModel,
  normalizeOAuthProviderId,
  performOAuthLogin,
} from "./src/llm-oauth.js";

// ============================================================================
// Types
// ============================================================================

interface CLIContext {
  store: MemoryStore;
  retriever: MemoryRetriever;
  scopeManager: MemoryScopeManager;
  migrator: MemoryMigrator;
  embedder?: import("./src/embedder.js").Embedder;
  llmClient?: LlmClient;
  pluginId?: string;
  pluginConfig?: Record<string, unknown>;
  oauthTestHooks?: {
    openUrl?: (url: string) => void | Promise<void>;
    authorizeUrl?: (url: string) => void | Promise<void>;
    chooseProvider?: (
      providers: Array<{ id: string; label: string; defaultModel: string }>,
      currentProviderId: string,
    ) => string | Promise<string>;
  };
}

const STORE_CATEGORIES = [
  "preference",
  "fact",
  "decision",
  "entity",
  "other",
  "reflection",
] as const;

// ============================================================================
// Utility Functions
// ============================================================================

function getPluginVersion(): string {
  try {
    const pkgUrl = new URL("./package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function clampInt(value: number, min: number, max: number): number {
  const n = Number.isFinite(value) ? value : min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function clamp01(value: number, fallback = 0.7): number {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

function resolveOpenClawConfigPath(explicit?: string): string {
  const openclawHome = resolveOpenClawHome();
  if (explicit && explicit.trim()) {
    return path.resolve(explicit.trim());
  }

  const fromEnv = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (fromEnv) {
    return path.resolve(fromEnv);
  }

  return path.join(openclawHome, "openclaw.json");
}

function resolveOpenClawHome(): string {
  return process.env.OPENCLAW_HOME?.trim()
    ? path.resolve(process.env.OPENCLAW_HOME.trim())
    : path.join(homedir(), ".openclaw");
}

function resolveDefaultOauthPath(): string {
  return path.join(resolveOpenClawHome(), ".memory-lancedb-pro", "oauth.json");
}

function resolveLoginOauthPath(rawPath: unknown): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  const candidate = trimmed || resolveDefaultOauthPath();
  return path.resolve(candidate);
}

function resolveConfiguredOauthPath(configPath: string, rawPath: unknown): string {
  const trimmed = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!trimmed) {
    return resolveDefaultOauthPath();
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  return path.resolve(path.dirname(configPath), trimmed);
}

type RestorableApiKeyLlmConfig = {
  auth?: "api-key";
  apiKey?: string;
  model?: string;
  baseURL?: string;
  timeoutMs?: number;
};

type OAuthLlmBackup = {
  version: 1;
  hadLlmConfig: boolean;
  llm: RestorableApiKeyLlmConfig;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOauthLlmConfig(value: unknown): boolean {
  return isPlainObject(value) && value.auth === "oauth";
}

function extractRestorableApiKeyLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: RestorableApiKeyLlmConfig = {};
  if (value.auth === "api-key") {
    result.auth = "api-key";
  }
  if (typeof value.apiKey === "string") {
    result.apiKey = value.apiKey;
  }
  if (typeof value.model === "string") {
    result.model = value.model;
  }
  if (typeof value.baseURL === "string") {
    result.baseURL = value.baseURL;
  }
  if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    result.timeoutMs = Math.trunc(value.timeoutMs);
  }
  return result;
}

function extractOauthSafeLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: RestorableApiKeyLlmConfig = {};
  if (typeof value.baseURL === "string") {
    result.baseURL = value.baseURL;
  }
  if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
    result.timeoutMs = Math.trunc(value.timeoutMs);
  }
  return result;
}

function hasRestorableApiKeyLlmConfig(value: RestorableApiKeyLlmConfig): boolean {
  return Object.keys(value).length > 0;
}

function buildLogoutFallbackLlmConfig(value: unknown): RestorableApiKeyLlmConfig {
  if (isOauthLlmConfig(value)) {
    return extractOauthSafeLlmConfig(value);
  }
  return extractRestorableApiKeyLlmConfig(value);
}

function getOauthBackupPath(oauthPath: string): string {
  const parsed = path.parse(oauthPath);
  const fileName = parsed.ext
    ? `${parsed.name}.llm-backup${parsed.ext}`
    : `${parsed.base}.llm-backup.json`;
  return path.join(parsed.dir, fileName);
}

async function saveOauthLlmBackup(oauthPath: string, llm: unknown, hadLlmConfig: boolean): Promise<void> {
  const backupPath = getOauthBackupPath(oauthPath);
  const payload: OAuthLlmBackup = {
    version: 1,
    hadLlmConfig,
    llm: extractRestorableApiKeyLlmConfig(llm),
  };
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

async function loadOauthLlmBackup(oauthPath: string): Promise<OAuthLlmBackup | null> {
  const backupPath = getOauthBackupPath(oauthPath);
  try {
    const raw = await readFile(backupPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.hadLlmConfig !== "boolean") {
      return null;
    }
    return {
      version: 1,
      hadLlmConfig: parsed.hadLlmConfig,
      llm: extractRestorableApiKeyLlmConfig(parsed.llm),
    };
  } catch {
    return null;
  }
}

const OAUTH_PROVIDER_CHOICES = listOAuthProviders()
  .map((provider) => `${provider.id} (${provider.label})`)
  .join(", ");

function pickOauthProvider(currentProvider: string | undefined, overrideProvider: string | undefined): {
  providerId: string;
  source: "override" | "config" | "default";
} {
  if (overrideProvider && overrideProvider.trim()) {
    return { providerId: normalizeOAuthProviderId(overrideProvider), source: "override" };
  }

  if (currentProvider && currentProvider.trim()) {
    try {
      return { providerId: normalizeOAuthProviderId(currentProvider), source: "config" };
    } catch {
      // Fall back to the default provider when the saved config is stale or invalid.
    }
  }

  return { providerId: normalizeOAuthProviderId(), source: "default" };
}

async function promptOauthProviderSelection(
  currentProviderId: string,
  testHook?: CLIContext["oauthTestHooks"]["chooseProvider"],
): Promise<{ providerId: string; source: "prompt" | "default" }> {
  const providers = listOAuthProviders();
  if (providers.length === 0) {
    throw new Error("No OAuth providers are available.");
  }

  if (testHook) {
    const selected = await testHook(providers, currentProviderId);
    return { providerId: normalizeOAuthProviderId(selected), source: "prompt" };
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return { providerId: currentProviderId, source: "default" };
  }

  let selectedIndex = providers.findIndex((provider) => provider.id === currentProviderId);
  if (selectedIndex < 0) selectedIndex = 0;

  readline.emitKeypressEvents(process.stdin);
  const canSetRawMode = typeof process.stdin.setRawMode === "function";
  const previousRawMode = canSetRawMode ? !!process.stdin.isRaw : false;
  const menuLines = 2 + providers.length;
  let hasRendered = false;

  const render = () => {
    if (hasRendered) {
      readline.moveCursor(process.stdout, 0, -menuLines);
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
    } else {
      process.stdout.write("\n");
      hasRendered = true;
    }

    process.stdout.write("Select OAuth provider\n");
    process.stdout.write("Use arrow keys and Enter.\n");
    providers.forEach((provider, index) => {
      const marker = index === selectedIndex ? ">" : " ";
      process.stdout.write(
        `${marker} ${provider.label} (${provider.id}) [default model: ${provider.defaultModel}]\n`,
      );
    });
  };

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
      if (canSetRawMode) {
        process.stdin.setRawMode(previousRawMode);
      }
      process.stdin.pause();
      process.stdout.write("\n");
    };

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "escape") {
        cleanup();
        reject(new Error("OAuth login cancelled while selecting a provider."));
        return;
      }

      if (key.name === "up" || key.name === "left") {
        selectedIndex = (selectedIndex - 1 + providers.length) % providers.length;
        render();
        return;
      }

      if (key.name === "down" || key.name === "right") {
        selectedIndex = (selectedIndex + 1) % providers.length;
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        const provider = providers[selectedIndex];
        cleanup();
        resolve({ providerId: provider.id, source: "prompt" });
      }
    };

    render();
    process.stdin.on("keypress", onKeypress);
    process.stdin.resume();
    if (canSetRawMode) {
      process.stdin.setRawMode(true);
    }
  });
}

async function resolveOauthProviderSelection(
  currentProvider: string | undefined,
  overrideProvider: string | undefined,
  chooseProviderHook?: CLIContext["oauthTestHooks"]["chooseProvider"],
): Promise<{ providerId: string; source: "override" | "config" | "default" | "prompt" }> {
  if (overrideProvider && overrideProvider.trim()) {
    return pickOauthProvider(currentProvider, overrideProvider);
  }

  const initial = pickOauthProvider(currentProvider, undefined);
  return await promptOauthProviderSelection(initial.providerId, chooseProviderHook);
}

function pickOauthModel(
  providerId: string,
  currentModel: string | undefined,
  overrideModel: string | undefined,
): { model: string; source: "override" | "config" | "default" } {
  if (overrideModel && overrideModel.trim()) {
    if (!isOauthModelSupported(providerId, overrideModel)) {
      throw new Error(
        `Model "${overrideModel}" is not supported for OAuth provider ${providerId}. Use a compatible model such as ${getDefaultOauthModelForProvider(providerId)}.`,
      );
    }
    return { model: overrideModel.trim(), source: "override" };
  }

  if (isOauthModelSupported(providerId, currentModel)) {
    return { model: currentModel!.trim(), source: "config" };
  }

  return { model: getDefaultOauthModelForProvider(providerId), source: "default" };
}

async function loadOpenClawConfig(configPath: string): Promise<Record<string, any>> {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON5.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid OpenClaw config at ${configPath}: expected object`);
  }
  return parsed as Record<string, any>;
}

function ensurePluginConfigRoot(config: Record<string, any>, pluginId: string): Record<string, any> {
  config.plugins ||= {};
  config.plugins.entries ||= {};
  config.plugins.entries[pluginId] ||= { enabled: true, config: {} };
  const entry = config.plugins.entries[pluginId];
  entry.enabled = true;
  entry.config ||= {};
  return entry.config as Record<string, any>;
}

async function saveOpenClawConfig(configPath: string, config: Record<string, any>): Promise<void> {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function formatMemory(memory: any, index?: number): string {
  const prefix = index !== undefined ? `${index + 1}. ` : "";
  const id = memory?.id ? String(memory.id) : "unknown";
  const date = new Date(memory.timestamp || memory.createdAt || Date.now()).toISOString().split('T')[0];
  const fullText = String(memory.text || "");
  const text = fullText.slice(0, 100) + (fullText.length > 100 ? "..." : "");
  return `${prefix}[${id}] [${memory.category}:${memory.scope}] ${text} (${date})`;
}

function formatJson(obj: any): string {
  return JSON.stringify(obj, null, 2);
}

function toScopeFilter(scope?: string): string[] | undefined {
  return scope ? [scope] : undefined;
}

function formatMemoryJson(memory: MemoryEntry) {
  const metadata = parseSmartMetadata(memory.metadata, memory);
  return {
    id: memory.id,
    text: memory.text,
    scope: memory.scope,
    category: memory.category,
    importance: memory.importance,
    timestamp: memory.timestamp,
    memoryCategory: metadata.memory_category || memory.category,
    tier: metadata.tier || null,
  };
}

function formatListJson(
  memories: MemoryEntry[],
  options: {
    scopeFilter?: string[];
    category?: string;
    limit: number;
    offset: number;
  },
) {
  return {
    ok: true,
    action: "list",
    count: memories.length,
    limit: options.limit,
    offset: options.offset,
    scopeFilter: options.scopeFilter ?? null,
    category: options.category ?? null,
    items: memories.map(formatMemoryJson),
  };
}

function formatRecallJson(query: string, results: RetrievalResult[]) {
  return {
    ok: true,
    query,
    count: results.length,
    items: results.map((result) => {
      const metadata = parseSmartMetadata(result.entry.metadata, result.entry);
      return {
        id: result.entry.id,
        text: result.entry.text,
        score: result.score,
        scope: result.entry.scope,
        category: result.entry.category,
        importance: result.entry.importance,
        timestamp: result.entry.timestamp,
        memoryCategory: metadata.memory_category || result.entry.category,
        tier: metadata.tier || null,
      };
    }),
  };
}

function formatDeleteJson(id: string, deleted: boolean, scopeFilter?: string[]) {
  return deleted
    ? {
      ok: true,
      action: "deleted",
      id,
      scopeFilter,
    }
    : {
      ok: false,
      error: "not_found_or_access_denied",
      id,
      scopeFilter,
    };
}

function formatStatsJson(
  summary: {
    memory: {
      totalCount: number;
      scopeCounts: Record<string, number>;
      categoryCounts: Record<string, number>;
    };
    scopes: unknown;
    retrieval: {
      mode: string;
      hasFtsSupport: boolean;
    };
  },
  scopeFilter?: string[],
) {
  return {
    ok: true,
    action: "stats",
    scopeFilter: scopeFilter ?? null,
    ...summary,
  };
}

function formatStoreJson(entry: MemoryEntry) {
  return {
    ok: true,
    action: "created",
    item: formatMemoryJson(entry),
  };
}

function formatUpdateJson(
  entry: MemoryEntry,
  action: "updated" | "superseded",
  fieldsUpdated: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    ok: true,
    action,
    item: formatMemoryJson(entry),
    fieldsUpdated,
    ...extra,
  };
}

function parseCategoryOption(raw?: string): MemoryEntry["category"] | undefined {
  if (!raw) return undefined;
  if ((STORE_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as MemoryEntry["category"];
  }
  throw new Error(
    `Invalid category "${raw}". Expected one of: ${STORE_CATEGORIES.join(", ")}`,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// CLI Command Implementations
// ============================================================================

export function registerMemoryCLI(program: Command, context: CLIContext): void {
  const getSearchRetriever = (): MemoryRetriever => {
    if (!context.embedder) {
      return context.retriever;
    }
    return createRetriever(context.store, context.embedder, context.retriever.getConfig());
  };

  const memoryService = createMemoryService({
    retriever: {
      retrieve(params) {
        return getSearchRetriever().retrieve(params);
      },
      test: context.retriever.test?.bind(context.retriever),
    },
    scopeManager: context.scopeManager,
    store: context.store,
    embedder: context.embedder,
  });
  const recallService = createRecallService({
    memoryService,
    store: context.store,
    decayEngine: createDecayEngine(),
    tierManager: createTierManager(),
  });

  const runSearch = async (
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ) => {
    let results = await getSearchRetriever().retrieve({
      query,
      limit,
      scopeFilter,
      category,
      source: "cli",
    });

    if (results.length === 0 && context.embedder) {
      await sleep(75);
      results = await getSearchRetriever().retrieve({
        query,
        limit,
        scopeFilter,
        category,
        source: "cli",
      });
    }

    return results;
  };

  const memory = program
    .command("memory-pro")
    .description("Enhanced memory management commands (LanceDB Pro)");

  // Version
  memory
    .command("version")
    .description("Print plugin version")
    .action(() => {
      console.log(getPluginVersion());
    });

  const auth = memory
    .command("auth")
    .description("Manage OAuth authentication for smart-extraction LLM access");

  auth
    .command("login")
    .description("Authenticate with ChatGPT/Codex in a browser, save the plugin OAuth file, and switch this plugin to llm.auth=oauth")
    .option("--config <path>", "OpenClaw config file to update")
    .option("--provider <provider>", `OAuth provider to use (${OAUTH_PROVIDER_CHOICES})`)
    .option("--model <model>", "Override the model saved into llm.model")
    .option("--oauth-path <path>", "OAuth file path (default: ~/.openclaw/.memory-lancedb-pro/oauth.json)")
    .option("--timeout <seconds>", "OAuth callback timeout in seconds", "120")
    .option("--no-browser", "Do not auto-open the browser; print the authorization URL only")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "memory-lancedb-pro";
        const currentLlm = context.pluginConfig?.llm;
        const currentProvider = currentLlm && typeof currentLlm === "object" && typeof (currentLlm as any).oauthProvider === "string"
          ? String((currentLlm as any).oauthProvider)
          : undefined;
        const selectedProvider = await resolveOauthProviderSelection(
          currentProvider,
          options.provider,
          context.oauthTestHooks?.chooseProvider,
        );
        const currentModel = currentLlm && typeof currentLlm === "object" && typeof (currentLlm as any).model === "string"
          ? String((currentLlm as any).model)
          : undefined;
        const selectedModel = pickOauthModel(selectedProvider.providerId, currentModel, options.model);
        const oauthModel = normalizeOauthModel(selectedModel.model);
        const configPath = resolveOpenClawConfigPath(options.config);
        const oauthPath = resolveLoginOauthPath(options.oauthPath);
        const timeoutMs = clampInt((parseInt(options.timeout, 10) || 120) * 1000, 15_000, 900_000);

        if (selectedModel.source === "default" && currentModel && currentModel.trim()) {
          console.log(
            `Configured llm.model "${currentModel}" is not supported by provider ${selectedProvider.providerId}. Falling back to ${getDefaultOauthModelForProvider(selectedProvider.providerId)}.`,
          );
        }

        console.log(`Config file: ${configPath}`);
        console.log(`Provider: ${getOAuthProviderLabel(selectedProvider.providerId)} (${selectedProvider.providerId}, ${selectedProvider.source})`);
        console.log(`OAuth file: ${oauthPath}`);
        console.log(`Model: ${oauthModel} (${selectedModel.source})`);

        const { session } = await performOAuthLogin({
          authPath: oauthPath,
          timeoutMs,
          noBrowser: options.browser === false,
          model: selectedModel.model,
          providerId: selectedProvider.providerId,
          onOpenUrl: context.oauthTestHooks?.openUrl,
          onAuthorizeUrl: async (url) => {
            console.log(`Authorization URL: ${url}`);
            await context.oauthTestHooks?.authorizeUrl?.(url);
          },
        });

        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const hadLlmConfig = isPlainObject(pluginConfig.llm);
        const existingLlm = hadLlmConfig ? { ...(pluginConfig.llm as Record<string, unknown>) } : {};
        const wasOauthMode = isOauthLlmConfig(existingLlm);

        if (!wasOauthMode) {
          await saveOauthLlmBackup(oauthPath, pluginConfig.llm, hadLlmConfig);
        }

        const nextLlm = wasOauthMode ? { ...existingLlm } : extractOauthSafeLlmConfig(existingLlm);
        delete nextLlm.apiKey;
        if (!wasOauthMode) {
          delete nextLlm.baseURL;
        }
        pluginConfig.llm = {
          ...nextLlm,
          auth: "oauth",
          oauthProvider: selectedProvider.providerId,
          model: oauthModel,
          oauthPath,
        };
        await saveOpenClawConfig(configPath, openclawConfig);

        console.log(`OAuth login completed for account ${session.accountId}.`);
        console.log(
          `Updated ${pluginId} config: llm.auth=oauth, llm.oauthProvider=${selectedProvider.providerId}, llm.oauthPath=${oauthPath}, llm.model=${oauthModel}`,
        );
      } catch (error) {
        console.error("OAuth login failed:", error);
        process.exit(1);
      }
    });

  auth
    .command("status")
    .description("Show the current OAuth configuration for this plugin")
    .option("--config <path>", "OpenClaw config file to inspect")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "memory-lancedb-pro";
        const configPath = resolveOpenClawConfigPath(options.config);
        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm as Record<string, unknown> : {};
        const oauthProviderRaw = typeof llm.oauthProvider === "string" && llm.oauthProvider.trim()
          ? llm.oauthProvider.trim()
          : normalizeOAuthProviderId();
        let oauthProviderDisplay = `${oauthProviderRaw} (unknown)`;
        try {
          oauthProviderDisplay = `${normalizeOAuthProviderId(oauthProviderRaw)} (${getOAuthProviderLabel(oauthProviderRaw)})`;
        } catch {
          // Leave the raw provider id visible for debugging stale or unsupported configs.
        }
        const oauthPath = resolveConfiguredOauthPath(configPath, llm.oauthPath);

        let tokenInfo = "missing";
        try {
          const session = await readFile(oauthPath, "utf8");
          tokenInfo = session.trim() ? "present" : "empty";
        } catch {
          tokenInfo = "missing";
        }

        console.log(`Config file: ${configPath}`);
        console.log(`Plugin: ${pluginId}`);
        console.log(`llm.auth: ${typeof llm.auth === "string" ? llm.auth : "api-key"}`);
        console.log(`llm.oauthProvider: ${oauthProviderDisplay}`);
        console.log(`llm.model: ${typeof llm.model === "string" ? llm.model : "openai/gpt-oss-120b"}`);
        console.log(`llm.oauthPath: ${oauthPath}`);
        console.log(`oauth file: ${tokenInfo}`);
      } catch (error) {
        console.error("OAuth status failed:", error);
        process.exit(1);
      }
    });

  auth
    .command("logout")
    .description("Delete the plugin OAuth file and switch this plugin back to llm.auth=api-key")
    .option("--config <path>", "OpenClaw config file to update")
    .option("--oauth-path <path>", "OAuth file path to remove")
    .action(async (options) => {
      try {
        const pluginId = context.pluginId || "memory-lancedb-pro";
        const configPath = resolveOpenClawConfigPath(options.config);
        const openclawConfig = await loadOpenClawConfig(configPath);
        const pluginConfig = ensurePluginConfigRoot(openclawConfig, pluginId);
        const llm = typeof pluginConfig.llm === "object" && pluginConfig.llm ? pluginConfig.llm as Record<string, unknown> : {};
        const oauthPath =
          options.oauthPath && String(options.oauthPath).trim()
            ? resolveLoginOauthPath(options.oauthPath)
            : resolveConfiguredOauthPath(configPath, llm.oauthPath);
        const backupPath = getOauthBackupPath(oauthPath);
        const backup = await loadOauthLlmBackup(oauthPath);

        await rm(oauthPath, { force: true });
        await rm(backupPath, { force: true });

        if (backup) {
          if (backup.hadLlmConfig) {
            pluginConfig.llm = { ...backup.llm };
          } else {
            delete pluginConfig.llm;
          }
        } else {
          const fallbackLlm = buildLogoutFallbackLlmConfig(llm);
          if (hasRestorableApiKeyLlmConfig(fallbackLlm)) {
            pluginConfig.llm = fallbackLlm;
          } else {
            delete pluginConfig.llm;
          }
        }
        await saveOpenClawConfig(configPath, openclawConfig);

        console.log(`Deleted OAuth file: ${oauthPath}`);
        console.log(`Updated ${pluginId} config: llm.auth=api-key`);
      } catch (error) {
        console.error("OAuth logout failed:", error);
        process.exit(1);
      }
    });

  memory
    .command("store")
    .description("Store a memory")
    .requiredOption("--text <text>", "Memory text")
    .option("--category <category>", `Memory category (${STORE_CATEGORIES.join(", ")})`, "other")
    .option("--scope <scope>", "Scope to write to")
    .option("--importance <n>", "Importance score 0-1", "0.7")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          throw new Error("Store requires an embedder (not available in basic CLI mode).");
        }

        const text = String(options.text || "").trim();
        if (!text) {
          throw new Error("Memory text cannot be empty.");
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();
        if (!context.scopeManager.isAccessible(targetScope)) {
          throw new Error(`Access denied to scope: ${targetScope}`);
        }

        const category = parseCategoryOption(options.category) ?? "other";
        const importance = clamp01(parseFloat(options.importance), 0.7);
        const vector = await context.embedder.embedPassage(text);
        const entry = await memoryService.storeMemory({
          text,
          vector,
          importance,
          category,
          scope: targetScope,
          metadata: stringifySmartMetadata(
            buildSmartMetadata(
              { text, category, importance },
              {
                l0_abstract: text,
                l1_overview: `- ${text}`,
                l2_content: text,
              },
            ),
          ),
        });

        if (options.json) {
          console.log(formatJson(formatStoreJson(entry)));
          return;
        }

        console.log(
          `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" in scope '${entry.scope}'`,
        );
      } catch (error) {
        console.error("Failed to store memory:", error);
        process.exit(1);
      }
    });

  memory
    .command("update <id>")
    .description("Update an existing memory")
    .option("--text <text>", "Updated memory text")
    .option("--importance <n>", "Updated importance score 0-1")
    .option("--category <category>", `Updated category (${STORE_CATEGORIES.join(", ")})`)
    .option("--scope <scope>", "Scope to update within")
    .option("--json", "Output as JSON")
    .action(async (id, options) => {
      try {
        const text = typeof options.text === "string" ? options.text.trim() : undefined;
        const hasImportance = options.importance !== undefined;
        const importance = hasImportance ? clamp01(parseFloat(options.importance), 0.7) : undefined;
        const category = parseCategoryOption(options.category);
        if (!text && importance === undefined && !category) {
          throw new Error("Nothing to update. Provide at least one of: text, importance, category.");
        }

        if (text && !context.embedder) {
          throw new Error("Updating text requires an embedder (not available in basic CLI mode).");
        }

        const scopeFilter = toScopeFilter(options.scope);
        const fieldsUpdated: string[] = [];
        let updatedEntry: MemoryEntry | null = null;

        if (text) {
          fieldsUpdated.push("text");
          fieldsUpdated.push("vector");
        }
        if (importance !== undefined) {
          fieldsUpdated.push("importance");
        }
        if (category) {
          fieldsUpdated.push("category");
        }

        if (text) {
          const existing = await memoryService.getMemory(id, scopeFilter);
          const newVector = await context.embedder!.embedPassage(text);

          if (existing) {
            const meta = parseSmartMetadata(existing.metadata, existing);
            if (TEMPORAL_VERSIONED_CATEGORIES.has(meta.memory_category)) {
              const now = Date.now();
              const factKey = meta.fact_key ?? deriveFactKey(meta.memory_category, text);
              const nextImportance = importance ?? existing.importance;
              const newEntry = await memoryService.storeMemory({
                text,
                vector: newVector,
                category: category ?? existing.category,
                scope: existing.scope,
                importance: nextImportance,
                metadata: stringifySmartMetadata(
                  buildSmartMetadata(
                    { text, category: existing.category, importance: nextImportance },
                    {
                      l0_abstract: text,
                      l1_overview: meta.l1_overview,
                      l2_content: text,
                      memory_category: meta.memory_category,
                      tier: meta.tier,
                      access_count: 0,
                      confidence: nextImportance,
                      valid_from: now,
                      fact_key: factKey,
                      supersedes: existing.id,
                      relations: appendRelation([], {
                        type: "supersedes",
                        targetId: existing.id,
                      }),
                    },
                  ),
                ),
              });

              try {
                const invalidatedMeta = buildSmartMetadata(existing, {
                  fact_key: factKey,
                  invalidated_at: now,
                  superseded_by: newEntry.id,
                  relations: appendRelation(meta.relations, {
                    type: "superseded_by",
                    targetId: newEntry.id,
                  }),
                });
                await memoryService.updateMemory(
                  existing.id,
                  { metadata: stringifySmartMetadata(invalidatedMeta) },
                  scopeFilter,
                );
              } catch (patchErr) {
                console.warn(
                  `memory-pro: failed to patch superseded record ${existing.id.slice(0, 8)}: ${patchErr}`,
                );
              }

              if (options.json) {
                console.log(formatJson(
                  formatUpdateJson(newEntry, "superseded", fieldsUpdated, {
                    oldId: existing.id,
                    newId: newEntry.id,
                  }),
                ));
                return;
              }

              console.log(
                `Superseded memory ${existing.id.slice(0, 8)}... → new version ${newEntry.id.slice(0, 8)}...: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
              );
              return;
            }
          }

          updatedEntry = await memoryService.updateMemory(
            id,
            {
              text,
              vector: newVector,
              importance,
              category,
            },
            scopeFilter,
          );
        } else {
          updatedEntry = await memoryService.updateMemory(
            id,
            {
              importance,
              category,
            },
            scopeFilter,
          );
        }

        if (!updatedEntry) {
          throw new Error(`Memory ${id} not found or access denied.`);
        }

        if (options.json) {
          console.log(formatJson(formatUpdateJson(updatedEntry, "updated", fieldsUpdated)));
          return;
        }

        console.log(
          `Updated memory ${updatedEntry.id.slice(0, 8)}...: "${updatedEntry.text.slice(0, 80)}${updatedEntry.text.length > 80 ? "..." : ""}"`,
        );
      } catch (error) {
        console.error("Failed to update memory:", error);
        process.exit(1);
      }
    });

  // List memories
  memory
    .command("list")
    .description("List memories with optional filtering")
    .option("--scope <scope>", "Filter by scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "20")
    .option("--offset <n>", "Number of results to skip", "0")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const limit = parseInt(options.limit) || 20;
        const offset = parseInt(options.offset) || 0;
        const scopeFilter = toScopeFilter(options.scope);
        const memories = await memoryService.listMemories({
          scopeFilter,
          category: options.category,
          limit,
          offset,
        });

        if (options.json) {
          console.log(formatJson(formatListJson(memories, {
            scopeFilter,
            category: options.category,
            limit,
            offset,
          })));
        } else {
          if (memories.length === 0) {
            console.log("No memories found.");
          } else {
            console.log(`Found ${memories.length} memories:\n`);
            memories.forEach((memory, i) => {
              console.log(formatMemory(memory, offset + i));
            });
          }
        }
      } catch (error) {
        console.error("Failed to list memories:", error);
        process.exit(1);
      }
    });

  memory
    .command("recall <query>")
    .description("Recall memories using the shared recall service")
    .option("--scope <scope>", "Recall within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;
        const scopeFilter = toScopeFilter(options.scope);
        const recall = await recallService.prepareAutoRecall({
          prompt: query,
          limit,
          scopeFilter,
          category: options.category,
          source: "cli",
        });
        const resolvedQuery = query.slice(0, MAX_RECALL_QUERY_LENGTH);
        const results = recall?.results || [];

        if (options.json) {
          console.log(formatJson(formatRecallJson(resolvedQuery, results)));
          return;
        }

        if (results.length === 0) {
          console.log("No relevant memories found.");
          return;
        }

        console.log(`Found ${results.length} memories:\n`);
        results.forEach((result, index) => {
          console.log(
            `${index + 1}. [${result.entry.id}] [${result.entry.category}:${result.entry.scope}] ${result.entry.text} ` +
            `(${(result.score * 100).toFixed(0)}%)`,
          );
        });
      } catch (error) {
        console.error("Recall failed:", error);
        process.exit(1);
      }
    });

  // Search memories
  memory
    .command("search <query>")
    .description("Search memories using hybrid retrieval")
    .option("--scope <scope>", "Search within specific scope")
    .option("--category <category>", "Filter by category")
    .option("--limit <n>", "Maximum number of results", "10")
    .option("--json", "Output as JSON")
    .action(async (query, options) => {
      try {
        const limit = parseInt(options.limit) || 10;
        const scopeFilter = toScopeFilter(options.scope);
        const results = await runSearch(query, limit, scopeFilter, options.category);

        if (options.json) {
          console.log(formatJson(results));
        } else {
          if (results.length === 0) {
            console.log("No relevant memories found.");
          } else {
            console.log(`Found ${results.length} memories:\n`);
            results.forEach((result, i) => {
              const sources = [];
              if (result.sources.vector) sources.push("vector");
              if (result.sources.bm25) sources.push("BM25");
              if (result.sources.reranked) sources.push("reranked");

              console.log(
                `${i + 1}. [${result.entry.id}] [${result.entry.category}:${result.entry.scope}] ${result.entry.text} ` +
                `(${(result.score * 100).toFixed(0)}%, ${sources.join('+')})`
              );
            });
          }
        }
      } catch (error) {
        console.error("Search failed:", error);
        process.exit(1);
      }
    });

  // Memory statistics
  memory
    .command("stats")
    .description("Show memory statistics")
    .option("--scope <scope>", "Stats for specific scope")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      try {
        const scopeFilter = toScopeFilter(options.scope);
        const stats = await memoryService.getStats(scopeFilter);
        const scopeStats = context.scopeManager.getStats();
        const retrievalConfig = context.retriever.getConfig();

        const summary = {
          memory: stats,
          scopes: scopeStats,
          retrieval: {
            mode: retrievalConfig.mode,
            hasFtsSupport: context.store.hasFtsSupport,
          },
        };

        if (options.json) {
          console.log(formatJson(formatStatsJson(summary, scopeFilter)));
        } else {
          console.log(`Memory Statistics:`);
          console.log(`• Total memories: ${stats.totalCount}`);
          console.log(`• Available scopes: ${scopeStats.totalScopes}`);
          console.log(`• Retrieval mode: ${retrievalConfig.mode}`);
          console.log(`• FTS support: ${context.store.hasFtsSupport ? 'Yes' : 'No'}`);
          console.log();

          console.log("Memories by scope:");
          Object.entries(stats.scopeCounts).forEach(([scope, count]) => {
            console.log(`  • ${scope}: ${count}`);
          });
          console.log();

          console.log("Memories by category:");
          Object.entries(stats.categoryCounts).forEach(([category, count]) => {
            console.log(`  • ${category}: ${count}`);
          });
        }
      } catch (error) {
        console.error("Failed to get statistics:", error);
        process.exit(1);
      }
    });

  // Delete memory
  memory
    .command("delete <id>")
    .alias("forget")
    .description("Delete a specific memory by ID")
    .option("--scope <scope>", "Scope to delete from (for access control)")
    .option("--json", "Output as JSON")
    .action(async (id, options) => {
      try {
        const scopeFilter = toScopeFilter(options.scope);
        const deleted = await memoryService.deleteMemory(id, scopeFilter);

        if (deleted) {
          if (options.json) {
            console.log(formatJson(formatDeleteJson(id, true, scopeFilter)));
            return;
          }
          console.log(`Memory ${id} deleted successfully.`);
        } else {
          if (options.json) {
            console.log(formatJson(formatDeleteJson(id, false, scopeFilter)));
          } else {
            console.log(`Memory ${id} not found or access denied.`);
          }
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(
            formatJson({
              ok: false,
              error: "delete_failed",
              id,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        } else {
          console.error("Failed to delete memory:", error);
        }
        process.exit(1);
      }
    });

  // Bulk delete
  memory
    .command("delete-bulk")
    .description("Bulk delete memories with filters")
    .option("--scope <scopes...>", "Scopes to delete from (required)")
    .option("--before <date>", "Delete memories before this date (YYYY-MM-DD)")
    .option("--dry-run", "Show what would be deleted without actually deleting")
    .action(async (options) => {
      try {
        if (!options.scope || options.scope.length === 0) {
          console.error("At least one scope must be specified for safety.");
          process.exit(1);
        }

        let beforeTimestamp: number | undefined;
        if (options.before) {
          const date = new Date(options.before);
          if (isNaN(date.getTime())) {
            console.error("Invalid date format. Use YYYY-MM-DD.");
            process.exit(1);
          }
          beforeTimestamp = date.getTime();
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be deleted");
          console.log(`Filters: scopes=${options.scope.join(',')}, before=${options.before || 'none'}`);

          // Show what would be deleted
          const stats = await context.store.stats(options.scope);
          console.log(`Would delete from ${stats.totalCount} memories in matching scopes.`);
        } else {
          const deletedCount = await context.store.bulkDelete(options.scope, beforeTimestamp);
          console.log(`Deleted ${deletedCount} memories.`);
        }
      } catch (error) {
        console.error("Bulk delete failed:", error);
        process.exit(1);
      }
    });

  // Export memories
  memory
    .command("export")
    .description("Export memories to JSON")
    .option("--scope <scope>", "Export specific scope")
    .option("--category <category>", "Export specific category")
    .option("--output <file>", "Output file (default: stdout)")
    .action(async (options) => {
      try {
        let scopeFilter: string[] | undefined;
        if (options.scope) {
          scopeFilter = [options.scope];
        }

        const memories = await context.store.list(
          scopeFilter,
          options.category,
          1000 // Large limit for export
        );

        const exportData = {
          version: "1.0",
          exportedAt: new Date().toISOString(),
          count: memories.length,
          filters: {
            scope: options.scope,
            category: options.category,
          },
          memories: memories.map(m => ({
            ...m,
            vector: undefined, // Exclude vectors to reduce size
          })),
        };

        const output = formatJson(exportData);

        if (options.output) {
          const fs = await import("node:fs/promises");
          await fs.writeFile(options.output, output);
          console.log(`Exported ${memories.length} memories to ${options.output}`);
        } else {
          console.log(output);
        }
      } catch (error) {
        console.error("Export failed:", error);
        process.exit(1);
      }
    });

  // Import memories
  memory
    .command("import <file>")
    .description("Import memories from JSON file")
    .option("--scope <scope>", "Import into specific scope")
    .option("--dry-run", "Show what would be imported without actually importing")
    .action(async (file, options) => {
      try {
        const fs = await import("node:fs/promises");
        const content = await fs.readFile(file, "utf-8");
        const data = JSON.parse(content);

        if (!data.memories || !Array.isArray(data.memories)) {
          throw new Error("Invalid import file format");
        }

        if (options.dryRun) {
          console.log("DRY RUN - No memories will be imported");
          console.log(`Would import ${data.memories.length} memories`);
          if (options.scope) {
            console.log(`Target scope: ${options.scope}`);
          }
          return;
        }

        console.log(`Importing ${data.memories.length} memories...`);

        let imported = 0;
        let skipped = 0;

        if (!context.embedder) {
          console.error("Import requires an embedder (not available in basic CLI mode).");
          console.error("Use the plugin's memory_store tool or pass embedder to createMemoryCLI.");
          return;
        }

        const targetScope = options.scope || context.scopeManager.getDefaultScope();

        for (const memory of data.memories) {
          try {
            const text = memory.text;
            if (!text || typeof text !== "string" || text.length < 2) {
              skipped++;
              continue;
            }

            const categoryRaw = memory.category;
            const category: MemoryEntry["category"] =
              categoryRaw === "preference" ||
                categoryRaw === "fact" ||
                categoryRaw === "decision" ||
                categoryRaw === "entity" ||
                categoryRaw === "other"
                ? categoryRaw
                : "other";

            const importanceRaw = Number(memory.importance);
            const importance = Number.isFinite(importanceRaw)
              ? Math.max(0, Math.min(1, importanceRaw))
              : 0.7;

            const timestampRaw = Number(memory.timestamp);
            const timestamp = Number.isFinite(timestampRaw) ? timestampRaw : Date.now();

            const metadataRaw = memory.metadata;
            const metadata =
              typeof metadataRaw === "string"
                ? metadataRaw
                : metadataRaw != null
                  ? JSON.stringify(metadataRaw)
                  : "{}";

            const idRaw = memory.id;
            const id = typeof idRaw === "string" && idRaw.length > 0 ? idRaw : undefined;

            // Idempotency: if the import file includes an id and we already have it, skip.
            if (id && (await context.store.hasId(id))) {
              skipped++;
              continue;
            }

            // Back-compat dedupe: if no id provided, do a best-effort similarity check.
            if (!id) {
              const existing = await context.retriever.retrieve({
                query: text,
                limit: 1,
                scopeFilter: [targetScope],
              });
              if (existing.length > 0 && existing[0].score > 0.95) {
                skipped++;
                continue;
              }
            }

            const vector = await context.embedder.embedPassage(text);

            if (id) {
              await context.store.importEntry({
                id,
                text,
                vector,
                category,
                scope: targetScope,
                importance,
                timestamp,
                metadata,
              });
            } else {
              await context.store.store({
                text,
                vector,
                importance,
                category,
                scope: targetScope,
                metadata,
              });
            }

            imported++;
          } catch (error) {
            console.warn(`Failed to import memory: ${error}`);
            skipped++;
          }
        }

        console.log(`Import completed: ${imported} imported, ${skipped} skipped`);
      } catch (error) {
        console.error("Import failed:", error);
        process.exit(1);
      }
    });

  // Re-embed an existing LanceDB into the current target DB (A/B testing)
  memory
    .command("reembed")
    .description("Re-embed memories from a source LanceDB database into the current target database")
    .requiredOption("--source-db <path>", "Source LanceDB database directory")
    .option("--batch-size <n>", "Batch size for embedding calls", "32")
    .option("--limit <n>", "Limit number of rows to process (for testing)")
    .option("--dry-run", "Show what would be re-embedded without writing")
    .option("--skip-existing", "Skip entries whose id already exists in the target DB")
    .option("--force", "Allow using the same source-db as the target dbPath (DANGEROUS)")
    .action(async (options) => {
      try {
        if (!context.embedder) {
          console.error("Re-embed requires an embedder (not available in basic CLI mode).");
          return;
        }

        const fs = await import("node:fs/promises");

        const sourceDbPath = options.sourceDb as string;
        const batchSize = clampInt(parseInt(options.batchSize, 10) || 32, 1, 128);
        const limit = options.limit ? clampInt(parseInt(options.limit, 10) || 0, 1, 1000000) : undefined;
        const dryRun = options.dryRun === true;
        const skipExisting = options.skipExisting === true;
        const force = options.force === true;

        // Safety: prevent accidental in-place re-embedding
        let sourceReal = sourceDbPath;
        let targetReal = context.store.dbPath;
        try {
          sourceReal = await fs.realpath(sourceDbPath);
        } catch { }
        try {
          targetReal = await fs.realpath(context.store.dbPath);
        } catch { }

        if (!force && sourceReal === targetReal) {
          console.error("Refusing to re-embed in-place: source-db equals target dbPath. Use a new dbPath or pass --force.");
          process.exit(1);
        }

        const lancedb = await loadLanceDB();
        const db = await lancedb.connect(sourceDbPath);
        const table = await db.openTable("memories");

        let query = table
          .query()
          .select(["id", "text", "category", "scope", "importance", "timestamp", "metadata"]);

        if (limit) query = query.limit(limit);

        const rows = (await query.toArray())
          .filter((r: any) => r && typeof r.text === "string" && r.text.trim().length > 0)
          .filter((r: any) => r.id && r.id !== "__schema__");

        if (rows.length === 0) {
          console.log("No source memories found.");
          return;
        }

        console.log(
          `Re-embedding ${rows.length} memories from ${sourceDbPath} → ${context.store.dbPath} (batchSize=${batchSize})`
        );

        if (dryRun) {
          console.log("DRY RUN - No memories will be written");
          console.log(`First example: ${rows[0].id?.slice?.(0, 8)} ${String(rows[0].text).slice(0, 80)}`);
          return;
        }

        let processed = 0;
        let imported = 0;
        let skipped = 0;

        for (let i = 0; i < rows.length; i += batchSize) {
          const batch = rows.slice(i, i + batchSize);
          const texts = batch.map((r: any) => String(r.text));
          const vectors = await context.embedder.embedBatchPassage(texts);

          for (let j = 0; j < batch.length; j++) {
            processed++;
            const row = batch[j];
            const vector = vectors[j];

            if (!vector || vector.length === 0) {
              skipped++;
              continue;
            }

            const id = String(row.id);
            if (skipExisting) {
              const exists = await context.store.hasId(id);
              if (exists) {
                skipped++;
                continue;
              }
            }

            const entry: MemoryEntry = {
              id,
              text: String(row.text),
              vector,
              category: (row.category as any) || "other",
              scope: (row.scope as string | undefined) || "global",
              importance: (row.importance != null) ? Number(row.importance) : 0.7,
              timestamp: (row.timestamp != null) ? Number(row.timestamp) : Date.now(),
              metadata: typeof row.metadata === "string" ? row.metadata : "{}",
            };

            await context.store.importEntry(entry);
            imported++;
          }

          if (processed % 100 === 0 || processed === rows.length) {
            console.log(`Progress: ${processed}/${rows.length} processed, ${imported} imported, ${skipped} skipped`);
          }
        }

        console.log(`Re-embed completed: ${imported} imported, ${skipped} skipped (processed=${processed}).`);
      } catch (error) {
        console.error("Re-embed failed:", error);
        process.exit(1);
      }
    });

  // Upgrade legacy memories to new smart memory format
  memory
    .command("upgrade")
    .description("Upgrade legacy memories to new 6-category L0/L1/L2 smart memory format")
    .option("--dry-run", "Show upgrade statistics without modifying data")
    .option("--batch-size <n>", "Number of memories per batch", "10")
    .option("--no-llm", "Skip LLM calls; use simple text truncation for L0/L1")
    .option("--limit <n>", "Maximum number of memories to upgrade")
    .option("--scope <scope>", "Only upgrade memories in this scope")
    .action(async (options) => {
      try {
        const upgrader = createMemoryUpgrader(
          context.store,
          options.llm === false ? null : (context.llmClient ?? null),
          { log: console.log },
        );

        // Show current status first
        const scopeFilter = options.scope ? [options.scope] : undefined;
        const counts = await upgrader.countLegacy(scopeFilter);

        console.log(`Memory Upgrade Status:`);
        console.log(`• Total memories: ${counts.total}`);
        console.log(`• Legacy (needs upgrade): ${counts.legacy}`);
        console.log(`• Already new format: ${counts.total - counts.legacy}`);
        if (Object.keys(counts.byCategory).length > 0) {
          console.log(`• Legacy by category:`);
          Object.entries(counts.byCategory).forEach(([cat, n]) => {
            console.log(`    ${cat}: ${n}`);
          });
        }

        if (counts.legacy === 0) {
          console.log(`\nAll memories are already in the new format. No upgrade needed.`);
          return;
        }

        if (options.dryRun) {
          console.log(`\n[DRY-RUN] Would upgrade ${counts.legacy} memories.`);
          return;
        }

        console.log(`\nStarting upgrade...`);
        const result = await upgrader.upgrade({
          dryRun: false,
          batchSize: parseInt(options.batchSize) || 10,
          noLlm: options.llm === false,
          limit: options.limit ? parseInt(options.limit) : undefined,
          scopeFilter,
        });

        console.log(`\nUpgrade Results:`);
        console.log(`• Upgraded: ${result.upgraded}`);
        console.log(`• Already new format: ${result.skipped}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.slice(0, 5).forEach(err => console.log(`  - ${err}`));
          if (result.errors.length > 5) {
            console.log(`  ... and ${result.errors.length - 5} more`);
          }
        }
      } catch (error) {
        console.error("Upgrade failed:", error);
        process.exit(1);
      }
    });

  // Migration commands
  const migrate = memory
    .command("migrate")
    .description("Migration utilities");

  migrate
    .command("check")
    .description("Check if migration is needed from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const check = await context.migrator.checkMigrationNeeded(options.source);

        console.log("Migration Check Results:");
        console.log(`• Legacy database found: ${check.sourceFound ? 'Yes' : 'No'}`);
        if (check.sourceDbPath) {
          console.log(`• Source path: ${check.sourceDbPath}`);
        }
        if (check.entryCount !== undefined) {
          console.log(`• Entries to migrate: ${check.entryCount}`);
        }
        console.log(`• Migration needed: ${check.needed ? 'Yes' : 'No'}`);
      } catch (error) {
        console.error("Migration check failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("run")
    .description("Run migration from legacy memory-lancedb")
    .option("--source <path>", "Specific source database path")
    .option("--default-scope <scope>", "Default scope for migrated data", "global")
    .option("--dry-run", "Show what would be migrated without actually migrating")
    .option("--skip-existing", "Skip entries that already exist")
    .action(async (options) => {
      try {
        const result = await context.migrator.migrate({
          sourceDbPath: options.source,
          defaultScope: options.defaultScope,
          dryRun: options.dryRun,
          skipExisting: options.skipExisting,
        });

        console.log("Migration Results:");
        console.log(`• Status: ${result.success ? 'Success' : 'Failed'}`);
        console.log(`• Migrated: ${result.migratedCount}`);
        console.log(`• Skipped: ${result.skippedCount}`);
        if (result.errors.length > 0) {
          console.log(`• Errors: ${result.errors.length}`);
          result.errors.forEach(error => console.log(`  - ${error}`));
        }
        console.log(`• Summary: ${result.summary}`);

        if (!result.success) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Migration failed:", error);
        process.exit(1);
      }
    });

  migrate
    .command("verify")
    .description("Verify migration results")
    .option("--source <path>", "Specific source database path")
    .action(async (options) => {
      try {
        const result = await context.migrator.verifyMigration(options.source);

        console.log("Migration Verification:");
        console.log(`• Valid: ${result.valid ? 'Yes' : 'No'}`);
        console.log(`• Source count: ${result.sourceCount}`);
        console.log(`• Target count: ${result.targetCount}`);

        if (result.issues.length > 0) {
          console.log("• Issues:");
          result.issues.forEach(issue => console.log(`  - ${issue}`));
        }

        if (!result.valid) {
          process.exit(1);
        }
      } catch (error) {
        console.error("Verification failed:", error);
        process.exit(1);
      }
    });

  // reindex-fts: Rebuild FTS index
  program
    .command("reindex-fts")
    .description("Rebuild the BM25 full-text search index")
    .action(async () => {
      try {
        const status = context.store.getFtsStatus();
        console.log(`FTS status before: available=${status.available}, lastError=${status.lastError || "none"}`);
        const result = await context.store.rebuildFtsIndex();
        if (result.success) {
          console.log("✅ FTS index rebuilt successfully");
        } else {
          console.error("❌ FTS rebuild failed:", result.error);
          process.exit(1);
        }
      } catch (error) {
        console.error("FTS rebuild error:", error);
        process.exit(1);
      }
    });
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMemoryCLI(context: CLIContext) {
  return ({ program }: { program: Command }) => registerMemoryCLI(program, context);
}
