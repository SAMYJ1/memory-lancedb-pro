type FetchLike = typeof fetch;

interface ProxyAwareFetchDeps {
  createProxyAgent?: (proxyUrl: string) => unknown;
}

function readProxyUrl(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined {
  return env.https_proxy
    || env.HTTPS_PROXY
    || env.http_proxy
    || env.HTTP_PROXY
    || env.all_proxy
    || env.ALL_PROXY
    || undefined;
}

function extractUrl(input: string | URL | Request): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  return undefined;
}

function isLoopbackTarget(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "localhost") return true;
    // IPv6 loopback — URL.hostname may include brackets like [::1]
    const stripped = hostname.replace(/^\[|\]$/g, "");
    if (stripped === "::1") return true;
    // IPv4 loopback (127.0.0.0/8)
    if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

function isNoProxyTarget(urlString: string, noProxy: string): boolean {
  const target = new URL(urlString);
  const hostname = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === "https:" ? "443" : "80");

  for (const entry of noProxy.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)) {
    // Leading dot means subdomain suffix match (e.g. ".example.com")
    if (entry.startsWith(".")) {
      if (hostname.endsWith(entry) || hostname === entry.slice(1)) return true;
    } else if (entry.includes(":")) {
      // host:port exact match
      if (`${hostname}:${port}` === entry) return true;
    } else {
      // Exact hostname match
      if (hostname === entry) return true;
    }
  }
  return false;
}

export function createProxyAwareFetch(
  baseFetch: FetchLike,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  deps: ProxyAwareFetchDeps = {},
): FetchLike {
  const proxyUrl = readProxyUrl(env);
  const noProxy = (env.no_proxy || env.NO_PROXY || "").trim();
  let cachedDispatcher: unknown | undefined;

  return async (input, init) => {
    const targetUrl = extractUrl(input);
    if (
      !proxyUrl
      || !targetUrl
      || isLoopbackTarget(targetUrl)
      || (noProxy && isNoProxyTarget(targetUrl, noProxy))
      || (init && "dispatcher" in init)
    ) {
      return baseFetch(input, init);
    }

    if (!cachedDispatcher) {
      try {
        if (deps.createProxyAgent) {
          cachedDispatcher = deps.createProxyAgent(proxyUrl);
        } else {
          const undici = await import("undici");
          cachedDispatcher = new undici.ProxyAgent(proxyUrl);
        }
      } catch {
        // Proxy setup failed — fall back to direct fetch
        return baseFetch(input, init);
      }
    }

    return baseFetch(input, {
      ...init,
      dispatcher: cachedDispatcher,
    } as RequestInit);
  };
}
