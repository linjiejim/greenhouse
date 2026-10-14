import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { apiAs } from './api';
import { as, composer, open } from './fixtures';

/**
 * 知识库 (KNOW-01 to KNOW-16) in the browser: the tree, writing and saving, two people saving the
 * same doc, versions, sharing, comments that mention, files, archive, search, the narrow layout,
 * and a hostile doc that must stay inert.
 */

/** A 2×2 PNG: real image bytes (the API checks the type from the content). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDK+mmyQAAAABJRU5ErkJggg==',
  'base64',
);

const directory = (page: Page) => page.getByRole('complementary', { name: '目录' });
const editorBody = (page: Page) => page.getByRole('textbox', { name: '正文' });
const docText = (page: Page) => page.locator('.app-doc-main .app-doc-content').first();

type Made = { id: string; version: number };
const folder = (request: APIRequestContext, name: string, space: 'team' | 'personal' = 'team') =>
  apiAs<Made>(request, 'lin', 'POST', '/api/knowledge/folders', { name, space });
const doc = (request: APIRequestContext, input: Record<string, unknown>) =>
  apiAs<Made>(request, 'lin', 'POST', '/api/knowledge/docs', input);

test('a folder and a doc: create them, write with /, [[ and @, and save with a note', async ({ page, request }) => {
  const glossary = await doc(request, { title: 'Glossary of terms', content: 'Terms.', space: 'team' });
  await open(page, '/#/knowledge');

  await directory(page).getByRole('button', { name: '新建', exact: true }).click();
  const create = page.getByRole('dialog', { name: '新建' });
  await create.getByRole('radio', { name: '文件夹' }).click();
  await create.getByRole('textbox', { name: /^名称/ }).fill('Onboarding');
  await create.getByRole('combobox', { name: '位置' }).click();
  await page.getByRole('option', { name: '团队知识库' }).click();
  await create.getByRole('button', { name: '创建文件夹' }).click();
  await expect(page).toHaveURL(/#\/knowledge\/folder\/fld_/);
  await expect(page.getByRole('heading', { level: 1, name: 'Onboarding' })).toBeVisible();
  await expect(directory(page).getByRole('link', { name: 'Onboarding' })).toBeVisible();

  // The header's primary action (the empty folder offers the same one).
  await page.locator('.app-page-header').getByRole('button', { name: '新文档' }).click();
  const newDoc = page.getByRole('dialog', { name: '新建' });
  await expect(newDoc.getByRole('combobox', { name: '位置' })).toContainText('Onboarding');
  await newDoc.getByRole('textbox', { name: /^标题/ }).fill('First week');
  await newDoc.getByRole('button', { name: '创建文档' }).click();
  await expect(page).toHaveURL(/#\/knowledge\/doc_\w+\?edit=1$/);
  const docId = /doc_\w+/.exec(page.url())![0];

  await editorBody(page).click();
  await page.keyboard.type('/heading2');
  await expect(page.getByRole('listbox', { name: '插入块' }).getByRole('option', { name: '标题 2' })).toBeVisible();
  await page.keyboard.press('Enter');
  await page.keyboard.type('Goals');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Read [[Glossary');
  await page
    .getByRole('listbox', { name: '引用文档' })
    .getByRole('option', { name: /Glossary of terms/ })
    .click();
  await page.keyboard.type('and ask @Me');
  await page.getByRole('listbox', { name: '提及成员' }).getByRole('option', { name: /Mei/ }).click();
  await expect(page.getByText('有未保存的更改')).toBeVisible();
  await page.getByRole('textbox', { name: '这次改了什么' }).fill('First draft');
  await page.getByRole('button', { name: '保存', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`#/knowledge/${docId}$`));
  await expect(page.getByRole('heading', { level: 2, name: 'Goals' })).toBeVisible();
  await expect(docText(page).getByRole('link', { name: 'Glossary of terms' })).toHaveAttribute(
    'href',
    `#/knowledge/${glossary.id}`,
  );
  await expect(docText(page).locator('[data-type="mention"]')).toHaveText('@Mei');
  const saved = await apiAs<{ content: string }>(request, 'lin', 'GET', `/api/knowledge/docs/${docId}`);
  expect(saved.content).toContain('## Goals');
  expect(saved.content).toContain(`[Glossary of terms](#/knowledge/${glossary.id})`);
  expect(saved.content).toMatch(/\[@Mei\]\(member:mbr_\w+\)/);
  const versions = await apiAs<{ items: { change_note: string }[] }>(
    request,
    'lin',
    'GET',
    `/api/knowledge/docs/${docId}/versions`,
  );
  expect(versions.items[0]!.change_note).toBe('First draft');

  // The linked doc lists it as a backlink.
  await docText(page).getByRole('link', { name: 'Glossary of terms' }).click();
  await expect(
    page.getByRole('region', { name: '引用了这篇文档' }).getByRole('link', { name: 'First week' }),
  ).toBeVisible();
});

test('two tabs edit one doc: leaving asks first, and the later save says who saved and can save anyway', async ({
  page,
  context,
  request,
}) => {
  const plan = await doc(request, { title: 'Release plan', content: 'Ship on Monday.', space: 'team' });
  const second = await context.newPage();
  await open(page, `/#/knowledge/${plan.id}?edit=1`);
  // The second tab reads first and then edits, so Back has somewhere to go inside the app.
  await open(second, `/#/knowledge/${plan.id}`);
  await second.getByRole('main').getByRole('button', { name: '编辑' }).click();
  await expect(second).toHaveURL(/\?edit=1$/);

  await editorBody(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' Tuesday works too.');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${plan.id}$`));
  await expect(docText(page)).toContainText('Tuesday works too.');

  // The other tab hears of the newer version while it edits.
  await expect(second.getByRole('status').filter({ hasText: '保存了新版本' })).toBeVisible();
  await editorBody(second).click();
  await second.keyboard.press('End');
  await second.keyboard.type(' Or Wednesday.');

  // Unsaved work: leaving asks, and staying keeps the draft.
  await second.getByRole('button', { name: '知识库', exact: true }).click();
  const leave = second.getByRole('alertdialog', { name: '放弃未保存的更改？' });
  await leave.getByRole('button', { name: '继续编辑' }).click();
  await expect(second).toHaveURL(/\?edit=1$/);
  await expect(editorBody(second)).toContainText('Or Wednesday.');
  await second.goBack();
  await leave.getByRole('button', { name: '继续编辑' }).click();
  await expect(second).toHaveURL(/\?edit=1$/);
  await expect(editorBody(second)).toContainText('Or Wednesday.');

  await second.getByRole('button', { name: '保存', exact: true }).click();
  const conflict = second.getByRole('status').filter({ hasText: '保存了版本 2' });
  await expect(conflict).toContainText('Lin');
  await expect(editorBody(second)).toContainText('Or Wednesday.');
  await conflict.getByRole('button', { name: '仍然保存' }).click();
  await expect(second).toHaveURL(new RegExp(`#/knowledge/${plan.id}$`));
  await expect(docText(second)).toContainText('Ship on Monday. Or Wednesday.');
  const versions = await apiAs<{ items: unknown[] }>(request, 'lin', 'GET', `/api/knowledge/docs/${plan.id}/versions`);
  expect(versions.items).toHaveLength(3);
  await second.close();
});

test('discarding after Back goes back, and Back after that does not return to the editor', async ({
  page,
  request,
}) => {
  const notes = await doc(request, { title: 'Back and forth', content: 'Kept as is.', space: 'team' });
  await open(page, '/#/knowledge');
  await page.goto(`/#/knowledge/${notes.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Back and forth' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: '编辑' }).click();
  await expect(page).toHaveURL(/\?edit=1$/);
  await editorBody(page).click();
  await page.keyboard.type('Draft ');

  await page.goBack();
  await page.getByRole('alertdialog', { name: '放弃未保存的更改？' }).getByRole('button', { name: '放弃更改' }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${notes.id}$`));
  await expect(docText(page)).toContainText('Kept as is.');
  await page.goBack();
  await expect(page).toHaveURL(/#\/knowledge$/);
});

test('a refresh that fails keeps the draft on screen and says why', async ({ page, request }) => {
  const notes = await doc(request, { title: 'Shared notes', content: 'First line.', space: 'team' });
  await open(page, `/#/knowledge/${notes.id}?edit=1`);
  await editorBody(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' My draft.');
  // From now on the doc can't be read here (a share taken away, say).
  await page.route(`**/api/knowledge/docs/${notes.id}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'not_found', message: 'Doc not found.' } }),
        })
      : route.continue(),
  );
  // Mei saves: the page hears doc.updated and refreshes the doc, which fails.
  await apiAs(request, 'mei', 'PATCH', `/api/knowledge/docs/${notes.id}`, { version: 1, content: 'Mei was here.' });
  await expect(page.getByRole('status').filter({ hasText: '这篇文档现在打不开了' })).toBeVisible();
  await expect(editorBody(page)).toContainText('My draft.');
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
});

test('a title-only save leaves the body exactly as it was written', async ({ page, request }) => {
  const written = '* one\n* two\n\nWritten by hand, with a [link][ref].\n\n[ref]: https://example.com';
  const notes = await doc(request, { title: 'As written', content: written, space: 'team' });
  await open(page, `/#/knowledge/${notes.id}?edit=1`);
  await expect(editorBody(page)).toContainText('Written by hand');
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('As written, renamed');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${notes.id}$`));
  const saved = await apiAs<{ title: string; content: string }>(
    request,
    'lin',
    'GET',
    `/api/knowledge/docs/${notes.id}`,
  );
  expect(saved.title).toBe('As written, renamed');
  expect(saved.content).toBe(written);
});

test('versions: compare by line, then restore an older one as a new version', async ({ page, request }) => {
  const notes = await doc(request, { title: 'Meeting notes', content: 'First take.', space: 'team' });
  await apiAs(request, 'lin', 'PATCH', `/api/knowledge/docs/${notes.id}`, {
    version: 1,
    content: 'Second take.',
    change_note: 'Rewrite',
  });
  await open(page, `/#/knowledge/${notes.id}`);
  await expect(docText(page)).toContainText('Second take.');
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '版本历史' }).click();
  const drawer = page.getByRole('dialog', { name: '版本历史' });
  await drawer.getByRole('button', { name: /Rewrite/ }).click();
  await expect(drawer.locator('.app-diff-line.is-delete')).toContainText('First take.');
  await expect(drawer.locator('.app-diff-line.is-insert')).toContainText('Second take.');
  await drawer.getByRole('radio', { name: '按词' }).click();
  await expect(drawer.locator('.app-diff-words del')).toContainText('First');
  await drawer.getByRole('button', { name: '全部版本' }).click();
  await drawer.getByRole('button', { name: /^1\s*Meeting notes/ }).click();
  await drawer.getByRole('button', { name: '恢复版本 1' }).click();
  await expect(page.getByText('已恢复到版本 1')).toBeVisible();
  await expect(drawer.getByRole('button', { name: /恢复到版本 1/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(docText(page)).toContainText('First take.');
});

test('share a personal doc with Mei: it appears under 分享给我 at once and she can read it', async ({
  page,
  browser,
  request,
}) => {
  const budget = await doc(request, { title: 'Budget draft', content: 'Numbers for Q4.' });
  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await open(other, '/#/knowledge?space=shared');
  await expect(other.getByRole('main').getByRole('link', { name: /Budget draft/ })).toHaveCount(0);

  await open(page, `/#/knowledge/${budget.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: '分享' }).click();
  const dialog = page.getByRole('dialog', { name: '分享「Budget draft」' });
  await dialog.getByRole('combobox', { name: '添加成员或分组' }).click();
  await page.getByRole('option', { name: /Mei/ }).click();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Mei的权限' })).toContainText('可查看');
  await dialog.getByRole('button', { name: '保存分享' }).click();
  await expect(page.getByText('已更新「Budget draft」的分享')).toBeVisible();

  // Her list refreshes by itself (knowledge.changed), and the doc opens read-only.
  const shared = other.getByRole('main').getByRole('link', { name: /Budget draft/ });
  await expect(shared).toBeVisible();
  await shared.click();
  await expect(docText(other)).toContainText('Numbers for Q4.');
  await expect(other.getByRole('main').getByText('只读')).toBeVisible();
  await expect(other.getByRole('main').getByRole('button', { name: '编辑' })).toHaveCount(0);
  await other.goto('/#/notifications?view=all');
  await expect(other.getByRole('link', { name: /Lin 把《Budget draft》分享给了你/ })).toBeVisible();
  await mei.close();

  // Team items are everyone's: there is nothing to share.
  const team = await doc(request, { title: 'Team page', content: 'For all.', space: 'team' });
  await open(page, `/#/knowledge/${team.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await expect(page.getByRole('menuitem', { name: '分享' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a comment that mentions Mei reaches her notifications and opens the doc', async ({ page, browser, request }) => {
  const checklist = await doc(request, { title: 'Launch checklist', content: 'Steps.', space: 'team' });
  await open(page, `/#/knowledge/${checklist.id}`);
  const box = page.getByRole('textbox', { name: '写评论' });
  await box.click();
  await box.pressSequentially('@Me');
  await page.getByRole('listbox', { name: '提及成员' }).getByRole('option', { name: /Mei/ }).click();
  await box.pressSequentially('please check the steps');
  await page.getByRole('button', { name: '发表评论' }).click();
  const comment = page.locator('.app-comment').first();
  await expect(comment).toContainText('please check the steps');
  await expect(comment.locator('[data-type="mention"]')).toHaveText('@Mei');

  const mei = await browser.newContext({ storageState: as('mei'), locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  const other = await mei.newPage();
  await other.goto('/#/notifications?view=all');
  const told = other.getByRole('link', { name: /Lin 在《Launch checklist》的评论里提到了你/ });
  await expect(told).toBeVisible();
  await told.click();
  await expect(other).toHaveURL(new RegExp(`#/knowledge/${checklist.id}$`));
  await expect(other.locator('.app-comment').first()).toContainText('please check the steps');
  await mei.close();
});

test('upload files into a folder, preview text and pictures, and download', async ({ page, request }) => {
  const assets = await folder(request, 'Assets');
  await open(page, `/#/knowledge/folder/${assets.id}`);
  await page.locator('input[type="file"][aria-label="上传文件"]').setInputFiles([
    { name: 'readme.txt', mimeType: 'text/plain', buffer: Buffer.from('hello from a file') },
    { name: 'dot.png', mimeType: 'image/png', buffer: PNG },
  ]);
  const list = page.getByRole('main').getByRole('list', { name: 'Assets' });
  await expect(list.getByRole('link', { name: /readme\.txt/ })).toBeVisible();
  await expect(list.getByRole('link', { name: /dot\.png/ })).toBeVisible();

  await list.getByRole('link', { name: /readme\.txt/ }).click();
  await expect(page).toHaveURL(/\?file=fil_/);
  const preview = page.getByRole('dialog', { name: 'readme.txt' });
  await expect(preview.locator('pre')).toHaveText('hello from a file');
  const download = page.waitForEvent('download');
  await preview.getByRole('button', { name: '下载' }).click();
  expect((await download).suggestedFilename()).toBe('readme.txt');
  await preview.getByRole('button', { name: '关闭详情' }).click();
  await expect(page).not.toHaveURL(/\?file=/);

  await list.getByRole('link', { name: /dot\.png/ }).click();
  const picture = page.getByRole('dialog', { name: 'dot.png' }).getByRole('img', { name: 'dot.png' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(2);
});

test('archive a doc, undo it, archive again and restore it from 已归档', async ({ page, request }) => {
  const old = await folder(request, 'Old stuff');
  await doc(request, { title: 'Memo 2025', folder_id: old.id, content: 'Old.' });
  await open(page, `/#/knowledge/folder/${old.id}`);
  const list = page.getByRole('main').getByRole('list', { name: 'Old stuff' });
  const archive = async () => {
    await list.getByRole('button', { name: 'Memo 2025的操作' }).click();
    await page.getByRole('menuitem', { name: '归档' }).click();
    await expect(page.getByText('已归档「Memo 2025」')).toBeVisible();
    await expect(list.getByRole('link', { name: /Memo 2025/ })).toHaveCount(0);
  };
  await archive();
  await page.getByRole('button', { name: '撤销' }).click();
  await expect(list.getByRole('link', { name: /Memo 2025/ })).toBeVisible();

  await archive();
  await directory(page).getByRole('link', { name: '已归档' }).click();
  await expect(page).toHaveURL(/#\/knowledge\?space=team&view=archived$/);
  const archived = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Memo 2025' });
  await archived.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(page.getByText('已恢复「Memo 2025」')).toBeVisible();
  await expect(archived).toHaveCount(0);
  await page.goto(`/#/knowledge/folder/${old.id}`);
  await expect(list.getByRole('link', { name: /Memo 2025/ })).toBeVisible();
});

test('move a doc with 移动到… and by dragging it onto a folder', async ({ page, request }) => {
  const from = await folder(request, 'Inbox folder');
  const to = await folder(request, 'Filed folder');
  await doc(request, { title: 'Receipt', folder_id: from.id, content: 'Paid.' });
  await doc(request, { title: 'Invoice', folder_id: from.id, content: 'Due.' });
  await open(page, `/#/knowledge/folder/${from.id}`);
  const list = page.getByRole('main').getByRole('list', { name: 'Inbox folder' });
  await list.getByRole('button', { name: 'Receipt的操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  const move = page.getByRole('dialog', { name: '把「Receipt」移动到…' });
  await move.getByRole('radio', { name: 'Filed folder' }).click();
  await move.getByRole('button', { name: '移到这里' }).click();
  await expect(page.getByText('已把「Receipt」移到「Filed folder」')).toBeVisible();
  await expect(list.getByRole('link', { name: /Receipt/ })).toHaveCount(0);

  // Dragging a row onto a folder in the directory moves it there too.
  await list.getByRole('link', { name: /Invoice/ }).dragTo(directory(page).getByRole('link', { name: 'Filed folder' }));
  await expect(page.getByText('已把「Invoice」移到「Filed folder」')).toBeVisible();
  await page.goto(`/#/knowledge/folder/${to.id}`);
  const filed = page.getByRole('main').getByRole('list', { name: 'Filed folder' });
  await expect(filed.getByRole('link', { name: /Receipt/ })).toBeVisible();
  await expect(filed.getByRole('link', { name: /Invoice/ })).toBeVisible();

  // 下移 puts it in hand order, the keyboard's way to reorder.
  await expect(filed.getByRole('link')).toHaveText([/Invoice/, /Receipt/]);
  await filed.getByRole('button', { name: 'Invoice的操作' }).click();
  await page.getByRole('menuitem', { name: '下移' }).click();
  await expect(filed.getByRole('link')).toHaveText([/Receipt/, /Invoice/]);

  // My own doc dragged into the team space: that is for good, so the drop asks first.
  await doc(request, { title: 'Private memo', content: 'Mine.', space: 'personal' });
  await page.goto('/#/knowledge?space=personal');
  const mine = page.getByRole('main').getByRole('list', { name: '个人' });
  await directory(page).getByRole('radio', { name: '团队' }).click();
  const memo = mine.getByRole('link', { name: /Private memo/ });
  await memo.dragTo(directory(page).getByRole('link', { name: 'Filed folder' }));
  const ask = page.getByRole('alertdialog', { name: '把「Private memo」移进团队知识库？' });
  await ask.getByRole('button', { name: '取消' }).click();
  await expect(memo).toBeVisible();
  await memo.dragTo(directory(page).getByRole('link', { name: 'Filed folder' }));
  await ask.getByRole('button', { name: '移进团队知识库' }).click();
  await expect(page.getByText('已把「Private memo」移到「Filed folder」')).toBeVisible();
  await expect(memo).toHaveCount(0);
});

test('a folder with more than a page of items shows them all through 显示更多', async ({ page, request }) => {
  const big = await folder(request, 'Big folder');
  const titles = Array.from({ length: 205 }, (_, index) => `Note ${String(index + 1).padStart(3, '0')}`);
  for (let start = 0; start < titles.length; start += 25) {
    await Promise.all(
      titles.slice(start, start + 25).map((title) => doc(request, { title, folder_id: big.id, content: title })),
    );
  }
  await open(page, `/#/knowledge/folder/${big.id}`);
  const list = page.getByRole('main').getByRole('list', { name: 'Big folder' });
  const tree = directory(page);
  await expect(list.getByRole('link')).toHaveCount(200);
  await expect(tree.getByRole('link', { name: 'Note 200' })).toBeVisible();
  await expect(tree.getByRole('link', { name: 'Note 201' })).toHaveCount(0);

  // The page and the tree show the same folder: the next page loads for both.
  await page.getByRole('main').getByRole('button', { name: '显示更多' }).click();
  await expect(list.getByRole('link')).toHaveCount(205);
  await expect(tree.getByRole('link', { name: 'Note 205' })).toBeVisible();
  await expect(page.getByRole('button', { name: '显示更多' })).toHaveCount(0);

  // The tree has its own 显示更多 for a folder opened only there.
  await page.goto('/#/knowledge?space=team');
  await expect(tree.getByRole('button', { name: '显示更多' })).toHaveCount(0);
  await page.reload();
  await tree.getByRole('link', { name: 'Big folder' }).click();
  await page.goto('/#/knowledge?space=team');
  await expect(tree.getByRole('link', { name: 'Note 200' })).toBeVisible();
  await tree.getByRole('button', { name: '显示更多' }).click();
  await expect(tree.getByRole('link', { name: 'Note 205' })).toBeVisible();
});

test('export a doc as Markdown and a folder as a ZIP', async ({ page, request }) => {
  const handbook = await folder(request, 'Exported folder');
  const guide = await doc(request, { title: 'Exported guide', folder_id: handbook.id, content: 'Read me first.' });

  await open(page, `/#/knowledge/${guide.id}`);
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  const markdown = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '导出 Markdown' }).click();
  const file = await markdown;
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  const text = Buffer.concat(await (await file.createReadStream()).toArray()).toString('utf8');
  expect(text).toContain('# Exported guide');
  expect(text).toContain('Read me first.');

  await page.goto(`/#/knowledge/folder/${handbook.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Exported folder' })).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  const zip = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: '导出 ZIP' }).click();
  const archive = await zip;
  expect(archive.suggestedFilename()).toMatch(/\.zip$/);
  const bytes = Buffer.concat(await (await archive.createReadStream()).toArray());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
});

test('search finds a doc by the words in it, and so does ⌘K', async ({ page, request }) => {
  const pricing = await doc(request, {
    title: 'Pricing FAQ',
    content: 'Discounts for nonprofits apply after a short review.',
    space: 'team',
  });
  await open(page, '/#/knowledge');
  await page.getByRole('main').getByRole('textbox', { name: '搜索知识库' }).fill('nonprofits');
  const hit = page.getByRole('main').getByRole('link', { name: /Pricing FAQ/ });
  await expect(hit).toContainText('nonprofits');
  await hit.click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${pricing.id}$`));

  await page.goto('/#/agents');
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('combobox', { name: '搜索对话、文档、表格、Agent 和设置' }).fill('nonprofits');
  const option = page.getByRole('option', { name: /Pricing FAQ/ });
  await expect(option).toBeVisible();
  await option.click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${pricing.id}$`));
});

test('narrow screens: the tree is in the drawer with the module bar, and a file opens as a sheet', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await folder(request, 'Phone folder');
  await doc(request, { title: 'Phone note', content: 'Small screens.', folder_id: phone.id });
  await open(page, `/#/knowledge/folder/${phone.id}`);
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await page.getByRole('button', { name: '菜单' }).click();
  const drawer = directory(page);
  await expect(drawer.getByRole('radio', { name: '团队' })).toBeVisible();
  await expect(
    drawer.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '知识库' }),
  ).toHaveAttribute('aria-current', 'page');
  await drawer.getByRole('link', { name: 'Phone note' }).click();
  await expect(drawer).toBeHidden();
  await expect(docText(page)).toContainText('Small screens.');

  await page.goto(`/#/knowledge/folder/${phone.id}`);
  await page.locator('input[type="file"][aria-label="上传文件"]').setInputFiles({
    name: 'phone.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('on a phone'),
  });
  await page
    .getByRole('main')
    .getByRole('link', { name: /phone\.txt/ })
    .click();
  const sheet = page.getByRole('dialog', { name: 'phone.txt' });
  await expect(sheet.locator('pre')).toHaveText('on a phone');
  await expect(sheet.getByRole('button', { name: '下拉关闭详情' })).toBeAttached();
});

test('an Agent that used a doc lists it as a source, and the source and the link open the doc', async ({
  page,
  request,
}) => {
  const policy = await doc(request, {
    title: 'Travel policy',
    content: 'Book trains for trips under four hours.',
    space: 'team',
  });
  await open(page, '/#/c/new');
  await composer(page).fill('look up trains');
  await composer(page).press('Enter');
  await expect(page.getByText('Found it in')).toBeVisible();
  await page.getByRole('button', { name: '查看来源：Travel policy' }).click();
  const drawer = page.getByRole('dialog', { name: 'Travel policy' });
  await drawer.getByRole('button', { name: '打开文档' }).click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${policy.id}$`));
  await expect(docText(page)).toContainText('Book trains');

  // The link in the reply stays in the app too.
  await page.goBack();
  const link = page.locator('.app-message.is-reply').last().getByRole('link', { name: 'Travel policy' });
  await expect(link).not.toHaveAttribute('target', '_blank');
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#/knowledge/${policy.id}$`));
});

test('an Agent keeps notes in its own folder: its owner sees it under the Agent, and it cannot be shared or moved', async ({
  page,
}) => {
  await open(page, '/#/c/new');
  await composer(page).fill('keep a note: lunch is at noon');
  await composer(page).press('Enter');
  await expect(page.getByText('Done.')).toBeVisible();

  await page.goto('/#/knowledge?space=personal');
  const folderRow = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Greeny' });
  await expect(folderRow.locator('.pa-root')).toBeVisible();
  await folderRow.getByRole('button', { name: 'Greeny的操作' }).click();
  await expect(page.getByRole('menuitem', { name: '分享' })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: '移动到…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await folderRow.getByRole('link', { name: /Greeny/ }).click();
  await expect(page.getByText('Agent 的参考文件夹：只有这个 Agent 和你能看到。')).toBeVisible();
  // What is inside does not say it is in an Agent's folder; its menu offers no 分享 all the same.
  // A retried generation can leave another note with the same title in the shared fixture.
  const noteRow = page
    .getByRole('main')
    .getByRole('listitem')
    .filter({ hasText: /Agent note/ })
    .first();
  await noteRow.getByRole('button', { name: /^Agent note.*的操作$/ }).click();
  await expect(page.getByRole('menuitem', { name: '移动到…' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '分享' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await noteRow.getByRole('link', { name: /Agent note/ }).click();
  await expect(page.getByRole('main').getByText('Greeny 的参考资料')).toBeVisible();
  await expect(docText(page)).toContainText('lunch is at noon');
  await page.getByRole('main').getByRole('button', { name: '更多' }).click();
  await expect(page.getByRole('menuitem', { name: '分享' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a hostile doc stays inert: no scripts, handlers or script links survive, in the doc or its comments', async ({
  page,
  request,
}) => {
  const hostile = await doc(request, {
    title: 'Hostile',
    space: 'team',
    content: [
      '# Hello',
      '',
      '<script>window.__pwned = 1</script>',
      '',
      '<img src="x" onerror="window.__pwned = 2">',
      '',
      '[click](javascript:window.__pwned=3) and <a href="javascript:window.__pwned=4" onclick="window.__pwned=5">raw</a>',
      '',
      '<iframe src="javascript:window.__pwned=6"></iframe><form action="/x"><button>go</button></form>',
      '',
      '<p style="color:red" onmouseover="window.__pwned=7">styled</p>',
      '',
      '<div class="gh-overlay" id="root">a fake dialog</div>',
    ].join('\n'),
  });
  await apiAs(request, 'lin', 'POST', `/api/knowledge/docs/${hostile.id}/comments`, {
    body: 'Note <img src="y" onerror="window.__pwned = 8"> [x](javascript:window.__pwned=9)',
  });
  // Its own `# Hello` is a second h1, so wait for the page title by name.
  await page.goto(`/#/knowledge/${hostile.id}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Hostile' })).toBeVisible();
  const content = docText(page);
  await expect(content.getByRole('heading', { name: 'Hello' })).toBeVisible();
  await expect(page.locator('.app-comment')).toContainText('Note');
  const rendered = page.locator('.app-doc-main');
  expect(
    await rendered.locator('.app-doc-content script, .app-doc-content iframe, .app-doc-content form').count(),
  ).toBe(0);
  expect(
    await rendered
      .locator('.app-doc-content [onerror], .app-doc-content [onclick], .app-doc-content [onmouseover]')
      .count(),
  ).toBe(0);
  expect(await rendered.locator('.app-doc-content [style]').count()).toBe(0);
  // Nor can it borrow the app's classes (a full-screen overlay) or ids.
  await expect(rendered.getByText('a fake dialog')).toBeVisible();
  expect(await rendered.locator('.app-doc-content .gh-overlay, .app-doc-content [id]').count()).toBe(0);
  const hrefs = await rendered
    .locator('.app-doc-content a')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs.every((value) => value === null || /^(https?:|mailto:|#\/)/.test(value))).toBe(true);
  for (const link of await rendered.locator('.app-doc-content a').all()) await link.click();
  await rendered.getByText('styled').hover();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});
