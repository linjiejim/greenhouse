/**
 * A deterministic OpenAI-compatible model for the browser tests. Replies depend only on the
 * last user message:
 *   "slow …"      streams for about four seconds (to stop it)
 *   "ask me …"    calls ask_user with one question
 *   "remember X"  calls the memory tool, then confirms
 *   anything else "Echo: <message>", in a few chunks
 * Titles and summaries (non-streaming calls) get fixed answers.
 */

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.FAKE_LLM_PORT ?? 4592);
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
  const afterTool = last?.role === 'tool';
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
    tool('ask_user', { questions: [{ id: 'city', label: 'Which city?', kind: 'text' }] });
  } else if (!afterTool && /^remember /i.test(said)) {
    tool('memory', { action: 'remember', title: said.slice(9).trim(), category: 'fact' });
  } else if (afterTool) {
    await say('Done.', 20);
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
