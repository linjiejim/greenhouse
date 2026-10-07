/**
 * Conversation data model — the client-side shape of a turn (what the screen
 * renders and the streaming hook mutates), plus the pure helpers that build it:
 * hydrating persisted history (`fromStored`), harvesting citations from tool
 * results, and serialising a transcript for the share sheet. No React here.
 */

import type { Message } from '../shared/greenhouse-types';

export interface ToolStep {
  id: string;
  tool: string;
  input?: unknown;
  output?: unknown;
  status: 'running' | 'done' | 'error';
  /** Wall time of the call (stored pipelines carry it; live calls are timed client-side). */
  ms?: number;
  /** Client clock when the call started (live calls only). */
  startedAt?: number;
}

/** A knowledge citation (a doc the agent read). */
export interface Source {
  slug?: string;
  title: string;
  category?: string;
  body?: string;
}

/** A web search hit the agent used. */
export interface WebSource {
  title: string;
  host?: string;
  url?: string;
}

export interface Metrics {
  /** Seconds from send to the last token. */
  seconds?: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface ChatMessage {
  /** Local key (stable across the session's lifetime on screen). */
  id: string;
  /** Server message id, once known (history rows; live turns resolve lazily). */
  serverId?: string;
  role: 'user' | 'assistant';
  /** What the bubble shows (user) / the reply markdown (assistant). */
  text: string;
  /** User turns: the exact string sent to the server (annotation + text). */
  wire?: string;
  images?: { id: string; url?: string }[];
  /** User turns: the quoted context that rode along with the message. */
  annotation?: string | null;
  tools?: ToolStep[];
  reasoning?: string | null;
  sources?: Source[];
  web?: WebSource[];
  metrics?: Metrics | null;
  status?: 'thinking' | 'streaming' | 'done';
  error?: string;
  /** Assistant turns: the user stopped this reply (it may be partial or empty). */
  stopped?: boolean;
  /**
   * Assistant turns: the connection dropped and couldn't be re-attached — the
   * reply may still have finished server-side, so 重试 reloads before it
   * regenerates.
   */
  interrupted?: boolean;
  /** Appended in this session (animates in); history rows render static. */
  fresh?: boolean;
}

/** Context attached to the next message (a quote, a source to ask about). */
export interface Annotation {
  id: string;
  text: string;
}

/* ----------------------------- parsing helpers ----------------------------- */

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export function hostOf(url?: string): string | undefined {
  if (!url) return undefined;
  return url.replace(/^https?:\/\//, '').split('/')[0];
}

const WEB_TOOLS = new Set(['external_search', 'web_search']);

/** Web hits inside a web-search tool result (`[...]`, `{results}` or `{sources}`). */
export function webFromResult(tool: string, output: unknown): WebSource[] {
  if (!WEB_TOOLS.has(tool)) return [];
  const arr: unknown[] = Array.isArray(output)
    ? output
    : isObj(output)
      ? ((Array.isArray(output.results)
          ? output.results
          : Array.isArray(output.sources)
            ? output.sources
            : []) as unknown[])
      : [];
  const out: WebSource[] = [];
  for (const it of arr) {
    if (!isObj(it)) continue;
    const title = str(it.title);
    if (!title) continue;
    const url = str(it.url) ?? str(it.link);
    out.push({ title, url, host: hostOf(url) });
  }
  return out;
}

/** A knowledge doc the tool returned (any result carrying a `slug`). */
export function sourceFromResult(output: unknown): Source | null {
  if (!isObj(output)) return null;
  const slug = str(output.slug);
  if (!slug) return null;
  return {
    slug,
    title: str(output.title) ?? slug,
    category: str(output.category),
    body: str(output.content) ?? str(output.body),
  };
}

/** A tool result that reports failure (`{ error }`) marks the step as failed. */
export function isErrorResult(output: unknown): boolean {
  return isObj(output) && !!output.error;
}

/** Hydrate a persisted Message row into a renderable ChatMessage. */
export function fromStored(m: Message): ChatMessage {
  if (m.role === 'user') {
    return {
      id: m.id,
      serverId: m.id,
      role: 'user',
      text: m.content,
      wire: m.content,
      images: safeParse<{ id: string; url?: string }[]>(m.images, []),
      status: 'done',
    };
  }
  const pipeline = safeParse<Loose[]>(m.pipeline, []);
  const tools: ToolStep[] = pipeline.filter(isObj).map((s, i) => ({
    id: `t${i}`,
    tool: str(s.tool) ?? str(s.toolName) ?? 'tool',
    input: s.input,
    output: s.output,
    status: isErrorResult(s.output) ? 'error' : 'done',
    ms: typeof s.duration_ms === 'number' ? s.duration_ms : undefined,
  }));
  const refs = safeParse<Loose[]>(m.references_, []);
  const sources: Source[] = refs.filter(isObj).map((r) => ({
    slug: str(r.slug),
    title: str(r.title) ?? str(r.slug) ?? '—',
    category: str(r.category),
  }));
  const web = tools.flatMap((s) => webFromResult(s.tool, s.output));
  const metrics: Metrics | null =
    m.duration_ms != null || m.input_tokens != null || m.output_tokens != null
      ? {
          seconds: m.duration_ms != null ? m.duration_ms / 1000 : undefined,
          tokensIn: m.input_tokens ?? undefined,
          tokensOut: m.output_tokens ?? undefined,
        }
      : null;
  return {
    id: m.id,
    serverId: m.id,
    role: 'assistant',
    text: m.content,
    tools: tools.length ? tools : undefined,
    reasoning: m.reasoning || undefined,
    sources: sources.length ? sources : undefined,
    web: web.length ? web : undefined,
    metrics,
    status: 'done',
  };
}

/** Plain-text transcript for the share sheet. */
export function transcript(
  title: string,
  messages: ChatMessage[],
  labels: { user: string; assistant: string },
): string {
  const turns = messages
    .filter((m) => m.text.trim() || m.annotation)
    .map((m) => {
      const who = m.role === 'user' ? labels.user : labels.assistant;
      const quote = m.annotation ? `> ${m.annotation.replace(/\n/g, '\n> ')}\n\n` : '';
      return `${who}:\n${quote}${m.text.trim()}`;
    });
  return [title, ...turns].join('\n\n');
}

/** A one-line, length-capped excerpt (quotes, tool-input previews). */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * Markdown → readable plain text (quote chips, context-menu previews, table
 * cell widths): drops emphasis / code / strike markers, heading hashes, quote
 * markers, fences and table pipes; links and images keep their text.
 */
export function plainText(md: string): string {
  return md
    .replace(/^[ \t]*```.*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/gm, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*(\n|$)/gm, '')
    .replace(/^[ \t]*\|(.*)\|[ \t]*$/gm, (_m, row: string) =>
      row
        .split('|')
        .map((c) => c.trim())
        .join('  '),
    )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
