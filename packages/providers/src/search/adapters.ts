/**
 * Web search adapters (docs/product/providers.md §6). Each vendor's rows are normalised to
 * SearchResult, capped to options.limit (5 by default, 20 at most); Jina and Firecrawl also
 * read one page as Markdown for web_fetch.
 */

import { z } from 'zod';
import type { PageContent, ProviderAdapter, SearchClient, SearchResult } from '../types.js';
import {
  ProviderRequestError,
  bearer,
  getJson,
  postJson,
  providerError,
  withoutTrailingSlash,
  type CallContext,
} from '../http.js';

const SEARCH_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;
const SNIPPET_MAX = 500;

/** options.limit: 5 by default and never above 20, the per-request ceiling of most vendors. */
function limitOf(options?: { limit?: number }): number {
  const limit = Math.trunc(options?.limit ?? 5);
  return Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 20) : 5;
}

const list = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);

const text = (value: unknown) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/** ISO 8601 for a real date; relative strings such as "2 days ago" are dropped. */
function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  // A date-time without an offset (Brave's page_age) is read as UTC, not in the server's zone.
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw) ? `${raw}Z` : raw);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

interface Row {
  title?: unknown;
  url?: unknown;
  snippet?: unknown;
  date?: unknown;
}

/** Rows without a URL are dropped; a missing title falls back to the URL. */
function toResults(rows: readonly Row[], limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  for (const row of rows) {
    if (results.length === limit) break;
    const url = text(row.url);
    if (!url) continue;
    const publishedAt = isoDate(row.date);
    results.push({
      title: text(row.title) || url,
      url,
      snippet: text(row.snippet).slice(0, SNIPPET_MAX),
      ...(publishedAt ? { publishedAt } : {}),
    });
  }
  return results;
}

function pageOf(requested: string, title: unknown, finalUrl: unknown, content: unknown): PageContent {
  return { url: text(finalUrl) || requested, title: text(title), content: typeof content === 'string' ? content : '' };
}

/** One search for one result: the cheapest call that proves the key and the endpoint. */
async function probe(client: SearchClient) {
  await client.search('greenhouse', { limit: 1 });
}

const baseUrlSchema = (fallback: string) =>
  z.object({ baseUrl: z.string().url().default(fallback) }) as z.ZodType<BaseUrlConfig>;
type BaseUrlConfig = { baseUrl: string };

const searchCall = (label: string, apiKey: string | undefined): CallContext => ({
  label,
  secrets: [apiKey],
  timeoutMs: SEARCH_TIMEOUT_MS,
});

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string; published_date?: string | null }[];
}

export const tavilyAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'tavily',
  label: 'Tavily',
  configSchema: baseUrlSchema('https://api.tavily.com'),
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call = searchCall('Tavily search', secrets.apiKey);
    return {
      async search(query, options) {
        const limit = limitOf(options);
        const body = await postJson<TavilyResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/search`,
          { query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false },
          bearer(secrets.apiKey),
          call,
        );
        const rows = list(body.results).map((row) => ({
          title: row.title,
          url: row.url,
          snippet: row.content,
          date: row.published_date,
        }));
        return toResults(rows, limit);
      },
    };
  },
  test: probe,
};

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string; page_age?: string | null }[] };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };

/** Brave wraps query terms in <strong> and escapes entities; results carry plain text. */
const braveText = (value: string | undefined) =>
  value
    ?.replace(/<\/?strong>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, name: string) => ENTITIES[name] ?? '');

export const braveAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'brave',
  label: 'Brave Search',
  configSchema: baseUrlSchema('https://api.search.brave.com'),
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call = searchCall('Brave search', secrets.apiKey);
    return {
      async search(query, options) {
        const limit = limitOf(options);
        const params = new URLSearchParams({ q: query, count: String(limit) });
        const body = await getJson<BraveResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/res/v1/web/search?${params}`,
          { 'X-Subscription-Token': secrets.apiKey ?? '' },
          call,
        );
        const rows = list(body.web?.results).map((row) => ({
          title: braveText(row.title),
          url: row.url,
          snippet: braveText(row.description),
          date: row.page_age,
        }));
        return toResults(rows, limit);
      },
    };
  },
  test: probe,
};

interface ExaResponse {
  results?: {
    title?: string | null;
    url?: string;
    publishedDate?: string | null;
    highlights?: string[];
    text?: string;
  }[];
}

export const exaAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'exa',
  label: 'Exa',
  configSchema: baseUrlSchema('https://api.exa.ai'),
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call = searchCall('Exa search', secrets.apiKey);
    return {
      async search(query, options) {
        const limit = limitOf(options);
        // Exa returns no page text unless asked; highlights are its query-relevant excerpts.
        const body = await postJson<ExaResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/search`,
          { query, numResults: limit, contents: { highlights: true } },
          { 'x-api-key': secrets.apiKey ?? '' },
          call,
        );
        const rows = list(body.results).map((row) => ({
          title: row.title,
          url: row.url,
          snippet: list(row.highlights).join(' … ') || row.text,
          date: row.publishedDate,
        }));
        return toResults(rows, limit);
      },
    };
  },
  test: probe,
};

const jinaConfigSchema = z.object({
  searchUrl: z.string().url().default('https://s.jina.ai'),
  readerUrl: z.string().url().default('https://r.jina.ai'),
});
type JinaConfig = z.infer<typeof jinaConfigSchema>;

interface JinaSearchResponse {
  data?: { title?: string; url?: string; description?: string; date?: string }[] | null;
}

interface JinaReadResponse {
  data?: { title?: string; url?: string; content?: string } | null;
}

export const jinaAdapter: ProviderAdapter<'search', JinaConfig> = {
  capability: 'search',
  kind: 'jina',
  label: 'Jina',
  configSchema: jinaConfigSchema as z.ZodType<JinaConfig>,
  secretKeys: ['apiKey'],
  // The Reader answers keyless callers at a low rate; search refuses them.
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.searchUrl, config.readerUrl],
  create: ({ config, secrets, fetch }) => {
    const call = searchCall('Jina search', secrets.apiKey);
    const readCall: CallContext = { label: 'Jina Reader', secrets: [secrets.apiKey], timeoutMs: READ_TIMEOUT_MS };
    return {
      async search(query, options) {
        const limit = limitOf(options);
        const params = new URLSearchParams({ q: query, num: String(limit) });
        // no-content returns the result list without fetching every page: faster and cheaper.
        const body = await getJson<JinaSearchResponse>(
          fetch,
          `${withoutTrailingSlash(config.searchUrl)}/?${params}`,
          { 'X-Respond-With': 'no-content', ...bearer(secrets.apiKey) },
          call,
        );
        const rows = list(body.data).map((row) => ({
          title: row.title,
          url: row.url,
          snippet: row.description,
          date: row.date,
        }));
        return toResults(rows, limit);
      },
      async read(url) {
        // POST keeps the target URL (and any #fragment) out of the Reader's own path.
        const body = await postJson<JinaReadResponse>(
          fetch,
          `${withoutTrailingSlash(config.readerUrl)}/`,
          { url },
          bearer(secrets.apiKey),
          readCall,
        );
        if (!body.data) throw new ProviderRequestError('Jina Reader returned no page.');
        return pageOf(url, body.data.title, body.data.url, body.data.content);
      },
    };
  },
  test: probe,
};

interface FirecrawlSearchResponse {
  success?: boolean;
  error?: string;
  warning?: string | null;
  data?: { web?: { title?: string; description?: string; url?: string }[] };
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string;
    metadata?: { title?: string | string[]; url?: string; sourceURL?: string; statusCode?: number };
  };
}

export const firecrawlAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'firecrawl',
  label: 'Firecrawl',
  configSchema: baseUrlSchema('https://api.firecrawl.dev'),
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const base = withoutTrailingSlash(config.baseUrl);
    const call = searchCall('Firecrawl search', secrets.apiKey);
    const readCall: CallContext = { label: 'Firecrawl scrape', secrets: [secrets.apiKey], timeoutMs: READ_TIMEOUT_MS };
    return {
      async search(query, options) {
        const limit = limitOf(options);
        // Without scrapeOptions a search costs one credit and returns titles and descriptions only.
        const body = await postJson<FirecrawlSearchResponse>(
          fetch,
          `${base}/v2/search`,
          { query, limit },
          bearer(secrets.apiKey),
          call,
        );
        if (body.success === false) throw providerError(call, { detail: body.error ?? body.warning });
        const rows = list(body.data?.web).map((row) => ({ title: row.title, url: row.url, snippet: row.description }));
        return toResults(rows, limit);
      },
      async read(url) {
        const body = await postJson<FirecrawlScrapeResponse>(
          fetch,
          `${base}/v2/scrape`,
          { url, formats: ['markdown'], onlyMainContent: true },
          bearer(secrets.apiKey),
          readCall,
        );
        if (body.success === false || !body.data) throw providerError(readCall, { detail: body.error });
        const metadata = body.data.metadata ?? {};
        // The page's own status, not Firecrawl's, so no statusCode: another instance would get the same page.
        if (typeof metadata.statusCode === 'number' && metadata.statusCode >= 400) {
          throw new ProviderRequestError(`Firecrawl could not read the page: it answered HTTP ${metadata.statusCode}.`);
        }
        const title = Array.isArray(metadata.title) ? metadata.title[0] : metadata.title;
        return pageOf(url, title, metadata.url ?? metadata.sourceURL, body.data.markdown);
      },
    };
  },
  test: probe,
};

interface SearxngResponse {
  results?: { title?: string; url?: string; content?: string; publishedDate?: string | null }[];
}

export const searxngAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'searxng',
  label: 'SearXNG（自托管）',
  configSchema: z.object({ baseUrl: z.string().url() }) as z.ZodType<BaseUrlConfig>,
  secretKeys: [],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, fetch }) => {
    const call: CallContext = {
      label: 'SearXNG search',
      timeoutMs: SEARCH_TIMEOUT_MS,
      hints: {
        403: 'Enable the json format under search.formats in the SearXNG settings.yml.',
        429: 'The SearXNG limiter blocked this server; turn server.limiter off for this instance.',
      },
    };
    return {
      async search(query, options) {
        const limit = limitOf(options);
        const params = new URLSearchParams({ q: query, format: 'json' });
        const body = await getJson<SearxngResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/search?${params}`,
          {},
          call,
        );
        const rows = list(body.results).map((row) => ({
          title: row.title,
          url: row.url,
          snippet: row.content,
          date: row.publishedDate,
        }));
        return toResults(rows, limit);
      },
    };
  },
  test: probe,
};

interface BochaResponse {
  code?: number | string;
  msg?: string | null;
  message?: string;
  data?: {
    webPages?: {
      value?: { name?: string; url?: string; snippet?: string; summary?: string; datePublished?: string }[];
    };
  };
}

export const bochaAdapter: ProviderAdapter<'search', BaseUrlConfig> = {
  capability: 'search',
  kind: 'bocha',
  label: '博查',
  // api.bochaai.com serves the same API.
  configSchema: baseUrlSchema('https://api.bocha.cn'),
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call = searchCall('Bocha search', secrets.apiKey);
    return {
      async search(query, options) {
        const limit = limitOf(options);
        const body = await postJson<BochaResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/v1/web-search`,
          { query, count: limit, summary: true },
          bearer(secrets.apiKey),
          call,
        );
        const code = Number(body.code ?? 200);
        if (code !== 200) {
          const statusCode = code >= 400 && code < 600 ? code : undefined;
          throw providerError(call, { reason: `code ${body.code}`, detail: body.msg ?? body.message, statusCode });
        }
        // The summary is the longer, cleaner excerpt; the snippet is the fallback.
        const rows = list(body.data?.webPages?.value).map((row) => ({
          title: row.name,
          url: row.url,
          snippet: row.summary || row.snippet,
          date: row.datePublished,
        }));
        return toResults(rows, limit);
      },
    };
  },
  test: probe,
};

export const SEARCH_ADAPTERS = [
  tavilyAdapter,
  braveAdapter,
  exaAdapter,
  jinaAdapter,
  firecrawlAdapter,
  searxngAdapter,
  bochaAdapter,
];
