/**
 * External Search — shared type definitions.
 */

// ─── Search Provider Types ───────────────────────────────

export interface SearchOpts {
  maxResults: number;
  language: 'en' | 'zh' | 'auto';
  /** Whether to extract full page content (providers that support it can use this) */
  extractContent?: boolean;
}

export interface SearchResult {
  /** Page title */
  title: string;
  /** Source URL */
  url: string;
  /** Short text snippet from search engine */
  snippet: string;
  /** Extracted full-page content (only when content extraction is enabled) */
  content?: string;
  /** Relevance score from the provider (0–1, optional) */
  score?: number;
}

export interface SearchProvider {
  /** Human-readable provider name */
  readonly name: string;
  /** Search and return results */
  search(query: string, opts: SearchOpts): Promise<SearchResult[]>;
}

// ─── Content Extractor Types ─────────────────────────────

export interface ExtractedContent {
  /** Page title */
  title: string;
  /** Cleaned content in Markdown */
  content: string;
  /** Byte length of original content before truncation */
  byteLength: number;
  /** Whether content was truncated */
  truncated: boolean;
}

export interface ContentExtractor {
  /** Extract clean text content from a URL */
  extract(url: string): Promise<ExtractedContent>;
}

// ─── Sanitizer Types ─────────────────────────────────────

export interface SanitizeResult {
  /** Sanitized text (may be wrapped in XML envelope) */
  text: string;
  /** Whether the content was flagged as potentially unsafe */
  flagged: boolean;
  /** Reasons the content was flagged */
  flagReasons: string[];
}

// ─── Tool Input / Output Types ───────────────────────────

export interface ExternalSearchInput {
  query: string;
  maxResults: number;
  extractContent: boolean;
  language: 'en' | 'zh' | 'auto';
}

export interface ExternalSearchOutput {
  query: string;
  resultCount: number;
  provider: string;
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    content?: string;
  }>;
}
