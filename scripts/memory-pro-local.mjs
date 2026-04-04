#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Command } from "commander";

const DEFAULT_RUNTIME_CONFIG_PATH = path.join(
  os.homedir(),
  ".agents",
  "memory",
  "memory-pro-openclaw.json",
);
const DEFAULT_DB_PATH = path.join(os.homedir(), ".agents", "memory", "lancedb-pro");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildRoot = path.join(repoRoot, ".codex-build");
const buildCliPath = path.join(buildRoot, "cli.js");
const buildTsConfigPath = path.join(repoRoot, "tsconfig.memory-pro-local.json");

function resolveEnvVars(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function resolveStringValue(value) {
  if (typeof value !== "string") {
    return value;
  }
  return resolveEnvVars(value);
}

function resolveApiKeyValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => resolveStringValue(String(item)));
  }
  return resolveStringValue(String(value));
}

function expandPath(value, baseDir) {
  const resolved = resolveStringValue(String(value));
  if (resolved.startsWith("~/")) {
    return path.join(os.homedir(), resolved.slice(2));
  }
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  return path.resolve(baseDir, resolved);
}

function parseWrapperArgs(argv) {
  const args = [];
  let runtimeConfigPath = DEFAULT_RUNTIME_CONFIG_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--runtime-config") {
      const next = argv[i + 1];
      if (!next) {
        throw new Error("--runtime-config requires a path");
      }
      runtimeConfigPath = next;
      i += 1;
      continue;
    }
    args.push(arg);
  }

  return { runtimeConfigPath, args };
}

function injectDefaultAuthConfigArg(args, runtimeConfigPath) {
  if (args[0] !== "auth") {
    return args;
  }
  if (!["login", "status", "logout"].includes(args[1])) {
    return args;
  }
  if (args.includes("--config")) {
    return args;
  }
  return [args[0], args[1], "--config", runtimeConfigPath, ...args.slice(2)];
}

function ensureLocalBuild() {
  if (existsSync(buildCliPath)) {
    return;
  }

  const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscPath)) {
    throw new Error(
      `TypeScript compiler not found at ${tscPath}. Run 'npm ci' in ${repoRoot} first.`,
    );
  }

  const build = spawnSync(
    process.execPath,
    [tscPath, "-p", buildTsConfigPath],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );

  if (build.status !== 0 && !existsSync(buildCliPath)) {
    throw new Error(
      `Failed to compile local runtime.\n${build.stdout || ""}\n${build.stderr || ""}`.trim(),
    );
  }

  copyFileSync(path.join(repoRoot, "package.json"), path.join(buildRoot, "package.json"));

  if (!existsSync(buildCliPath)) {
    throw new Error(`Expected compiled CLI at ${buildCliPath}, but it was not generated.`);
  }
}

async function loadBuildModules() {
  ensureLocalBuild();
  const cliModule = await import(pathToFileURL(buildCliPath).href);
  const storeModule = await import(pathToFileURL(path.join(buildRoot, "src", "store.js")).href);
  const embedderModule = await import(pathToFileURL(path.join(buildRoot, "src", "embedder.js")).href);
  const retrieverModule = await import(pathToFileURL(path.join(buildRoot, "src", "retriever.js")).href);
  const scopesModule = await import(pathToFileURL(path.join(buildRoot, "src", "scopes.js")).href);
  const migrateModule = await import(pathToFileURL(path.join(buildRoot, "src", "migrate.js")).href);
  const llmClientModule = await import(pathToFileURL(path.join(buildRoot, "src", "llm-client.js")).href);

  return {
    createMemoryCLI: cliModule.createMemoryCLI,
    MemoryStore: storeModule.MemoryStore,
    validateStoragePath: storeModule.validateStoragePath,
    createEmbedder: embedderModule.createEmbedder,
    getVectorDimensions: embedderModule.getVectorDimensions,
    createRetriever: retrieverModule.createRetriever,
    createScopeManager: scopesModule.createScopeManager,
    createMigrator: migrateModule.createMigrator,
    createLlmClient: llmClientModule.createLlmClient,
  };
}

async function loadRuntimeRoot(runtimeConfigPath) {
  const content = await readFile(runtimeConfigPath, "utf8");
  return JSON.parse(content);
}

function extractPluginConfig(runtimeRoot) {
  const entry = runtimeRoot?.plugins?.entries?.["memory-lancedb-pro"];
  if (entry?.config && typeof entry.config === "object") {
    return entry.config;
  }
  if (runtimeRoot?.config && typeof runtimeRoot.config === "object") {
    return runtimeRoot.config;
  }
  if (runtimeRoot && typeof runtimeRoot === "object" && runtimeRoot.embedding) {
    return runtimeRoot;
  }
  throw new Error(
    "Invalid runtime config: expected plugins.entries.memory-lancedb-pro.config or a raw plugin config object",
  );
}

function buildLlmClient(modules, pluginConfig, runtimeConfigPath) {
  const embedding = pluginConfig.embedding || {};
  const llm = pluginConfig.llm || {};
  const llmAuth = llm.auth || "api-key";
  const configDir = path.dirname(runtimeConfigPath);

  if (llmAuth === "oauth") {
    return modules.createLlmClient({
      auth: "oauth",
      model: llm.model || "gpt-5.4",
      baseURL: llm.baseURL ? resolveStringValue(llm.baseURL) : undefined,
      oauthProvider: llm.oauthProvider || "openai-codex",
      oauthPath: expandPath(llm.oauthPath || ".memory-lancedb-pro/oauth.json", configDir),
      timeoutMs: typeof llm.timeoutMs === "number" ? llm.timeoutMs : 30000,
    });
  }

  const apiKey = llm.apiKey || embedding.apiKey;
  if (!apiKey) {
    return undefined;
  }

  return modules.createLlmClient({
    auth: "api-key",
    apiKey: Array.isArray(apiKey) ? resolveStringValue(String(apiKey[0])) : resolveStringValue(String(apiKey)),
    model: llm.model || "openai/gpt-oss-120b",
    baseURL: llm.baseURL
      ? resolveStringValue(llm.baseURL)
      : embedding.baseURL
        ? resolveStringValue(embedding.baseURL)
        : undefined,
    timeoutMs: typeof llm.timeoutMs === "number" ? llm.timeoutMs : 30000,
  });
}

function buildCliContext(modules, pluginConfig, runtimeConfigPath) {
  const configDir = path.dirname(runtimeConfigPath);
  const embedding = pluginConfig.embedding || {};

  if (!embedding.apiKey) {
    throw new Error("embedding.apiKey is required in the runtime config");
  }

  const embeddingConfig = {
    provider: "openai-compatible",
    apiKey: resolveApiKeyValue(embedding.apiKey),
    model: embedding.model || "text-embedding-3-small",
    baseURL: embedding.baseURL ? resolveStringValue(embedding.baseURL) : undefined,
    dimensions: typeof embedding.dimensions === "number" ? embedding.dimensions : undefined,
    taskQuery: typeof embedding.taskQuery === "string" ? embedding.taskQuery : undefined,
    taskPassage: typeof embedding.taskPassage === "string" ? embedding.taskPassage : undefined,
    normalized: typeof embedding.normalized === "boolean" ? embedding.normalized : undefined,
    chunking: typeof embedding.chunking === "boolean" ? embedding.chunking : undefined,
  };

  const vectorDim = modules.getVectorDimensions(embeddingConfig.model, embeddingConfig.dimensions);
  const dbPath = modules.validateStoragePath(
    expandPath(pluginConfig.dbPath || DEFAULT_DB_PATH, configDir),
  );

  const store = new modules.MemoryStore({
    dbPath,
    vectorDim,
  });
  const embedder = modules.createEmbedder(embeddingConfig);
  const scopeManager = modules.createScopeManager(
    pluginConfig.scopes && typeof pluginConfig.scopes === "object"
      ? pluginConfig.scopes
      : undefined,
  );
  const retrieval = {
    ...(pluginConfig.retrieval && typeof pluginConfig.retrieval === "object"
      ? pluginConfig.retrieval
      : {}),
  };

  if (typeof retrieval.rerankApiKey === "string") {
    retrieval.rerankApiKey = resolveStringValue(retrieval.rerankApiKey);
  }
  if (typeof retrieval.rerankEndpoint === "string") {
    retrieval.rerankEndpoint = resolveStringValue(retrieval.rerankEndpoint);
  }

  return {
    store,
    retriever: modules.createRetriever(store, embedder, retrieval),
    scopeManager,
    migrator: modules.createMigrator(store),
    embedder,
    llmClient: buildLlmClient(modules, pluginConfig, runtimeConfigPath),
    pluginId: "memory-lancedb-pro",
    pluginConfig,
  };
}

async function main() {
  const parsed = parseWrapperArgs(process.argv.slice(2));
  const runtimeConfigPath = expandPath(parsed.runtimeConfigPath, process.cwd());
  const runtimeRoot = await loadRuntimeRoot(runtimeConfigPath);
  const pluginConfig = extractPluginConfig(runtimeRoot);
  const modules = await loadBuildModules();
  const context = buildCliContext(modules, pluginConfig, runtimeConfigPath);
  const args = injectDefaultAuthConfigArg(parsed.args, runtimeConfigPath);

  const program = new Command();
  modules.createMemoryCLI(context)({ program });

  await program.parseAsync(["node", "memory-pro", "memory-pro", ...args]);
}

main().catch((error) => {
  console.error("memory-pro wrapper failed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
