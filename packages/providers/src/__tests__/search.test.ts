import { describe, expect, it } from 'vitest';
import { isRetriable } from '../llm/models.js';
import { EndpointViolation } from '../pinned-fetch.js';
import {
  bochaAdapter,
  braveAdapter,
  exaAdapter,
  firecrawlAdapter,
  jinaAdapter,
  searxngAdapter,
  tavilyAdapter,
} from '../search/adapters.js';
import { KEY, connect, json, rejection, sent } from './fake-network.js';

describe('search adapters', () => {
  it('Tavily posts the query with a bearer key and normalises the rows', async () => {
    const { client, fake } = connect(tavilyAdapter, {}, () =>
      json({
        results: [
          {
            title: 'Greenhouse',
            url: 'https://example.com/a',
            content: 'A  glass\nbuilding',
            published_date: 'Mon, 13 Jan 2025 21:51:38 GMT',
          },
          { title: '', url: 'https://example.com/b', content: 'No title' },
          { title: 'No URL', content: 'dropped' },
          { title: 'Over the limit', url: 'https://example.com/c', content: 'cut' },
        ],
      }),
    );
    const results = await client.search('greenhouse', { limit: 2 });
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.tavily.com/search');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({
      query: 'greenhouse',
      max_results: 2,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    });
    expect(results).toEqual([
      {
        title: 'Greenhouse',
        url: 'https://example.com/a',
        snippet: 'A glass building',
        publishedAt: '2025-01-13T21:51:38.000Z',
      },
      { title: 'https://example.com/b', url: 'https://example.com/b', snippet: 'No title' },
    ]);
  });

  it('Brave sends the subscription token, caps count at 20 and strips highlight markup', async () => {
    const { client, fake } = connect(braveAdapter, {}, () =>
      json({
        web: {
          results: [
            {
              title: 'Rust &amp; Go',
              url: 'https://example.com/r',
              description: 'The <strong>borrow</strong> checker&#x27;s rules',
              page_age: '2024-08-16T17:41:12',
            },
          ],
        },
      }),
    );
    const results = await client.search('borrow checker', { limit: 50 });
    const { url, init, headers } = sent(fake);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
    expect(url.searchParams.get('q')).toBe('borrow checker');
    expect(url.searchParams.get('count')).toBe('20');
    expect(init.method).toBe('GET');
    expect(headers.get('x-subscription-token')).toBe(KEY);
    expect(headers.get('authorization')).toBeNull();
    // An offsetless timestamp is read as UTC, whatever the server's zone.
    expect(results).toEqual([
      {
        title: 'Rust & Go',
        url: 'https://example.com/r',
        snippet: "The borrow checker's rules",
        publishedAt: '2024-08-16T17:41:12.000Z',
      },
    ]);
  });

  it('Exa uses x-api-key, asks for highlights and turns them into the snippet', async () => {
    const { client, fake } = connect(exaAdapter, {}, () =>
      json({
        results: [
          {
            title: 'Survey',
            url: 'https://arxiv.org/abs/2307.06435',
            publishedDate: '2023-11-16T01:36:32.547Z',
            highlights: ['First point.', 'Second point.'],
          },
        ],
      }),
    );
    const results = await client.search('llm survey');
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.exa.ai/search');
    expect(init.method).toBe('POST');
    expect(headers.get('x-api-key')).toBe(KEY);
    expect(body).toEqual({ query: 'llm survey', numResults: 5, contents: { highlights: true } });
    expect(results).toEqual([
      {
        title: 'Survey',
        url: 'https://arxiv.org/abs/2307.06435',
        snippet: 'First point. … Second point.',
        publishedAt: '2023-11-16T01:36:32.547Z',
      },
    ]);
  });

  it('Jina searches without fetching pages and reads one page through the Reader', async () => {
    const { client, fake } = connect(jinaAdapter, {}, (url) =>
      url.startsWith('https://s.jina.ai/')
        ? json({
            code: 200,
            status: 20000,
            data: [{ title: 'Jina', url: 'https://jina.ai/', description: 'Search foundation', date: '2 days ago' }],
          })
        : json({
            code: 200,
            status: 20000,
            data: { title: 'Example Domain', url: 'https://example.com/', content: '# Example\n\nBody' },
          }),
    );
    // A relative date is no date.
    expect(await client.search('jina')).toEqual([
      { title: 'Jina', url: 'https://jina.ai/', snippet: 'Search foundation' },
    ]);
    const search = sent(fake, 0);
    expect(search.url.origin).toBe('https://s.jina.ai');
    expect(search.url.searchParams.get('q')).toBe('jina');
    expect(search.url.searchParams.get('num')).toBe('5');
    expect(search.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(search.headers.get('x-respond-with')).toBe('no-content');
    expect(search.headers.get('accept')).toBe('application/json');

    const page = await client.read!('https://example.com/#/route');
    const read = sent(fake, 1);
    expect(read.url.href).toBe('https://r.jina.ai/');
    expect(read.init.method).toBe('POST');
    expect(read.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(read.body).toEqual({ url: 'https://example.com/#/route' });
    expect(page).toEqual({ url: 'https://example.com/', title: 'Example Domain', content: '# Example\n\nBody' });
  });

  it('Firecrawl searches and scrapes Markdown with a bearer key', async () => {
    const { client, fake } = connect(firecrawlAdapter, {}, (url) =>
      url.endsWith('/v2/search')
        ? json({
            success: true,
            data: { web: [{ title: 'Firecrawl', description: 'Web data for agents', url: 'https://firecrawl.dev' }] },
          })
        : json({
            success: true,
            data: {
              markdown: '# Docs',
              metadata: {
                title: ['Docs', 'Docs (alternate)'],
                sourceURL: 'https://docs.example.com',
                url: 'https://docs.example.com/home',
                statusCode: 200,
              },
            },
          }),
    );
    expect(await client.search('scrape', { limit: 3 })).toEqual([
      { title: 'Firecrawl', url: 'https://firecrawl.dev', snippet: 'Web data for agents' },
    ]);
    const search = sent(fake, 0);
    expect(search.url.href).toBe('https://api.firecrawl.dev/v2/search');
    expect(search.init.method).toBe('POST');
    expect(search.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(search.body).toEqual({ query: 'scrape', limit: 3 });

    expect(await client.read!('https://docs.example.com')).toEqual({
      url: 'https://docs.example.com/home',
      title: 'Docs',
      content: '# Docs',
    });
    const scrape = sent(fake, 1);
    expect(scrape.url.href).toBe('https://api.firecrawl.dev/v2/scrape');
    expect(scrape.body).toEqual({ url: 'https://docs.example.com', formats: ['markdown'], onlyMainContent: true });
  });

  it('Firecrawl reports a page that answered with an error status, without inviting a fallback', async () => {
    const { client } = connect(firecrawlAdapter, {}, () =>
      json({ success: true, data: { markdown: 'Not found', metadata: { statusCode: 404 } } }),
    );
    const error = await rejection(client.read!('https://example.com/missing'));
    expect(error.message).toBe('Firecrawl could not read the page: it answered HTTP 404.');
    expect(error.statusCode).toBeUndefined();
  });

  it('SearXNG asks the configured instance for JSON without any key', async () => {
    const { client, fake } = connect(
      searxngAdapter,
      { baseUrl: 'https://searx.example.org/searxng/' },
      () =>
        json({
          results: [
            { title: 'One', url: 'https://one.example', content: 'first', publishedDate: '2024-05-01T08:00:00' },
            { title: 'Two', url: 'https://two.example', content: 'second', publishedDate: null },
          ],
        }),
      {},
    );
    expect(await client.search('results', { limit: 1 })).toEqual([
      { title: 'One', url: 'https://one.example', snippet: 'first', publishedAt: '2024-05-01T08:00:00.000Z' },
    ]);
    const { url, headers } = sent(fake);
    expect(`${url.origin}${url.pathname}`).toBe('https://searx.example.org/searxng/search');
    expect(url.searchParams.get('q')).toBe('results');
    expect(url.searchParams.get('format')).toBe('json');
    expect(headers.get('authorization')).toBeNull();
  });

  it('SearXNG has no default address and explains a disabled JSON format', async () => {
    expect(() => searxngAdapter.configSchema.parse({})).toThrow();
    const { client } = connect(
      searxngAdapter,
      { baseUrl: 'https://searx.example.org' },
      () => new Response('<html>Forbidden</html>', { status: 403 }),
      {},
    );
    await expect(client.search('x')).rejects.toThrow(
      'SearXNG search failed (HTTP 403). Enable the json format under search.formats in the SearXNG settings.yml.',
    );
  });

  it('Bocha posts to web-search and prefers the summary to the snippet', async () => {
    const { client, fake } = connect(bochaAdapter, {}, () =>
      json({
        code: 200,
        log_id: 'abc',
        msg: null,
        data: {
          webPages: {
            value: [
              {
                name: '博查',
                url: 'https://bochaai.com',
                snippet: 'short',
                summary: 'a longer summary',
                datePublished: '2024-07-22T00:00:00+08:00',
              },
            ],
          },
        },
      }),
    );
    expect(await client.search('博查')).toEqual([
      {
        title: '博查',
        url: 'https://bochaai.com',
        snippet: 'a longer summary',
        publishedAt: '2024-07-21T16:00:00.000Z',
      },
    ]);
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.bocha.cn/v1/web-search');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({ query: '博查', count: 5, summary: true });
  });

  it('fails with a short, actionable message that never repeats the key', async () => {
    const { client } = connect(tavilyAdapter, {}, () => json({ detail: { error: `Invalid API key: ${KEY}` } }, 401));
    const error = await rejection(client.search('x'));
    expect(error.message).toBe('Tavily search failed (HTTP 401): Invalid API key: ***. Check the API key.');
    expect(error.statusCode).toBe(401);
    expect(isRetriable(error)).toBe(false);
  });

  it('keeps the status so a rate-limited instance hands over to the next one', async () => {
    const { client } = connect(bochaAdapter, {}, () =>
      json({ message: 'You have reached the request limit', log_id: 'abc', code: '429' }, 429),
    );
    const error = await rejection(client.search('x'));
    expect(error.message).toBe(
      'Bocha search failed (HTTP 429): You have reached the request limit. Rate limited or out of quota; try again later.',
    );
    expect(isRetriable(error)).toBe(true);
  });

  it('names the host on a network failure and keeps the code for fallback', async () => {
    const { client } = connect(tavilyAdapter, {}, () => {
      const refused = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' });
      throw new TypeError('fetch failed', { cause: refused });
    });
    const error = await rejection(client.search('x'));
    expect(error.message).toBe(
      'Tavily search could not reach api.tavily.com (ECONNREFUSED). Check the base URL and the network.',
    );
    expect(isRetriable(error)).toBe(true);
  });

  it('reports a timeout as a retriable 408', async () => {
    const { client } = connect(exaAdapter, {}, () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    const error = await rejection(client.search('x'));
    expect(error.message).toBe('Exa search timed out after 30s. Try again.');
    expect(error.statusCode).toBe(408);
    expect(isRetriable(error)).toBe(true);
  });

  it('keeps a malformed key out of the error fetch raises when it rejects the header', async () => {
    const pasted = 'sk-pasted\nwith-a-line-break';
    const { client } = connect(
      tavilyAdapter,
      {},
      (_, init) => {
        new Headers(init.headers); // what the real fetch does first; it quotes the bad value
        return json({ results: [] });
      },
      { apiKey: pasted },
    );
    const error = await rejection(client.search('x'));
    expect(error.message).toContain('invalid header value');
    expect(error.message).not.toContain('sk-pasted');
  });

  it('never follows a redirect to another origin with the key', async () => {
    const { client, fake } = connect(
      braveAdapter,
      {},
      () => new Response(null, { status: 302, headers: { location: 'https://collector.example.net/q' } }),
    );
    await expect(client.search('x')).rejects.toBeInstanceOf(EndpointViolation);
    expect(fake).toHaveBeenCalledOnce();
    expect(sent(fake).url.origin).toBe('https://api.search.brave.com');
  });

  it('tests an instance with a one-result search', async () => {
    const { client, config, fake } = connect(exaAdapter, {}, () => json({ results: [] }));
    await exaAdapter.test!(client, config);
    expect(sent(fake).body).toMatchObject({ numResults: 1 });
  });
});
