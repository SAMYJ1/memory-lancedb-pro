import type { Embedder } from "../embedder.js";
import type { RetrievalContext, RetrievalResult } from "../retriever.js";
import { isSystemBypassId, resolveScopeFilter, type ScopeManager } from "../scopes.js";
import type { MemorySearchResult, MemoryStore } from "../store.js";
import type { MdMirrorWriter } from "../tools.js";

export interface ServiceLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

type RetrieverLike = {
  retrieve(params: RetrievalContext): Promise<RetrievalResult[]>;
  test?: () => Promise<unknown>;
};

type StoreLike = Pick<
  MemoryStore,
  "store" | "vectorSearch" | "list" | "stats" | "delete" | "getById" | "update"
>;
type ScopeManagerLike = Pick<ScopeManager, "getAccessibleScopes" | "getDefaultScope"> & {
  getScopeFilter?: (agentId?: string) => string[] | undefined;
};
type EmbedderLike = Pick<Embedder, "test">;

export interface MemoryServiceDeps {
  retriever: RetrieverLike;
  scopeManager: ScopeManagerLike;
  store?: StoreLike;
  embedder?: EmbedderLike;
  mdMirror?: MdMirrorWriter | null;
  defaultScope?: string;
  logger?: ServiceLogger;
  retryDelayMs?: number;
}

export interface ListMemoriesParams {
  scopeFilter?: string[];
  category?: string;
  limit?: number;
  offset?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createMemoryService(deps: MemoryServiceDeps) {
  const retryDelayMs = deps.retryDelayMs ?? 75;

  function requireStore(label: "writes" | "listing" | "stats" | "deletes"): StoreLike {
    if (!deps.store) {
      throw new Error(`memory-service: store dependency is required for ${label}`);
    }
    return deps.store;
  }

  return {
    getAccessibleScopes(agentId?: string): string[] | undefined {
      return resolveScopeFilter(deps.scopeManager, agentId);
    },

    getDefaultWriteScope(agentId?: string): string {
      if (isSystemBypassId(agentId)) {
        return deps.defaultScope ?? "global";
      }
      return deps.scopeManager.getDefaultScope(agentId);
    },

    async retrieveWithRetry(params: RetrievalContext): Promise<RetrievalResult[]> {
      let results = await deps.retriever.retrieve(params);
      if (results.length === 0) {
        await sleep(retryDelayMs);
        results = await deps.retriever.retrieve(params);
      }
      return results;
    },

    async findNearDuplicates(vector: number[], scope: string): Promise<MemorySearchResult[]> {
      if (!deps.store) return [];
      return deps.store.vectorSearch(vector, 1, 0.1, [scope]);
    },

    async listMemories(params: ListMemoriesParams = {}) {
      const store = requireStore("listing");
      return store.list(params.scopeFilter, params.category, params.limit, params.offset);
    },

    async getStats(scopeFilter?: string[]) {
      const store = requireStore("stats");
      return store.stats(scopeFilter);
    },

    async deleteMemory(id: string, scopeFilter?: string[]) {
      const store = requireStore("deletes");
      return store.delete(id, scopeFilter);
    },

    async getMemory(id: string, scopeFilter?: string[]) {
      const store = requireStore("listing");
      return store.getById(id, scopeFilter);
    },

    async storeMemory(
      entry: Parameters<StoreLike["store"]>[0],
      meta?: Parameters<NonNullable<MdMirrorWriter>>[1],
    ) {
      const store = requireStore("writes");
      const stored = await store.store(entry);
      if (deps.mdMirror) {
        await deps.mdMirror(
          {
            text: stored.text,
            category: stored.category,
            scope: stored.scope,
            timestamp: stored.timestamp,
          },
          meta,
        );
      }
      return stored;
    },

    async updateMemory(
      id: string,
      updates: Parameters<StoreLike["update"]>[1],
      scopeFilter?: string[],
    ) {
      const store = requireStore("writes");
      return store.update(id, updates, scopeFilter);
    },

    async runStartupChecks(timeoutMs = 8_000): Promise<{
      embedTest?: unknown;
      retrievalTest?: unknown;
    }> {
      const embedTest = deps.embedder?.test
        ? await withTimeout(deps.embedder.test(), timeoutMs, "embedder.test()")
        : undefined;
      const retrievalTest = deps.retriever.test
        ? await withTimeout(deps.retriever.test(), timeoutMs, "retriever.test()")
        : undefined;

      return { embedTest, retrievalTest };
    },
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
