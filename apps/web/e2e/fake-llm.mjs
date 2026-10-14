/**
 * A deterministic OpenAI-compatible model for the browser tests. Replies depend only on the
 * last user message:
 *   "slow …"      streams for about four seconds (to stop it)
 *   "ask me …"    calls ask_user with one question
 *   "remember X"  calls the memory tool, then confirms
 *   "need a human …" asks the member to take over the computer (request_takeover)
 *   "look up …"   searches the knowledge base (knowledge_query), then links the first doc found
 *   "keep a note …" writes a doc into the Agent's own reference folder (knowledge_mutation)
 *   mail arrived (the wake note)  reads it with the mail tool, then says its subject
 *   "reply to the mail …" replies to the newest mail in the conversation (an approval card)
 *   "check my mailbox …"  searches the member's own mailbox (mcp_call, the built-in connector)
 *   anything else "Echo: <message>", in a few chunks
 * Titles and summaries (non-streaming calls) get fixed answers. The same server is the
 * connectors' MCP servers and their sign-in (fake-mcp.mjs), Resend and a member's mailbox
 * (fake-mail.mjs), and an OpenAI-compatible speech service for the voice tests: any recording
 * is SPOKEN (/v1/audio/transcriptions), any text a short silence (/v1/audio/speech).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { handleMail } from './fake-mail.mjs';
import { handleMcp } from './fake-mcp.mjs';

const port = Number(process.argv[2] ?? process.env.FAKE_LLM_PORT ?? 4592);

/** What every recording says. */
const SPOKEN = '帮我把本周进度整理成周报';

/** `seconds` of 8 kHz 16-bit mono silence as a WAV file. */
function silence(seconds) {
  const data = Math.round(seconds * 8000) * 2;
  const wav = Buffer.alloc(44 + data);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + data, 4);
  wav.write('WAVEfmt ', 8, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(data, 40);
  return wav;
}

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
/** The first doc in a knowledge_query search result. */
const DOC_HIT = /"type":"doc","id":"(doc_\w+)","title":"([^"]*)"/;

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
      .replace(/\[event\][^\n]*\n\n/g, '')
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
  // Mail at the Agent's address wakes it with a note naming the mail (modules/mail/wake.ts).
  const closing = textOf(messages.filter((message) => message.role === 'user').at(-1)?.content ?? '');
  const mailWake = /New mail arrived in your mailbox|let in mail that had been held back/.test(closing);
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

  if (/M24 source one: succeeded/.test(closing)) {
    await say('Helper reports combined.', 10);
  } else if (!afterTool && !mailWake && /^delegate helpers/i.test(said)) {
    tool('helper_run', {
      briefs: [
        { title: 'M24 source one', brief: 'Summarize source one.' },
        { title: 'M24 source two', brief: 'Summarize source two.' },
      ],
    });
  } else if (!afterTool && /^change table record /i.test(said)) {
    const [, table_id, record_id, field_id] = /^change table record (\S+) (\S+) (\S+)/i.exec(said) ?? [];
    tool('table_mutation', {
      action: 'update',
      table_id,
      record_id,
      revision: 1,
      values: { [field_id]: 'Approved record' },
    });
  } else if (!afterTool && /^read table record /i.test(said)) {
    tool('table_query', { action: 'read', record_id: /^read table record (\S+)/i.exec(said)?.[1] });
  } else if (!afterTool && mailWake) {
    tool('mail', { action: 'read', id: /\bmal_[0-9A-Z]{26}\b/.exec(closing)?.[0] ?? '' });
  } else if (afterTool && toolText.includes('mail_body')) {
    await say(`Read the mail: ${/"subject":\s*"((?:[^"\\]|\\.)*)"/.exec(toolText)?.[1] ?? ''}`, 10);
  } else if (!afterTool && /^reply to the mail/i.test(said)) {
    const ids = [...JSON.stringify(messages).matchAll(/\bmal_[0-9A-Z]{26}\b/g)].map((match) => match[0]);
    tool('mail', { action: 'reply', id: ids.at(-1) ?? '', body: 'Thanks, we got it.' });
  } else if (!afterTool && /^check my mailbox/i.test(said)) {
    tool('mcp_call', { action: 'call', connector: 'mailbox', tool: 'search_messages', arguments: {} });
  } else if (afterTool && toolText.includes('search_messages')) {
    await say(`Found mail: ${/subject\\?":\s*\\?"([^"\\]+)/.exec(toolText)?.[1] ?? 'nothing'}`, 10);
  } else if (!afterTool && /^ask me/i.test(said)) {
    tool('ask_user', { question: 'Which city?', fields: [{ key: 'city', label: 'City', type: 'text' }] });
  } else if (!afterTool && /^make image/i.test(said)) {
    tool('generate_image', {
      prompt: said,
      ...(said.match(/fil_[0-9A-Z]{26}/) ? { reference_file_id: said.match(/fil_[0-9A-Z]{26}/)[0] } : {}),
    });
  } else if (!afterTool && /^make video/i.test(said)) {
    tool('generate_video', { prompt: said, seconds: 4 });
  } else if (!afterTool && /^remember /i.test(said)) {
    tool('memory', { action: 'remember', title: said.slice(9).trim(), category: 'fact' });
  } else if (!afterTool && /^need a human/i.test(said)) {
    tool('request_takeover', { reason: 'Solve the human check on the sign-in page' });
  } else if (!afterTool && /^search the web/i.test(said)) {
    tool('web_search', { query: said.slice(15).trim() || 'kyoto' });
  } else if (afterTool && toolText.includes('kyoto.example')) {
    await say('Found it: [Kyoto guide](https://kyoto.example/guide).', 10);
  } else if (!afterTool && /^background draft in /i.test(said)) {
    const folder = /background draft in (fld_[0-9A-HJKMNP-TV-Z]{26})/i.exec(said)?.[1];
    tool('run_start', {
      title: 'E2E always-on background',
      brief: `AO_E2E_GATE ${folder}`,
      computer: false,
      domains: [],
      continue_after: false,
    });
  } else if (!afterTool && /^shared draft in /i.test(said)) {
    const folder = /shared draft in (fld_[0-9A-HJKMNP-TV-Z]{26})/i.exec(said)?.[1];
    tool('knowledge_mutation', { action: 'create', title: 'Shared agent draft', content: said, folder_id: folder });
  } else if (!afterTool && /^keep a note/i.test(said)) {
    tool('knowledge_mutation', { action: 'create', title: 'Agent note', content: said, space: 'agent' });
  } else if (!afterTool && /^look up /i.test(said)) {
    tool('knowledge_query', { action: 'search', query: said.slice(8).trim() });
  } else if (afterTool && DOC_HIT.test(toolText)) {
    const [, id, title] = DOC_HIT.exec(toolText);
    await say(`Found it in [${title}](#/knowledge/${id}).`, 10);
  } else if (afterTool) {
    await say('Done.', 20);
  } else if (/^show (chart|table|choices|diagram|page|stats)/i.test(said)) {
    await say(RICH[/^show (chart|table|choices|diagram|page|stats)/i.exec(said)[1].toLowerCase()], 5);
  } else if (/^slow/i.test(said)) {
    await say(`Thinking about it slowly. ${'More words keep coming. '.repeat(12)}`, 80);
  } else {
    await say(`Echo: ${said}`, 30);
  }
  chunk(response, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  response.end('data: [DONE]\n\n');
}

function complete(response, request) {
  const gate = /AO_E2E_GATE (fld_[0-9A-HJKMNP-TV-Z]{26})/.exec(JSON.stringify(request.messages));
  if (
    gate &&
    JSON.stringify(request.messages?.filter((message) => message.role === 'system')).includes(
      'working in the background',
    )
  ) {
    const count = (request.messages ?? []).filter((message) => message.role === 'tool').length;
    const name = count < 2 ? 'knowledge_mutation' : 'run_finish';
    const args =
      count === 0
        ? { action: 'create', title: 'E2E background private draft', content: 'Draft', space: 'agent' }
        : count === 1
          ? { action: 'create', title: 'E2E background shared draft', content: 'Shared draft', folder_id: gate[1] }
          : { report: 'Background finished.', findings: ['Shared draft'] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'chatcmpl-bg-e2e',
        object: 'chat.completion',
        created: 1,
        model: 'fake',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: `bg_${count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      }),
    );
    return;
  }
  const system = JSON.stringify(request.messages?.filter((message) => message.role === 'system') ?? []);
  const text = system.includes('read-only helper run')
    ? 'A bounded helper summary.'
    : system.includes('Write a title for this conversation')
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
    if (request.url?.startsWith('/v1/images/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          data: [
            {
              b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=',
            },
          ],
        }),
      );
    }
    if (request.url?.startsWith('/openai/v1/videos')) {
      if (request.url.endsWith('/content')) {
        response.writeHead(200, { 'content-type': 'video/mp4' });
        return response.end(readFileSync(new URL('./fixtures/media.mp4', import.meta.url)));
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          id: 'video_e2e',
          status: request.method === 'POST' ? 'queued' : 'completed',
          progress: request.method === 'POST' ? 0 : 100,
        }),
      );
    }
    // The connectors' MCP servers and their sign-in (fake-mcp.mjs).
    if (handleMcp(request, response, raw, `http://127.0.0.1:${port}`)) return;
    if (handleMail(request, response, raw, `http://127.0.0.1:${port}`)) return;
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
    // Speech, before the model: a recording is multipart, not JSON.
    if (request.url === '/v1/audio/transcriptions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ text: SPOKEN }));
    }
    if (request.url === '/v1/audio/speech') {
      response.writeHead(200, { 'content-type': 'audio/wav' });
      // Long enough to still be playing when a test clicks another reply.
      return response.end(silence(3));
    }
    const body = raw ? JSON.parse(raw) : {};
    const invalid = body.tools?.find(
      ({ function: fn }) =>
        fn.parameters?.type !== 'object' ||
        !fn.parameters.properties ||
        ['anyOf', 'oneOf', 'allOf'].some((key) => key in fn.parameters),
    );
    if (invalid) {
      response.writeHead(400, { 'content-type': 'application/json' });
      return response.end(
        JSON.stringify({
          error: {
            message: `Invalid schema for function '${invalid.function.name}': parameters must be a root object.`,
          },
        }),
      );
    }
    if (process.env.FAKE_LLM_LOG) writeFileSync(process.env.FAKE_LLM_LOG, JSON.stringify(body, null, 2));
    if (body.stream) void stream(response, body);
    else complete(response, body);
  });
}).listen(port, '127.0.0.1', () => console.log(`fake llm on ${port}`));
