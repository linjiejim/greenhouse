import { test, expect } from './fixtures';

/** UI acceptance uses real profile/session APIs and a deterministic chat response. */
test('avatar choices, overflow, order, immutable identity and mobile layout', async ({ page, api, runId }) => {
  const profiles: Array<{ id: string; name: string }> = [];
  const sessions: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    for (let i = 0; i < 8; i++) {
      const name = `${runId}-同事${i + 1}`;
      const response = await api.post('/api/profiles/custom', {
        data: {
          name,
          base_profile_id: 'sprouty',
          tools: [],
          system_prompt: 'Help the user.',
          avatar: { color: ['green', 'blue', 'purple', 'orange'][i % 4] },
        },
      });
      expect(response.ok()).toBeTruthy();
      profiles.push(await response.json());
    }
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/#/chat');
    await expect(page.getByTestId('agent-avatar-picker')).toBeVisible();
    const row = page.getByTestId('agent-avatar-picker');
    await expect(row.locator('[data-agent-id]').first()).toBeVisible();
    expect(await row.locator('[data-agent-id]').count()).toBeLessThan(profiles.length + 1);
    await row.getByRole('button', { name: 'More colleagues' }).click();
    const dialog = page.getByRole('dialog', { name: 'Talk to' });
    const last = dialog
      .locator('div.flex.items-center.gap-1')
      .filter({ has: page.getByRole('button', { name: profiles[7].name, exact: true }) });
    for (let i = 0; i < 3; i++) await last.getByRole('button', { name: 'Move earlier' }).click();
    await dialog.getByRole('button', { name: profiles[7].name, exact: true }).click();
    await expect(row.getByRole('button', { name: profiles[7].name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.reload();
    await expect(row.getByRole('button', { name: profiles[7].name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.screenshot({ path: 'test-results/coworkers-new-chat.png', fullPage: true });
    // Keyboard reordering is also available without a pointer/drag device.
    const selected = row.getByRole('button', { name: profiles[7].name, exact: true });
    await selected.focus();
    await selected.press('Alt+ArrowLeft');
    const before = await page.evaluate(
      () => Object.entries(localStorage).find(([key]) => key.startsWith('greenhouse-agent-order:'))?.[1],
    );
    expect(before).toContain(profiles[7].id);

    const source = row.locator('[data-agent-id]').first();
    const target = row.locator('[data-agent-id]').nth(2);
    const sourceId = await source.getAttribute('data-agent-id');
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(row.locator('[data-agent-id]').nth(2)).toHaveAttribute('data-agent-id', sourceId!);
    await expect(row.getByRole('button', { name: profiles[7].name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    const create = await api.post('/api/sessions', { data: { title: '市场研究 · 验收', profile_id: profiles[7].id } });
    expect(create.ok()).toBeTruthy();
    const session = await create.json();
    sessions.push(session.id);
    expect(session.agent_instance_id).toBeTruthy();
    await page.goto(`/#/chat?session=${session.id}`);
    await expect(page.getByTestId('chat-agent-identity')).toHaveAttribute('title', profiles[7].name);
    await expect(row).toBeVisible();
    await expect(row.getByRole('button', { name: profiles[7].name, exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('heading', { name: '市场研究 · 验收' })).toBeVisible();
    await page.screenshot({ path: 'test-results/coworkers-fixed-chat.png', fullPage: true });
    const identity = await api.patch(`/api/sessions/${session.id}`, {
      data: { agent_instance_id: 'forged', profile_id: 'sprouty' },
    });
    expect(identity.ok()).toBeTruthy();
    const forged = await api.patch(`/api/sessions/${session.id}`, {
      data: { metadata: JSON.stringify({ dialogue_id: 'forged' }) },
    });
    expect(forged.status()).toBe(400);
    const unchanged = await api.get(`/api/sessions/${session.id}`);
    expect((await unchanged.json()).session.agent_instance_id).toBe(session.agent_instance_id);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/#/chat?session=${session.id}`);
      await page.getByRole('button', { name: 'Conversation actions', exact: true }).click();
      const actions = page.getByRole('dialog', { name: 'Conversation actions' });
      await expect(actions.getByRole('button', { name: 'Open side panel' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(actions).toHaveCount(0);
      expect((await page.getByRole('heading', { name: '市场研究 · 验收' }).boundingBox())!.width).toBeGreaterThan(40);
      await page.goto('/#/chat');
      await expect(row).toBeVisible();
      await expect(row.getByRole('button', { name: 'More colleagues' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBeTruthy();
      await page.screenshot({ path: `test-results/coworkers-mobile-${width}.png`, fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally {
    for (const id of sessions) await api.delete(`/api/sessions/${id}`);
    for (const profile of profiles) await api.delete(`/api/profiles/custom/${profile.id.replace('custom:', '')}`);
  }
});

test('coworker inbox keeps topics, drafts and reading position separate while new topics start empty', async ({
  page,
  api,
  runId,
}) => {
  const profiles: Array<{ id: string; name: string }> = [];
  const sessions: Array<{ id: string; profile_id: string; title: string }> = [];
  const readIds: string[] = [];
  try {
    for (const name of ['Research', 'Writing']) {
      const response = await api.post('/api/profiles/custom', {
        data: { name: `${runId}-${name}`, base_profile_id: 'sprouty', tools: [], system_prompt: 'Help the user.' },
      });
      expect(response.ok()).toBeTruthy();
      profiles.push(await response.json());
    }
    for (const [index, title] of [
      [0, 'Research before'],
      [0, 'Research current'],
      [1, 'Writing current'],
    ] as const) {
      const response = await api.post('/api/sessions', {
        data: { profile_id: profiles[index].id, title: `${runId}-${title}` },
      });
      expect(response.ok()).toBeTruthy();
      sessions.push(await response.json());
    }
    // Only transcript content is stubbed; identity, topics, visits and route selection use the real API.
    await page.route(/\/api\/sessions\/[^/?]+(\?.*)?$/, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const session = sessions.find((s) => route.request().url().includes(s.id));
      if (!session) return route.fallback();
      const response = await route.fetch();
      const data = await response.json();
      data.messages = Array.from({ length: 18 }, (_, index) => ({
        id: `${session.id}-m${index}`,
        session_id: session.id,
        role: index % 2 ? 'assistant' : 'user',
        content: `${session.title} message ${index}\n\n${'A paragraph of this topic only. '.repeat(12)}`,
        seq: index + 1,
        pipeline: '[]',
        images: '[]',
        references_: '[]',
        created_at: new Date().toISOString(),
      }));
      await route.fulfill({ response, json: data });
    });
    await page.route('**/api/coworkers/topics/*/read', async (route) => {
      readIds.push(...route.request().postDataJSON().message_ids);
      await route.continue();
    });
    await page.goto(`/#/chat?session=${sessions[1].id}`);
    await page.evaluate(
      (ids) => {
        const key = Object.keys(localStorage).find((k) => k.startsWith('greenhouse-agent-order:'));
        if (key) localStorage.setItem(key, JSON.stringify(ids));
      },
      profiles.map((p) => p.id),
    );
    // Overflow selection works regardless of existing account preferences.
    const select = async (name: string) => {
      const row = page.getByTestId('agent-avatar-picker');
      const button = row.getByRole('button', { name, exact: true });
      if (await button.count()) await button.click();
      else {
        await row.getByRole('button', { name: 'More colleagues' }).click();
        await page.getByRole('dialog', { name: 'Talk to' }).getByRole('button', { name, exact: true }).click();
      }
    };
    const input = page.getByTestId('chat-input');
    const scroll = page.getByTestId('conversation-scroll');
    await expect(page.getByTestId('chat-agent-identity')).toHaveAttribute('title', profiles[0].name);
    await expect(page.getByTestId('coworker-topic')).toHaveCount(1);
    await input.fill('Research draft retained');
    await scroll.evaluate((el) => {
      el.scrollTop = 380;
    });
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(380);
    await select(profiles[1].name);
    await expect(page).toHaveURL(new RegExp(sessions[2].id));
    await expect(input).toHaveValue('');
    await input.fill('Writing draft retained');
    await select(profiles[0].name);
    await expect(page).toHaveURL(new RegExp(sessions[1].id));
    await expect(input).toHaveValue('Research draft retained');
    await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(380);
    await page.getByRole('button', { name: 'Our conversations', exact: true }).click();
    await expect(page.getByTestId('coworker-history').getByText(sessions[0].title, { exact: true })).toBeVisible();
    await expect(page.getByTestId('coworker-history').getByText(sessions[2].title, { exact: true })).toHaveCount(0);
    await page.locator(`[data-topic-id="${sessions[0].id}"]`).click();
    await expect(page).toHaveURL(new RegExp(sessions[0].id));
    await expect(input).toHaveValue('');
    await expect.poll(() => readIds.some((id) => id.startsWith(sessions[0].id))).toBeTruthy();
    await page.getByRole('button', { name: 'New topic', exact: true }).click();
    await expect(page).toHaveURL(/agent=custom%3A\d+&new=/);
    await expect(page.locator('[data-coworker-message]')).toHaveCount(0);
    await input.fill('New research topic draft');
    await select(profiles[1].name);
    await expect(input).toHaveValue('Writing draft retained');
    await select(profiles[0].name);
    await expect(page).toHaveURL(/&new=/);
    await expect(input).toHaveValue('New research topic draft');
    await page.reload();
    await expect(input).toHaveValue('New research topic draft');
    await expect(page.getByTestId('coworker-topic')).toHaveCount(2);
    await select(profiles[1].name);
    await expect(input).toHaveValue('Writing draft retained');
    await page.getByRole('button', { name: 'New Chat', exact: true }).click();
    await expect(page).toHaveURL(/&new=/);
    await input.fill('Writing draft from the sidebar');
    await select(profiles[0].name);
    await expect(input).toHaveValue('New research topic draft');
    await select(profiles[1].name);
    await expect(page).toHaveURL(/&new=/);
    await expect(input).toHaveValue('Writing draft from the sidebar');
  } finally {
    for (const session of sessions) await api.delete(`/api/sessions/${session.id}`);
    for (const profile of profiles) await api.delete(`/api/profiles/custom/${profile.id.replace('custom:', '')}`);
  }
});
