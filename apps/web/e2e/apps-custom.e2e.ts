import { expect, test } from '@playwright/test';
import type { AppDraft, AppVersion, Base } from '@greenhouse/contract';
import { apiAs } from './api';
import { open } from './fixtures';
import { E2E } from './env';

test('custom cards need exact-version review, read declared data and block network and origin escapes', async ({
  page,
  request,
}) => {
  const base = await apiAs<Base>(request, 'lin', 'POST', '/api/tables/bases', { name: 'T12 custom base' });
  const draft = await apiAs<AppDraft>(request, 'lin', 'POST', '/api/apps', {
    name: 'T12 custom app',
    base_id: base.id,
  });
  const exfil = `http://127.0.0.1:${E2E.llmPort}/t12-exfil`;
  const html = `<p id="answer">Loading</p><button id="escape">Try navigation</button><script>
    greenhouse.query('count').then(r=>document.getElementById('answer').textContent='Count: '+r.data.value);
    const result={};
    try{result.parent=parent.document.body.textContent}catch{result.parent='blocked'}
    try{localStorage.setItem('escape','1');result.storage='open'}catch{result.storage='blocked'}
    result.rtc=typeof RTCPeerConnection;
    document.body.dataset.checks=JSON.stringify(result);
    fetch('${exfil}').catch(()=>{});
    const image=new Image();image.src='${exfil}/image';document.body.append(image);
    const nested=document.createElement('iframe');nested.src='${exfil}/frame';document.body.append(nested);
    document.getElementById('escape').onclick=()=>{location.href='${exfil}/navigation'};
  </script>`;
  const saved = await apiAs<AppDraft>(request, 'lin', 'PUT', `/api/apps/${draft.app.id}/draft`, {
    name: draft.app.name,
    description: '',
    revision: draft.revision,
    spec: {
      roles: [],
      pages: [
        {
          id: 'home',
          name: 'Home',
          cards: [
            {
              id: 'count',
              kind: 'number',
              title: 'Count',
              table_id: base.tables[0]!.id,
              measure: { aggregate: 'count' },
            },
            { id: 'code', kind: 'custom', title: 'Safe custom', html, bindings: [{ id: 'count', card: 'count' }] },
          ],
        },
      ],
    },
  });
  const published = await apiAs<AppDraft>(request, 'lin', 'POST', `/api/apps/${draft.app.id}/publish`, {
    revision: saved.revision,
    audience: [],
  });
  await open(page, `/#/apps/${draft.app.id}`);
  await expect(page.getByText('此版本尚未获管理员批准，自定义卡片暂不运行。')).toBeVisible();
  expect(await page.locator('iframe').count()).toBe(0);
  const versions = await apiAs<{ items: AppVersion[] }>(request, 'lin', 'GET', `/api/apps/${draft.app.id}/versions`);
  const version = versions.items[0]!;
  await apiAs(request, 'lin', 'POST', `/api/apps/${draft.app.id}/review`, {
    version: 1,
    spec_hash: version.spec_hash,
    decision: 'approved',
  });
  const escaped: string[] = [];
  const delivered: string[] = [];
  page.on('response', (r) => {
    if (r.url().startsWith(exfil)) delivered.push(r.url());
  });
  page.on('request', (r) => {
    if (r.url().startsWith(exfil)) escaped.push(r.url());
  });
  await page.reload();
  const inner = page.frameLocator('iframe[title="Safe custom"]').frameLocator('iframe');
  await expect(inner.getByText('Count: 0')).toBeVisible();
  const checks = await inner.locator('body').getAttribute('data-checks');
  expect(JSON.parse(checks!)).toEqual({ parent: 'blocked', storage: 'blocked', rtc: 'undefined' });
  const dir = '../../node_modules/.cache/t12-screenshots';
  for (const [theme, width] of [
    ['light', 1440],
    ['dark', 1440],
    ['dark', 390],
  ] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `${dir}/custom-${theme}-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  // A CSP-blocked request can be emitted by Playwright; assert that none actually reaches the server.
  await inner.getByRole('button', { name: 'Try navigation' }).click();
  await page.waitForTimeout(250);
  expect(delivered).toEqual([]);
  expect(escaped.every((url) => url.endsWith('/image'))).toBe(true);
  for (const frame of page.frames()) expect(frame.url()).not.toContain('t12-exfil');
  await apiAs(request, 'lin', 'POST', `/api/apps/${draft.app.id}/publish`, {
    revision: published.revision,
    audience: [],
  });
  await page.reload();
  await expect(page.getByText('此版本尚未获管理员批准，自定义卡片暂不运行。')).toBeVisible();
  expect(await page.locator('iframe').count()).toBe(0);
});
