import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
export const DOC = 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0';
export const DOC2 = 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P1';
export const DOC3 = 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P2';
const fence = (kind: string, value: unknown) =>
  `\n\n\`\`\`${kind}\n${typeof value === 'string' ? value : JSON.stringify(value)}\n\`\`\``;
export const POLICY =
  `两条都写在 [远程办公政策](#/knowledge/doc/${DOC}) 里：\n\n- 居家补贴：一次性 1,000 美元，每月 75 美元。\n- 核心工时：工作日 10:00–14:00。` +
  fence('stats', {
    items: [
      { label: '一次性补贴', value: '$1,000' },
      { label: '月度补贴', value: '$75' },
      { label: '核心工时', value: '4 小时' },
    ],
  });
export const RICH =
  '富块演示' +
  fence('cards', { items: [{ title: '政策卡片', subtitle: '远程办公', url: `#/knowledge/doc/${DOC}` }] }) +
  fence('steps', { items: [{ title: '核对政策', status: 'done' }] }) +
  fence('datatable', {
    columns: [
      { key: 'name', label: '补贴类型' },
      { key: 'amount', label: '金额', type: 'currency' },
    ],
    rows: [{ name: '居家', amount: 1000 }],
  }) +
  fence('chart', { type: 'bar', labels: ['一次性', '月度'], datasets: [{ label: '补贴', data: [1000, 75] }] }) +
  fence('mermaid', 'graph LR\nA[政策] --> B[报销]') +
  fence(
    'html-preview',
    '<!doctype html><html><head><title>补贴计算器</title></head><body><h1>预览可用</h1></body></html>',
  );
export async function installStation(page: Page) {
  const now = Date.now();
  const session = (id: string, title: string, age = 0, pinned = false) => ({
    id,
    title,
    pinned,
    profile_id: 'sprouty',
    channel: 'web',
    created_at: new Date(now - age).toISOString(),
    updated_at: new Date(now - age).toISOString(),
    is_owner: true,
  });
  const sessions = [
    session('policy-chat', '居家补贴和核心工时', 180000),
    session('shipment-chat', 'A-1001 发货状态', 3600000),
    session('ads-chat', '10 月亚马逊广告复盘', 7200000),
    session('pinned-chat', '周报模板：渠道与库存', 86400000, true),
    session('yesterday-chat', '事故复盘清单', 86400000),
  ];
  const messages = new Map<string, any[]>();
  const step = {
    step: 0,
    tool: 'knowledge_query',
    input: { query: '远程办公政策' },
    output: { docs: [{ id: DOC, title: '远程办公政策' }] },
  };
  const message = (id: string, role: string, content: string, seq: number, pipeline: unknown = null) => ({
    id,
    role,
    content,
    seq,
    pipeline: JSON.stringify(pipeline),
    images: null,
    references_: null,
    created_at: new Date().toISOString(),
    parts: {},
  });
  messages.set('policy-chat', [
    message('user-policy', 'user', '居家补贴多少？核心工时呢？引用制度原文。', 1),
    message('reply-policy', 'assistant', POLICY, 2, [step, step, step]),
  ]);
  messages.set('shared-chat', messages.get('policy-chat')!);
  const calls: any[] = [];
  const writes: string[] = [];
  let seq = 0,
    read = false;
  const notification = () => ({
    id: 'notice-1',
    user_id: 'member',
    kind: 'runtime_attention',
    title: 'Sprouty 需要你确认补贴申请',
    body: '打开远程办公政策',
    payload: { href: `#/knowledge/doc/${DOC}` },
    run_id: null,
    interrupt_id: null,
    event_id: null,
    agent_id: null,
    read_at: read ? new Date().toISOString() : null,
    created_at: new Date(now - 300000).toISOString(),
  });
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method();
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/extensions') return json({ extensions: [], entityKinds: [] });
    if (path === '/api/profiles')
      return json({
        profiles: [
          { id: 'sprouty', name: 'Sprouty' },
          { id: 'custom:ops', name: 'Ops Bot', is_custom: true },
        ],
      });
    if (path === '/api/sessions') {
      if (method === 'POST') {
        const s = session(`new-${++seq}`, '新对话');
        s.profile_id = req.postDataJSON()?.profile_id ?? 'sprouty';
        sessions.unshift(s);
        return json(s);
      }
      return json({
        sessions: url.searchParams.get('channel') === 'task' ? [session('scheduled-chat', '每日站会摘要')] : sessions,
        page: { has_more: false, next_offset: 0 },
      });
    }
    const match = /^\/api\/sessions\/([^/]+)(?:\/(messages|fork|pin))?$/.exec(path);
    if (match) {
      const [, id, operation] = match;
      const s = sessions.find((s) => s.id === id) ?? { ...session(id, '共享的政策'), is_owner: false };
      if (operation === 'messages')
        return json({ messages: messages.get(id) ?? [], has_more: false, next_before_seq: null });
      if (operation === 'fork') {
        const fork = session(`fork-${++seq}`, '政策 · 分支');
        sessions.unshift(fork);
        messages.set(fork.id, [...(messages.get(id) ?? [])]);
        writes.push(path);
        return json(fork);
      }
      if (operation === 'pin') {
        s.pinned = method === 'POST';
        writes.push(path);
        return json({ ok: true });
      }
      if (method === 'PATCH') {
        s.title = req.postDataJSON().title;
        writes.push(path);
        return json(s);
      }
      if (method === 'DELETE') {
        sessions.splice(sessions.indexOf(s), 1);
        writes.push(path);
        return json({ ok: true });
      }
      return json({ session: s, share_info: !s.is_owner ? { shared_by_nickname: '林杰' } : null });
    }
    if (/^\/api\/chat\/runs\/[^/]+\/stop$/.test(path)) {
      calls.push({ stop: true });
      return json({ ok: true });
    }
    if (/^\/api\/chat\/runs\/[^/]+$/.test(path)) return json({ active: false });
    if (path === '/api/chat-files/uploaded-file/content')
      return route.fulfill({
        contentType: 'text/plain',
        headers: { 'Content-Disposition': 'attachment; filename=notes.txt' },
        body: 'test content',
      });
    if (path === '/api/chat-files/upload') {
      writes.push(path);
      return json({ file: { id: 'uploaded-file', name: 'notes.txt', size: 12 } });
    }
    if (path === '/api/upload') {
      writes.push(path);
      return json({ id: 'uploaded-image', url: '/api/upload/uploaded-image' });
    }
    if (path === '/api/shares')
      return json({
        shares: [{ id: 'share-1', session_id: 'shared-chat', session_title: '共享的政策', shared_by_nickname: '林杰' }],
      });
    if (/^\/api\/shares\//.test(path)) return json({ ok: true });
    if (path === '/api/notifications/summary') return json({ unread: read ? 0 : 3 });
    if (path === '/api/notifications')
      return json({
        notifications: [
          notification(),
          ...['王宁在定价页文案里提到你', '每日站会摘要已生成', '陈思共享了双十一复盘.pptx'].map((title, index) => ({
            ...notification(),
            id: `notice-${index + 2}`,
            kind: 'system',
            title,
            read_at: read || index === 2 ? new Date().toISOString() : null,
          })),
        ],
        next_cursor: null,
      });
    if (path === '/api/notifications/read-all') {
      read = true;
      return json({ marked: 1 });
    }
    if (/^\/api\/notifications\/[^/]+\/read$/.test(path)) {
      read = true;
      return json({ notification: notification() });
    }
    if (path === '/api/activity/recent')
      return json({
        items: [
          {
            id: 'activity-1',
            source: 'person',
            at: new Date().toISOString(),
            actor: { id: 'lin', name: '林杰' },
            agent: null,
            module: 'knowledge',
            verb: 'updated',
            entity: 'kb_doc',
            action: 'update',
            action_title: '更新政策',
            target: { id: DOC, label: '远程办公政策', url: `#/knowledge/doc/${DOC}` },
            run: null,
            detail: null,
          },
        ],
        next_before: null,
      });
    if (path === '/api/search')
      return json({
        groups: [
          { kind: 'kb_doc', items: [{ title: '远程办公政策', ref: { kind: 'kb_doc', id: DOC } }] },
          { kind: 'session', items: [{ title: '居家补贴和核心工时', sessionId: 'policy-chat' }] },
        ],
      });
    if (path === '/api/drive/search') return json({ files: [] });
    if (path === '/api/refs/resolve')
      return json({
        items: (req.postDataJSON()?.urls ?? []).map((url: string) => ({
          url,
          type: 'doc',
          id: url.includes(DOC2) ? DOC2 : url.includes(DOC3) ? DOC3 : DOC,
          title: url.includes(DOC2) ? '报销流程' : url.includes(DOC3) ? '设备清单' : '远程办公政策',
        })),
      });
    if (path.startsWith('/api/knowledge/docs/')) {
      const id = path.split('/').at(-1)!;
      const title = id === DOC ? '远程办公政策' : id === DOC2 ? '报销流程' : '设备清单';
      return json({
        doc: {
          id,
          title,
          slug: id,
          visibility: 'team',
          status: 'published',
          updated_at: new Date(now).toISOString(),
          content_markdown: `Greenhouse 是全远程公司。\n\n## 核心工时\n\n工作日 10:00–14:00 保持可联系。\n\n## 居家补贴\n\n一次性 1,000 美元，每月 75 美元。\n\n[报销流程](#/knowledge/doc/${DOC2}) · [设备清单](#/knowledge/doc/${DOC3}) · [远程办公政策](#/knowledge/doc/${DOC})`,
        },
      });
    }
    return route.fallback();
  });
  // Exercise a real ReadableStream with separated NDJSON chunks. Route.fulfill
  // buffers the entire body, which cannot prove stop or intermediate rendering.
  await page.exposeFunction('__c2Turn', (body: any) => {
    calls.push(body);
    const id = body.session_id;
    const text = body.messages?.[0]?.content ?? '';
    const saved = messages.get(id) ?? [];
    if (body.regenerate_assistant_message_id)
      saved.splice(saved.findIndex((m) => m.id === body.regenerate_assistant_message_id));
    else saved.push(message(`u-${++seq}`, 'user', text, saved.length + 1));
    const ask = {
      type: 'ask_user',
      title: '补贴用途',
      questions: [
        {
          id: 'purpose',
          label: '请选择用途',
          type: 'single_choice',
          required: true,
          options: [
            { value: 'desk', label: '办公桌椅' },
            { value: 'network', label: '网络' },
          ],
        },
      ],
    };
    const content = body.regenerate_assistant_message_id
      ? '重新生成完成'
      : text.includes('问我')
        ? '请先选择补贴用途。'
        : text.includes('富块')
          ? RICH
          : text.includes('长回复')
            ? '正在生成，稍后完成。'
            : POLICY;
    const reply = message(
      `a-${++seq}`,
      'assistant',
      '',
      saved.length + 1,
      text.includes('问我') ? [{ tool: 'ask_user', output: ask }] : [step],
    );
    saved.push(reply);
    messages.set(id, saved);
    return { id: reply.id, content, slow: text.includes('长回复'), ask: text.includes('问我') ? ask : null };
  });
  await page.exposeFunction('__c2Save', (id: string, content: string) => {
    for (const saved of messages.values()) {
      const reply = saved.find((m) => m.id === id);
      if (reply) reply.content = content;
    }
  });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const stopped = new Set<string>();
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof Request ? input.url : String(input),
        location.href,
      );
      const stop = /^\/api\/chat\/runs\/([^/]+)\/stop$/.exec(url.pathname);
      if (stop) stopped.add(stop[1]);
      if (url.pathname !== '/api/chat' || init?.method !== 'POST') return original(input, init);
      const body = JSON.parse(String(init.body));
      stopped.delete(body.session_id);
      const turn = await (window as any).__c2Turn(body);
      const encoder = new TextEncoder();
      let content = '';
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
          if (turn.ask) {
            emit({ type: 'tool-call-start', id: 'ask', toolName: 'ask_user' });
            emit({ type: 'tool-result', id: 'ask', toolName: 'ask_user', output: turn.ask });
          }
          const chunks = turn.slow
            ? ['正在生成', '，请稍候', '，最终完成。']
            : [turn.content.slice(0, 10), turn.content.slice(10)];
          for (const chunk of chunks) {
            await new Promise((r) => setTimeout(r, turn.slow ? 700 : 180));
            if (stopped.has(body.session_id) || init.signal?.aborted) break;
            content += chunk;
            await (window as any).__c2Save(turn.id, content);
            emit({ type: 'text-delta', text: chunk });
          }
          emit({ type: 'finish', finishReason: stopped.has(body.session_id) ? 'cancelled' : 'stop' });
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  return { calls, writes, sessions, messages };
}
export async function shot(page: Page, design: string, width: number) {
  mkdirSync('tests/client-e2e/__screenshots__', { recursive: true });
  await page.screenshot({
    path: `tests/client-e2e/__screenshots__/${design.startsWith('c4-') ? design : `c4-${design}`}-${width}.png`,
  });
}
