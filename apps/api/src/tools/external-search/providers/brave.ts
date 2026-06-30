/**
 * Brave Search Provider — privacy-focused web search API.
 *
 * Returns search result snippets (no full content extraction).
 * Pair with ContentExtractor for full-page content when needed.
 *
 * API docs: https://api.search.brave.com/app/documentation/web-search
 * Free tier: 2,000 queries/month (1 query/sec)
 *
 * Env: BRAVE_SEARCH_API_KEY
 */

import type { SearchProvider, SearchResult, SearchOpts } from './interface.js';

const BRAVE_API_URL = 'https://api.search.brave.com/res/v1/web/search';
const REQUEST_TIMEOUT_MS = 15_000;

interface BraveWebResult {
  title: string;
  url: string;
  description: string;
  extra_snippets?: string[];
}

interface BraveResponse {
  web?: {
    results: BraveWebResult[];
  };
}

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const params = new URLSearchParams({
        q: query,
        count: String(opts.maxResults),
      });

      // Map language preference
      if (opts.language === 'zh') {
        params.set('search_lang', 'zh-hans');
      } else if (opts.language === 'en') {
        params.set('search_lang', 'en');
      }

      const response = await fetch(`${BRAVE_API_URL}?${params}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Brave API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as BraveResponse;
      const webResults = data.web?.results || [];

      return webResults.map((r) => ({
        title: r.title || '(no title)',
        url: r.url,
        snippet: r.description || '',
        // Brave doesn't return full content — only snippets
        content: r.extra_snippets?.length ? [r.description, ...r.extra_snippets].join('\n\n') : undefined,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a Brave provider if the API key is available.
 */
export function createBraveProvider(): BraveProvider | null {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return null;
  return new BraveProvider(apiKey);
}
