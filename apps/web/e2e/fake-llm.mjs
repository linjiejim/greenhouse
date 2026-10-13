/**
 * A deterministic OpenAI-compatible model for the browser tests. Replies depend only on the
 * last user message:
 *   "slow …"      streams for about four seconds (to stop it)
 *   "ask me …"    calls ask_user with one question
 *   "remember X"  calls the memory tool, then confirms
 *   "need a human …" asks the member to take over the computer (request_takeover)
 *   anything else "Echo: <message>", in a few chunks
 * Titles and summaries (non-streaming calls) get fixed answers. The same server is the
 * connectors' MCP servers and their sign-in (fake-mcp.mjs).
 */

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { handleMcp } from './fake-mcp.mjs';

const port = Number(process.argv[2] ?? process.env.FAKE_LLM_PORT ?? 4592);

/** Replies with one rich block each (packages/types rich-output), for "show …". */
const fence = (name, body) => '```' + name + '\n' + body + '\n```';
const RICH = {
  chart: `Sales this week:\n\n${fence('chart', JSON.stringify({ type: 'bar', title: 'Sales', labels: ['Mon', 'Tue', 'Wed'], datasets: [{ label: 'Orders', data: [3, 5, 2] }] }))}`,
  table: `Here is the table.\n\n${fence(
    'datatable',
    JSON.stringify({
      title: 'Tasks',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'hours', label: 'Hours', type: 'number' },
      ],
      rows: [
        { name: 'Design', hours: 4 },
        { name: 'Build', hours: 9 },
      ],
    }),
  )}`,
  choices: `Pick one.\n\n${fence(
    'confirm',
    JSON.stringify({
      text: 'Which plan?',
      actions: [
        { label: 'Plan A', value: 'go with plan A', variant: 'primary' },
        { label: 'Plan B', value: 'go with plan B' },
      ],
    }),
  )}`,
  diagram: fence('mermaid', 'graph TD\n  A[Start] --> B[Done]'),
  page: fence(
    'html-preview',
    '<!doctype html><html><head><title>Picker</title></head><body><button id="go" onclick="window.greenhouse.sendPrompt(\'from the page\')">Send</button></body></html>',
  ),
  stats: fence(
    'stats',
    JSON.stringify({
      title: 'This week',
      items: [
        { label: 'Orders', value: 128, delta: '+12%', trend: 'up', tone: 'positive' },
        { label: 'Refunds', value: 3 },
      ],
    }),
  ),
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part.type === 'text' ? part.text : '')).join('')
      : '';

/** The member's own words: the last user message, without its time stamp and the turn's closing context. */
function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') continue;
    const text = textOf(messages[i].content)
      .split('<turn_context')[0]
      .replace(/^(\s*\[[^\]]*\])+\s*/, '')
      .trim();
    if (text) return text;
  }
  return '';
}

function chunk(response, body) {
  response.write(
    `data: ${JSON.stringify({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: 1, model: 'fake', ...body })}\n\n`,
  );
}

async function stream(response, request) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const messages = request.messages ?? [];
  const last = messages[messages.length - 1];
  const said = lastUser(messages);
  // A turn woken by a decision (an answer, an approval) carries it in the closing context.
  const woken = /answered your question|approved|rejected|dismissed|handed your computer back/i.test(
    textOf(messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''),
  );
  const afterTool = last?.role === 'tool' || woken;
  const toolText = last?.role === 'tool' ? textOf(last.content) : '';
  const tool = (name, args) => {
    chunk(response, {
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  };
  const say = async (text, pause) => {
    for (const piece of text.match(/.{1,6}/gs) ?? []) {
      if (response.destroyed) return;
      chunk(response, { choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] });
      await sleep(pause);
    }
    chunk(response, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  };

  if (!afterTool && /^ask me/i.test(said)) {
    tool('ask_user', { question: 'Which city?', fields: [{ key: 'city', label: 'City', type: 'text' }] });
  } else if (!afterTool && /^remember /i.test(said)) {
    tool('memory', { action: 'remember', title: said.slice(9).trim(), category: 'fact' });
  } else if (!afterTool && /^need a human/i.test(said)) {
    tool('request_takeover', { reason: 'Solve the human check on the sign-in page' });
  } else if (!afterTool && /^search the web/i.test(said)) {
    tool('web_search', { query: said.slice(15).trim() || 'kyoto' });
  } else if (afterTool && toolText.includes('kyoto.example')) {
    await say('Found it: [Kyoto guide](https://kyoto.example/guide).', 10);
  } else if (afterTool) {
    await say('Done.', 20);
  } else if (/^show (chart|table|choices|diagram|page|stats)/i.test(said)) {
    await say(RICH[said.split(' ')[1].toLowerCase()], 5);
  } else if (/^slow/i.test(said)) {
    await say(`Thinking about it slowly. ${'More words keep coming. '.repeat(12)}`, 80);
  } else {
    await say(`Echo: ${said}`, 30);
  }
  chunk(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  response.end('data: [DONE]\n\n');
}

function complete(response, request) {
  const system = JSON.stringify(request.messages?.filter((message) => message.role === 'system') ?? []);
  const text = system.includes('Write a title for this conversation')
    ? 'E2E chat'
    : system.includes('You maintain the rolling summary')
      ? '{}'
      : `Echo: ${lastUser(request.messages ?? [])}`;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      id: 'chatcmpl-e2e',
      object: 'chat.completion',
      created: 1,
      model: 'fake',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    }),
  );
}

createServer((request, response) => {
  let raw = '';
  request.on('data', (part) => (raw += part));
  request.on('end', () => {
    // The connectors' MCP servers and their sign-in (fake-mcp.mjs).
    if (handleMcp(request, response, raw, `http://127.0.0.1:${port}`)) return;
    if (request.method === 'GET' && request.url?.startsWith('/search')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          results: [
            { title: 'Kyoto guide', url: 'https://kyoto.example/guide', content: 'Temples and trains.' },
            { title: 'Osaka food', url: 'https://osaka.example/food', content: 'Street food.' },
          ],
        }),
      );
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ data: [{ id: 'fake', object: 'model' }] }));
    }
    const body = raw ? JSON.parse(raw) : {};
    if (process.env.FAKE_LLM_LOG) writeFileSync(process.env.FAKE_LLM_LOG, JSON.stringify(body, null, 2));
    if (body.stream) void stream(response, body);
    else complete(response, body);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake llm on ${port}`));
