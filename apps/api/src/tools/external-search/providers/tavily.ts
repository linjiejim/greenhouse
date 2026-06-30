/**
 * Tavily Search Provider — AI-first search engine.
 *
 * Returns clean, extracted content optimized for LLM consumption.
 * This is the preferred provider because it bundles search + content
 * extraction in a single API call.
 *
 * API docs: https://docs.tavily.com/documentation/api-reference/search
 * Free tier: 1,000 searches/month
 *
 * Env: TAVILY_API_KEY
 */

import type { SearchProvider, SearchResult, SearchOpts } from './interface.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 15_000;

interface TavilyResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    raw_content?: string;
    score: number;
  }>;
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily';
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body: Record<string, unknown> = {
        query,
        max_results: opts.maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      };

      const response = await fetch(TAVILY_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Tavily API ${response.status}: ${text.slice(0, 200)}`);
      }

      const data = (await response.json()) as TavilyResponse;

      return (data.results || []).map((r) => ({
        title: r.title || '(no title)',
        url: r.url,
        snippet: (r.content || '').slice(0, 500),
        content: r.content || undefined,
        score: r.score,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Create a Tavily provider if the API key is available.
 */
export function createTavilyProvider(): TavilyProvider | null {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;
  return new TavilyProvider(apiKey);
}
