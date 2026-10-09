import type { APIRequestContext, Page, Route } from '@playwright/test';
import type {
  BotConversationDetail,
  BotConversationSummary,
  BotMessage,
  BotRequestView,
  BotView,
} from '@greenhouse/types/bots';
import { test, expect } from './fixtures';

/**
 * Bots page — first visit against the REAL API, the rest with a stubbed one.
 *
 * First visit needs no model and no computer (bootstrap writes a fixed
 * greeting), so it runs end to end: GET /api/bots, the conversation list,
 * POST /api/bots/bootstrap and the conversation detail are the real routes,
 * which is what catches a renamed field (`dm_session_id`…) the stubs would hide.
 * It archives the test user's Bots before and after — all but Sprouty, the built-in main Bot,
 * which cannot be archived.
 *
 * Streaming, cards, a retired group chat and the 202 busy path stay STUBBED —
 * deterministic, no model: every `/api/bots*` call and `POST /api/chat` is
 * answered by page.route (the same NDJSON transport Chat uses, plus the
 * multi-speaker events bot-turn-start / bot-turn-end / bot-request). The
 * fixtures are typed against @greenhouse/types/bots (`satisfies`) so they
 * follow the contract.
 */

const NOW = '2026-10-05T08:00:00.000Z';

function bot(
  id: string,
  name: string,
  role: string,
  color: string,
  dm: string | null,
  template: string | null = null,
): BotView {
  return {
    id,
    name,
    role,
    instructions: `${name} instructions`,
    avatar: { color },
    model_id: null,
    template_key: template,
    status: 'active',
    dm_session_id: dm,
    last_active_at: NOW,
    created_at: NOW,
  } satisfies BotView;
}

const IVY = bot('bot_ivy', 'Ivy', 'Chief of staff', 'forest', 'dm-ivy', 'chief');
const SPROUTY = bot('bot_sprouty', 'Sprouty', 'Main assistant', 'forest', 'dm-sprouty', 'sprouty');
const SAGE = bot('bot_sage', 'Sage', 'Researcher', 'ocean', 'dm-sage', 'researcher');
const FERN = bot('bot_fern', 'Fern', 'Writer', 'blossom', 'dm-fern', 'writer');

type Json = Record<string, unknown>;

function message(seq: number, partial: Partial<BotMessage>): BotMessage {
  return {
    id: `msg-${seq}`,
    role: 'assistant',
    content: '',
    bot_id: null,
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: NOW,
    seq,
    ...partial,
  } satisfies BotMessage;
}

/**
 * A DM (the first Bot owns it, the rest are guests) or — history only — a retired group chat
 * (the first Bot led it).
 */
function summary(
  sessionId: string,
  kind: 'direct' | 'group',
  members: BotView[],
  extra: Partial<BotConversationSummary> = {},
): BotConversationSummary {
  return {
    session_id: sessionId,
    kind,
    title: kind === 'group' ? 'Launch prep' : null,
    owner_bot_id: kind === 'direct' ? members[0].id : null,
    lead_bot_id: members[0].id,
    members: members.map((member, position) => ({
      bot_id: member.id,
      role: kind === 'direct' ? (position === 0 ? 'owner' : 'guest') : position === 0 ? 'lead' : 'member',
      position,
    })),
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    last_activity_at: NOW,
    ...extra,
  } satisfies BotConversationSummary;
}

function detail(base: BotConversationSummary, requests: BotRequestView[] = []): BotConversationDetail {
  return {
    ...base,
    description: '',
    allow_bot_chat: true,
    digest: null,
    notes: [],
    requests,
    context: { estimated_tokens: 1200, threshold: 24000 },
  } satisfies BotConversationDetail;
}

const ndjson = (events: Json[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

/** A tiny fake of the Bots API; each test edits `state` to shape the conversation. */
interface FakeState {
  bots: BotView[];
  conversations: BotConversationSummary[];
  pages: Record<string, { detail: BotConversationDetail; messages: BotMessage[] }>;
  decisions: Array<{ id: string; body: Json }>;
}

async function stubBots(page: Page, state: FakeState) {
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route(/\/api\/bots(\/|\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^\/api\/bots/, '') || '/';
    const method = request.method();

    if (path === '/' && method === 'GET') {
      return json(route, {
        bots: state.bots,
        archived_bots: [],
        computer: { state: 'disabled', reason: null, hardened: false },
        vault_available: true,
        pending_requests: 0,
      });
    }
    if (path === '/conversations' && method === 'GET') return json(route, { conversations: state.conversations });
    // The sidebar makes sure Sprouty exists; these fixtures are about other Bots.
    if (path === '/bootstrap' && method === 'POST') {
      return json(route, { bot: SPROUTY, dm_session_id: SPROUTY.dm_session_id, created: false });
    }
    if (path === '/computer' && method === 'GET') {
      return json(route, {
        runtime: { state: 'disabled', reason: null, hardened: false },
        state: 'absent',
        state_reason: null,
        controller: 'bot',
        controller_since: null,
        last_active_at: null,
        queue_position: null,
        disk_bytes: null,
      });
    }
    const requestMatch = /^\/requests\/([^/]+)$/.exec(path);
    if (requestMatch && method === 'POST') {
      const id = decodeURIComponent(requestMatch[1]);
      const body = request.postDataJSON() as Json;
      state.decisions.push({ id, body });
      for (const entry of Object.values(state.pages)) {
        const requests = entry.detail.requests.map(
          (candidate): BotRequestView =>
            candidate.id === id
              ? {
                  ...candidate,
                  status: body.decision === 'deny' ? 'denied' : 'resolved',
                  result: { decision: body.decision },
                }
              : candidate,
        );
        entry.detail = { ...entry.detail, requests };
      }
      const settled = Object.values(state.pages)
        .flatMap((entry) => entry.detail.requests)
        .find((candidate) => candidate.id === id);
      return json(route, { request: settled });
    }
    const conversationMatch = /^\/conversations\/([^/]+)(\/[a-z]+)?$/.exec(path);
    if (conversationMatch) {
      const sessionId = decodeURIComponent(conversationMatch[1]);
      const sub = conversationMatch[2] ?? '';
      const entry = state.pages[sessionId];
      if (!entry) return json(route, { error: 'Not found' }, 404);
      if (sub === '' && method === 'GET') {
        return json(route, { conversation: entry.detail, messages: entry.messages, has_more: false });
      }
      if (sub === '/read') return json(route, { ok: true });
      if (sub === '/tasks') return json(route, { tasks: [] });
      if (sub === '/notes') return json(route, { notes: [] });
    }
    return json(route, { error: `unstubbed ${method} ${path}` }, 404);
  });
}

function freshState(): FakeState {
  return { bots: [], conversations: [], pages: {}, decisions: [] };
}

/**
 * Archive every active Bot the e2e user owns but Sprouty, which cannot be archived (their DMs
 * stay, read-only — that is the product).
 */
async function archiveAllBots(api: APIRequestContext): Promise<void> {
  const res = await api.get('/api/bots');
  expect(res.ok(), `GET /api/bots → ${res.status()}`).toBe(true);
  const { bots } = (await res.json()) as { bots: Array<Pick<BotView, 'id' | 'template_key'>> };
  for (const { id, template_key } of bots) {
    if (template_key === 'sprouty') continue;
    const archived = await api.delete(`/api/bots/${encodeURIComponent(id)}`);
    expect(archived.ok(), `DELETE /api/bots/${id} → ${archived.status()}`).toBe(true);
  }
}

test.describe('bots — real API', () => {
  test.beforeEach(async ({ api }) => archiveAllBots(api));
  test.afterEach(async ({ api }) => archiveAllBots(api));

  test('first visit lands in the DM of Sprouty, the built-in main Bot, with a fixed greeting', async ({
    page,
    api,
  }) => {
    await page.goto('/#/bots');

    // Bootstrap made sure Sprouty exists (it is the only active Bot), and the page opened its DM.
    await expect(page).toHaveURL(/#\/bots\?c=[^&]+$/);
    const res = await api.get('/api/bots');
    const { bots } = (await res.json()) as { bots: BotView[] };
    expect(bots).toHaveLength(1);
    const [first] = bots;
    expect(first).toMatchObject({ name: 'Sprouty', template_key: 'sprouty' });
    expect(first.dm_session_id).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`#/bots\\?c=${first.dm_session_id}$`));

    // The fixed greeting (no model call) names the Bot.
    const transcript = page.getByTestId('bots-transcript');
    await expect(transcript).toContainText(first.name);
    await expect(page.getByTestId('bots-conversation-header')).toContainText(first.name);
    // The greeting is the last word, so its starters are offered — and only prefill.
    const starter = page.getByTestId('bots-starters').getByRole('button').first();
    await expect(starter).toBeVisible();
    await starter.click();
    await expect(page.getByTestId('chat-input')).not.toHaveValue('');
    // The sidebar pins its DM first.
    const firstRow = page.getByTestId('bots-sidebar').getByTestId('bots-conversation-row').first();
    await expect(firstRow).toHaveAttribute('data-session-id', first.dm_session_id!);
    await expect(firstRow).toHaveAttribute('data-pinned', 'true');
  });

  test("an archived Bot's DM is read-only and points to a new Bot", async ({ page, api }) => {
    const made = await api.post('/api/bots', { data: { template_key: 'writer' } });
    expect(made.ok(), `POST /api/bots → ${made.status()}`).toBe(true);
    const { bot: created, dm_session_id: dm } = (await made.json()) as { bot: BotView; dm_session_id: string };
    await archiveAllBots(api);

    await page.goto(`/#/bots?c=${encodeURIComponent(dm)}`);
    await expect(page.getByTestId('bots-read-only')).toBeVisible();
    await expect(page.getByTestId('bots-conversation-header')).toContainText(created.name);
    await expect(page.getByTestId('chat-input')).toHaveCount(0);
    // The API agrees: nobody can answer there, and nothing is persisted.
    const sent = await api.post('/api/chat', {
      data: { session_id: dm, messages: [{ role: 'user', content: 'are you there?' }] },
    });
    expect(sent.status()).toBe(409);
  });
});

test.describe('bots', () => {
  test('a DM reply brings in a guest Bot: it joins, speaks under its name, and the hand-off shows', async ({
    page,
  }) => {
    const state = freshState();
    state.bots = [IVY, SAGE, FERN];
    const dm = summary('dm-sage', 'direct', [SAGE]);
    state.conversations = [dm];
    state.pages['dm-sage'] = { detail: detail(dm), messages: [] };
    await stubBots(page, state);

    let posted: Json | null = null;
    await page.route('**/api/chat', async (route) => {
      posted = route.request().postDataJSON() as Json;
      const sent = ((posted.messages as Json[])[0].content as string) ?? '';
      // What the engine persisted for this chain, served by the post-run reload: Sage added Fern
      // (team.add) and handed over (team.ask) on its own — no group, no setting.
      const joined = summary('dm-sage', 'direct', [SAGE, FERN]);
      state.conversations = [joined];
      state.pages['dm-sage'] = {
        detail: detail(joined),
        messages: [
          message(1, { role: 'user', content: sent }),
          message(2, { bot_id: SAGE.id, content: 'Sage found three vendors.' }),
          message(3, {
            role: 'system',
            content: 'Sage added Fern',
            bot_event: { kind: 'joined', bot_id: FERN.id, by: 'bot', by_bot_id: SAGE.id },
          }),
          message(4, {
            role: 'system',
            content: 'Tighten the summary',
            bot_event: { kind: 'ask', from: SAGE.id, to: FERN.id },
          }),
          message(5, { bot_id: FERN.id, content: 'Fern tightened the summary.' }),
        ],
      };
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
        body: ndjson([
          { type: 'bot-turn-start', bot_id: SAGE.id, reason: 'user' },
          { type: 'text-delta', text: 'Sage found three vendors.' },
          { type: 'tool-call-start', id: 'c0', toolName: 'team' },
          { type: 'tool-call', id: 'c0', toolName: 'team', input: { action: 'add', bot_id: FERN.id } },
          {
            type: 'tool-result',
            id: 'c0',
            toolName: 'team',
            output: { action: 'add', status: 'added', bot: { id: FERN.id, name: 'Fern', role: 'Writer' } },
          },
          { type: 'tool-call-start', id: 'c1', toolName: 'team' },
          {
            type: 'tool-call',
            id: 'c1',
            toolName: 'team',
            input: { action: 'ask', bot_id: FERN.id, message: 'Tighten the summary' },
          },
          {
            type: 'tool-result',
            id: 'c1',
            toolName: 'team',
            output: { action: 'ask', status: 'handed_over', to: 'Fern' },
          },
          { type: 'bot-turn-end', bot_id: SAGE.id, status: 'completed', message_id: 'msg-2' },
          { type: 'bot-turn-start', bot_id: FERN.id, reason: 'ask', asked_by: SAGE.id },
          { type: 'text-delta', text: 'Fern tightened the summary.' },
          { type: 'bot-turn-end', bot_id: FERN.id, status: 'completed', message_id: 'msg-5' },
          { type: 'finish', finishReason: 'stop' },
        ]),
      });
    });

    await page.goto('/#/bots?c=dm-sage');
    await expect(page.getByTestId('bots-conversation-header')).toContainText('Sage');
    await page.getByTestId('chat-input').fill('Compare the top 3 vendors');
    await page.getByTestId('chat-input').press('Enter');

    await expect(page.getByText('Fern tightened the summary.')).toBeVisible();
    await expect(page.getByText('Sage found three vendors.')).toBeVisible();
    const transcript = page.getByTestId('bots-transcript');
    await expect(transcript.getByText('Sage added Fern')).toBeVisible();
    await expect(transcript.getByRole('note')).toContainText('@Fern');
    // The DM's own Bot speaks under the conversation header; the guest gets its name.
    await expect(transcript.getByTestId('bots-speaker')).toHaveText(['Fern']);
    // The member's own message appears once (the pending copy gave way to the persisted one).
    await expect(transcript.getByText('Compare the top 3 vendors')).toHaveCount(1);
    expect(posted).toMatchObject({ session_id: 'dm-sage' });
    // Plant avatars: each Bot wears its template plant (stored avatars predate `plant`; the
    // researcher template is the dandelion, the writer the fern) — the owner in the intro, the
    // header and its sidebar row, the guest in its speaker header.
    await expect(transcript.locator('svg.pa-dandelion').first()).toBeVisible();
    await expect(transcript.locator('svg.pa-fern').first()).toBeVisible();
    const header = page.getByTestId('bots-conversation-header');
    await expect(header.locator('svg.pa-dandelion')).toHaveCount(1);
    await expect(page.getByTestId('bots-sidebar').locator('svg.pa-dandelion')).toHaveCount(1);
    // The turn is over, so nothing moves: motion means exactly "this Bot is talking".
    await expect(page.locator('.pa-mo')).toHaveCount(0);
    // The guest is listed in the conversation info, tagged and removable; there is no switch.
    await page.getByTestId('bots-info-button').click();
    const info = page.getByTestId('bots-info-panel');
    await expect(info.getByRole('listitem').filter({ hasText: 'Fern' })).toContainText('Guest');
    await expect(info.getByRole('button', { name: 'Remove from conversation' })).toHaveCount(1);
    await expect(info.getByRole('switch')).toHaveCount(0);
  });

  test('a retired group chat stays readable under Archived and takes no message', async ({ page }) => {
    const state = freshState();
    state.bots = [SAGE, FERN];
    const group = summary('grp-1', 'group', [SAGE, FERN]);
    const dm = summary('dm-sage', 'direct', [SAGE]);
    state.conversations = [group, dm];
    state.pages['grp-1'] = {
      detail: detail(group),
      messages: [
        message(1, { role: 'user', content: 'Compare the top 3 vendors' }),
        message(2, { bot_id: SAGE.id, content: 'Sage found three vendors.' }),
        message(3, {
          role: 'system',
          content: 'Tighten the summary',
          bot_event: { kind: 'ask', from: SAGE.id, to: FERN.id },
        }),
        message(4, { bot_id: FERN.id, content: 'Fern tightened the summary.' }),
      ],
    };
    state.pages['dm-sage'] = { detail: detail(dm), messages: [] };
    await stubBots(page, state);
    let chatPosts = 0;
    await page.route('**/api/chat', (route) => {
      chatPosts += 1;
      return route.fulfill({ status: 409, contentType: 'application/json', body: '{"code":"group_closed"}' });
    });

    // The landing never picks it, however recent: it opens Sage's DM.
    await page.goto('/#/bots');
    await expect(page).toHaveURL(/#\/bots\?c=dm-sage$/);

    await page.goto('/#/bots?c=grp-1');
    const transcript = page.getByTestId('bots-transcript');
    // History renders as it was: a speaker line per speaker, the hand-off strip.
    await expect(transcript.getByTestId('bots-speaker')).toHaveText(['Sage', 'Fern']);
    await expect(transcript.getByRole('note')).toContainText('@Fern');
    // …and it is a record: no composer, no invite, the read-only bar says why.
    await expect(page.getByTestId('bots-read-only')).toContainText('Group chats were retired');
    await expect(page.getByTestId('chat-input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Invite a Bot' })).toHaveCount(0);
    await expect(page.getByTestId('bots-status-line')).toHaveText('Retired group chat — read-only');
    // The sidebar files it under Archived, below the live DM.
    const sidebar = page.getByTestId('bots-sidebar');
    const rows = sidebar.getByTestId('bots-conversation-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-session-id', 'dm-sage');
    await expect(rows.nth(1)).toHaveAttribute('data-session-id', 'grp-1');
    await expect(sidebar).toContainText('Archived');
    expect(chatPosts).toBe(0);
  });

  test('an approval card settles through POST /api/bots/requests/:id', async ({ page }) => {
    const state = freshState();
    state.bots = [IVY];
    const dm = summary('dm-ivy', 'direct', [IVY], { attention: 'needs_you', pending_requests: 1 });
    state.conversations = [dm];
    const approval = {
      id: 'brq_1',
      session_id: 'dm-ivy',
      bot_id: IVY.id,
      kind: 'approval',
      status: 'pending',
      payload: {
        action: 'vault_fill',
        title: 'Fill the github.com sign-in',
        details: [{ label: 'Site', value: 'https://github.com' }],
        allow_always: true,
      },
      result: null,
      expires_at: null,
      created_at: NOW,
    } satisfies BotRequestView;
    state.pages['dm-ivy'] = {
      detail: detail(dm, [approval]),
      messages: [
        message(1, { role: 'user', content: 'Sign in to GitHub' }),
        message(2, {
          role: 'system',
          content: 'Ivy asked for approval',
          bot_event: { kind: 'request', request_id: 'brq_1', request_kind: 'approval', bot_id: IVY.id },
        }),
      ],
    };
    await stubBots(page, state);

    await page.goto('/#/bots?c=dm-ivy');
    const card = page.getByTestId('bots-request-card');
    await expect(card).toContainText('Ivy needs your approval');
    await expect(card).toContainText('https://github.com');
    await expect(page.getByTestId('bots-status-line')).toContainText(/approval/i);
    await card.getByRole('button', { name: 'Allow once' }).click();

    await expect(card).toContainText('Allowed');
    await expect(card.getByRole('button', { name: 'Allow once' })).toHaveCount(0);
    expect(state.decisions).toEqual([{ id: 'brq_1', body: { decision: 'approve' } }]);
  });

  test('sign-in and take-over cards: what is sent, what a skip leaves, and the implicit hand-back', async ({
    page,
  }) => {
    const state = freshState();
    state.bots = [IVY];
    const dm = summary('dm-ivy', 'direct', [IVY], { attention: 'needs_you', pending_requests: 2 });
    state.conversations = [dm];
    const login = (id: string, status: BotRequestView['status']): BotRequestView =>
      ({
        id,
        session_id: 'dm-ivy',
        bot_id: IVY.id,
        kind: 'login',
        status,
        payload: {
          reason: 'Sign in to GitHub',
          kind: 'login',
          origin: 'https://github.com',
          url: 'https://github.com/login',
          vault_matches: [],
        },
        result: null,
        expires_at: null,
        created_at: NOW,
      }) satisfies BotRequestView;
    const takeover = {
      id: 'brq_take',
      session_id: 'dm-ivy',
      bot_id: IVY.id,
      kind: 'takeover',
      status: 'pending',
      // Raised by the computer itself (the member took over mid-action) — not a Bot's own words.
      payload: { implicit: true, reason: 'interrupted', host: 'github.com' } as unknown as BotRequestView['payload'],
      result: null,
      expires_at: null,
      created_at: NOW,
    } satisfies BotRequestView;
    const row = (seq: number, id: string, kind: 'login' | 'takeover', content: string, createdAt = NOW) =>
      message(seq, {
        role: 'system',
        content,
        created_at: createdAt,
        bot_event: { kind: 'request', request_id: id, request_kind: kind, bot_id: IVY.id },
      });
    state.pages['dm-ivy'] = {
      detail: detail(dm, [login('brq_skipped', 'denied'), login('brq_login', 'pending'), takeover]),
      messages: [
        row(1, 'brq_skipped', 'login', 'Ivy needs you to sign in'),
        row(2, 'brq_skipped', 'login', 'Sign-in to github.com skipped'),
        row(3, 'brq_login', 'login', 'Ivy needs you to sign in'),
        row(4, 'brq_take', 'takeover', 'You took over'),
      ],
    };
    await stubBots(page, state);

    await page.goto('/#/bots?c=dm-ivy');
    // "Not now" left a system line under its (declined) card — not a second card.
    await expect(page.locator('[data-testid="bots-event"][data-event-kind="request"]')).toHaveText(
      'Sign-in to github.com skipped',
    );
    const cards = page.getByTestId('bots-request-card');
    await expect(cards).toHaveCount(3);

    // The second card of a two-step sign-in: the password alone is enough, and only it is sent.
    const signIn = cards.nth(1);
    const submit = signIn.getByRole('button', { name: 'Sign in' });
    await expect(submit).toBeDisabled();
    await signIn.locator('input[type="password"]').fill('correct horse');
    await submit.click();
    await expect.poll(() => state.decisions.length).toBe(1);
    expect(state.decisions[0]).toEqual({
      id: 'brq_login',
      body: { decision: 'approve', login: { password: 'correct horse', submit: true } },
    });

    // The implicit take-over says what happened and hands back so Ivy continues.
    const take = cards.nth(2);
    await expect(take).toContainText('You took over while Ivy was working');
    await take.getByRole('button', { name: 'Hand back — let Ivy continue' }).click();
    await expect.poll(() => state.decisions.length).toBe(2);
    expect(state.decisions[1]).toEqual({ id: 'brq_take', body: { decision: 'approve' } });
  });

  test('a message sent while Bots are busy is delivered, not refused (202)', async ({ page }) => {
    const state = freshState();
    state.bots = [IVY];
    const dm = summary('dm-ivy', 'direct', [IVY], { attention: 'working' });
    state.conversations = [dm];
    state.pages['dm-ivy'] = {
      detail: detail(dm),
      messages: [message(1, { role: 'user', content: 'Research this for me' })],
    };
    await stubBots(page, state);
    await page.route('**/api/chat', (route) =>
      route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ queued: true }) }),
    );

    await page.goto('/#/bots?c=dm-ivy');
    await page.getByTestId('chat-input').fill('Also check the pricing page');
    await page.getByTestId('chat-input').press('Enter');

    const pending = page.getByTestId('bots-pending-send');
    await expect(pending).toContainText('Also check the pricing page');
    await expect(pending).toContainText('Delivered — read after the current reply');
    // The composer never locks.
    await expect(page.getByTestId('chat-input')).toBeEditable();
    await expect(page.getByTestId('chat-input')).toHaveValue('');
  });
});
