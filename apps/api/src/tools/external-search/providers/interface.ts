/**
 * External Search — provider interface and registry.
 *
 * SearchProviderRegistry manages multiple search backends with
 * automatic fallback: if the primary provider fails, the next
 * available provider is tried.
 */

import type { SearchProvider, SearchResult, SearchOpts } from '../types.js';
import { toErrorMessage } from '@greenhouse/utils/error';

export type { SearchProvider, SearchResult, SearchOpts };

/**
 * Registry that holds multiple search providers and attempts them
 * in priority order, falling back on failure.
 */
export class SearchProviderRegistry {
  private providers: SearchProvider[] = [];

  /** Register a provider (order = priority, first = highest). */
  register(provider: SearchProvider): void {
    this.providers.push(provider);
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.length;
  }

  /** Get provider names in priority order. */
  get names(): string[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Search using registered providers in priority order.
   * Returns the first successful result; throws if all fail.
   */
  async search(query: string, opts: SearchOpts): Promise<{ results: SearchResult[]; provider: string }> {
    if (this.providers.length === 0) {
      throw new Error('No search providers registered. Set TAVILY_API_KEY or BRAVE_SEARCH_API_KEY in .env');
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      try {
        const results = await provider.search(query, opts);
        return { results, provider: provider.name };
      } catch (err) {
        const message = toErrorMessage(err);
        errors.push({ provider: provider.name, error: message });
        // Continue to next provider
      }
    }

    throw new Error(`All search providers failed:\n${errors.map((e) => `  - ${e.provider}: ${e.error}`).join('\n')}`);
  }
}
