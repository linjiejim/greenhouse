import { test, expect } from './fixtures';

/**
 * Every surface an ACTIVE extension registers opens without crashing: pages,
 * page modules, "More" entries, Settings / Administration modules and legacy
 * aliases. Generic on purpose — the list comes from the running page
 * (`window.__greenhouseExtensionSurfaces`, fed by `defineWebExtension`), so a
 * deployment that compiles private extensions in gets the same sweep for free.
 * GREENHOUSE_EXTENSIONS decides what is active; the test super passes every
 * role and feature gate, so hidden and gated surfaces are opened too.
 *
 * This is the check that would have caught "Unknown navigation module" and a
 * page that throws on first render — failures no API-level test can see.
 */
test('every active extension surface renders without an error', async ({ page, api }) => {
  const res = await api.get('/api/extensions');
  expect(res.ok()).toBe(true);
  const { extensions } = (await res.json()) as { extensions: Array<{ id: string }> };
  const active = extensions.map((e) => e.id);

  await page.goto('/#/chat');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  const surfaces = await page.evaluate((ids) => window.__greenhouseExtensionSurfaces?.(ids) ?? [], active);
  // The Playwright stack runs with the example on, so the sweep is never vacuous.
  expect(surfaces.length).toBeGreaterThan(0);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const seen = new Set<string>();
  for (const surface of surfaces) {
    if (seen.has(surface.hash)) continue;
    seen.add(surface.hash);
    await test.step(`${surface.extensionId} ${surface.kind} ${surface.hash}`, async () => {
      await page.goto(`/${surface.hash}`);
      if (surface.redirectsTo) {
        await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(surface.redirectsTo);
      }
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.getByText('This extension is not enabled on this deployment.')).toHaveCount(0);
      // Something rendered for the hash — never a blank shell. `.first()` is
      // the app shell's own <main>; an extension page may render another one.
      await expect(page.locator('main').first()).not.toBeEmpty();
    });
  }
  expect(pageErrors, 'uncaught errors while opening extension surfaces').toEqual([]);
});
