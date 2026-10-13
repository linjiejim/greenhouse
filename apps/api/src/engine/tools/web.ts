/**
 * The web, through the search providers: web_search, and web_fetch to read one page. Pages are
 * outside text: reading them taints the turn. A page is read by a provider reader when one is
 * configured (Jina, Firecrawl), otherwise fetched directly over a public-only connection.
 */

import { isIP } from 'node:net';
import { z } from 'zod';
import type { ProvidersService } from '../../providers/service.js';
import { isPrivateAddress } from '../../security/network.js';
import { publicFetch } from '../../security/public-fetch.js';
import { defineTool, type ToolContext } from './define.js';

const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;

const usage = (ctx: ToolContext) => ({
  memberId: ctx.memberId,
  agentId: ctx.agent.id,
  runId: ctx.runId,
  conversationId: ctx.conversation?.id,
  personal: ctx.agent.ownerId === ctx.memberId,
});

/** Tries each search instance in order; a failing vendor hands over to the next. */
async function firstSuccess<T>(attempts: Array<() => Promise<T>>): Promise<T> {
  let last: unknown = new Error('Web search is not set up here.');
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    try {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    } catch {
      return match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** Readable text from HTML: no scripts, styles or tags, block breaks kept. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const text = decodeEntities(
    html
      .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/\n\s*\n\s*/g, '\n\n')
    .trim();
  return { title, text };
}

/** Fetches a public page: every hop checked, nothing private reachable, size and time bounded. */
export async function fetchPublicPage(
  raw: string,
  fetchImpl: typeof fetch = publicFetch,
): Promise<{ url: string; title: string; content: string }> {
  let url = new URL(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      throw new Error('Only web pages (http or https) can be opened.');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // A name is checked when it resolves; an address has nothing to resolve, so check it here.
    if (isIP(host) && isPrivateAddress(host)) throw new Error('This address points into a private network.');
    const response = await fetchImpl(url.href, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        accept: 'text/html,text/plain;q=0.9,*/*;q=0.1',
        'user-agent': 'GreenhouseBot/2.0 (+https://greenhouse.linjiejim.com)',
      },
    });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location) {
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`The page answered HTTP ${response.status}.`);
    const type = response.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)|application\/xhtml/.test(type))
      throw new Error(`This is not a web page (${type || 'unknown type'}).`);
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
    const body = new TextDecoder().decode(Buffer.concat(chunks));
    const page = /html/.test(type) ? htmlToText(body) : { title: '', text: body };
    return { url: url.href, title: page.title, content: page.text.slice(0, MAX_PAGE_CHARS) };
  }
  throw new Error('Too many redirects.');
}

export function webTools(providers: ProvidersService, options: { fetch?: typeof fetch } = {}) {
  const webSearch = defineTool({
    name: 'web_search',
    description:
      'Search the web. Returns titles, links and snippets; read the pages that matter with web_fetch before relying on them, and cite what you used.',
    input: z.object({
      query: z.string().min(1).max(400),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    risk: 'read',
    taints: true,
    outbound: true,
    available: (ctx) => ctx.available('search'),
    async execute(args, ctx) {
      const chain = await providers.chain('search', usage(ctx));
      const results = await firstSuccess(
        chain.map((entry) => () => entry.client.search(args.query, { limit: args.limit })),
      );
      return {
        results: results.map((result) => ({
          title: result.title,
          url: result.url,
          snippet: result.snippet,
          ...(result.publishedAt ? { published_at: result.publishedAt } : {}),
        })),
      };
    },
    summarize: (args, _output, locale) => (locale === 'zh' ? `搜索：${args.query}` : `Searched: ${args.query}`),
  });

  const webFetch = defineTool({
    name: 'web_fetch',
    description:
      'Open one web page and read its text. Use it on the links that matter; never on private or internal addresses.',
    input: z.object({ url: z.string().url().max(2000) }),
    risk: 'read',
    taints: true,
    outbound: true,
    available: (ctx) => ctx.available('search'),
    async execute(args, ctx) {
      const readers = (await providers.chain('search', usage(ctx))).filter((entry) => entry.client.read);
      if (readers.length) {
        const page = await firstSuccess(readers.map((entry) => () => entry.client.read!(args.url)));
        return { url: page.url, title: page.title, content: page.content.slice(0, MAX_PAGE_CHARS) };
      }
      return fetchPublicPage(args.url, options.fetch);
    },
    summarize: (args, _output, locale) => {
      const host = (() => {
        try {
          return new URL(args.url).host;
        } catch {
          return args.url;
        }
      })();
      return locale === 'zh' ? `阅读：${host}` : `Read: ${host}`;
    },
  });

  return [webSearch, webFetch];
}
