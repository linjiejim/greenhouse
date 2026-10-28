import type { Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { installPlaces, PROJECT } from './p3-fixture';
import { DOC } from './p2-fixture';
// A private document of mine, beside the fixture's team document DOC.
export const PRIVATE_DOC = 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P9';
const at = '2026-10-22T09:00:00Z';
/**
 * The project members panel and the document share dialog on top of the P3 places: members and
 * grants live in memory and change with the writes. `me` is the signed-in member's role; `refuse`
 * makes every member or share write answer 403, as a station whose rules differ would.
 */
export async function installCollab(page: Page, opts: { me?: 'super' | 'team'; refuse?: boolean } = {}) {
  const places = await installPlaces(page);
  const people = [
    { id: 'member', nickname: '林杰', role: opts.me ?? 'super' },
    { id: 'usr_wang', nickname: '王宁', role: 'team' },
    { id: 'usr_zhao', nickname: '赵敏', role: 'team' },
    { id: 'usr_qian', nickname: '钱多', role: 'team' },
  ];
  const nick = (id: string) => people.find((p) => p.id === id)?.nickname ?? id;
  const members = [
    { id: 'pm-1', project_id: PROJECT, user_id: 'usr_wang', role: 'owner', nickname: '王宁' },
    { id: 'pm-2', project_id: PROJECT, user_id: 'member', role: 'member', nickname: '林杰' },
    { id: 'pm-3', project_id: PROJECT, user_id: 'usr_qian', role: 'member', nickname: '钱多' },
  ];
  const shares = [{ target: 'usr_wang', name: '王宁', role: 'reader' }];
  const writes: { path: string; method: string; body: any }[] = [];
  const project = {
    id: PROJECT,
    title: 'Q4 新品上线',
    status: 'active',
    color: null,
    progress: 68,
    owner_id: 'usr_wang',
    owner_nickname: '王宁',
    created_by: 'usr_wang',
    stats: { total: 2, todo: 1, in_progress: 1, in_review: 0, done: 0, cancelled: 0 },
    created_at: at,
    updated_at: at,
  };
  const doc = {
    id: PRIVATE_DOC,
    slug: 'my-notes',
    title: '我的季度笔记',
    folder_id: null,
    visibility: 'private',
    status: 'published',
    tags: '[]',
    owner_user_id: 'member',
    updated_by: 'member',
    summary: '',
    content_markdown: '## 季度目标\n\n先写给自己看，再分享给同事。',
    content_json: '{}',
    created_at: at,
    updated_at: at,
    access: 'owner',
  };
  await page.route('**/api/**', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      method = req.method(),
      body = ['POST', 'PATCH'].includes(method) ? req.postDataJSON() : null;
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status });
    if (path === '/api/auth/me')
      return json({
        user: {
          id: 'member',
          role: opts.me ?? 'super',
          nickname: '林杰',
          email: 'jim@test.local',
          locale: 'zh',
          features: { tables: true },
        },
      });
    if (path === '/api/projects/meta/users') return json({ users: people });
    if (path === '/api/sessions/shareable-users')
      return json({ users: people.filter((p) => p.id !== 'member').map(({ id, nickname }) => ({ id, nickname })) });
    if (path === `/api/projects/${PROJECT}`)
      return json({ project, tasks: places.tasks, members, stats: project.stats, progress: 68 });
    const member = new RegExp(`^/api/projects/${PROJECT}/members(?:/([^/]+))?$`).exec(path);
    if (member) {
      if (method === 'GET') return json({ members });
      writes.push({ path, method, body });
      if (opts.refuse) return json({ error: 'Project not found' }, 403);
      const target = member[1] ? decodeURIComponent(member[1]) : body.user_id;
      const index = members.findIndex((m) => m.user_id === target);
      if (method === 'POST') {
        members.push({
          id: `pm-${members.length + 1}`,
          project_id: PROJECT,
          user_id: target,
          role: body.role,
          nickname: nick(target),
        });
        return json({ member: members.at(-1) }, 201);
      }
      if (method === 'PATCH') {
        members[index]!.role = body.role;
        return json({ member: members[index] });
      }
      members.splice(index, 1);
      return json({ success: true });
    }
    if (path === '/api/knowledge/docs') {
      const visibility = url.searchParams.get('visibility');
      if (visibility === 'private') return json({ docs: [doc] });
      return route.fallback();
    }
    if (path === `/api/knowledge/docs/id/${PRIVATE_DOC}`) return json({ doc });
    // the team document is mine too: still nothing to share person by person
    if (path === `/api/knowledge/docs/id/${DOC}`)
      return json({ doc: { ...places.docs[0], owner_user_id: 'member', access: 'owner' } });
    const share = new RegExp(`^/api/knowledge/docs/${PRIVATE_DOC}/shares(?:/([^/]+))?$`).exec(path);
    if (share) {
      if (method === 'GET') return json({ shares });
      writes.push({ path, method, body });
      if (opts.refuse) return json({ error: 'Only the owner can manage sharing' }, 403);
      if (method === 'POST') {
        for (const id of body.user_ids as string[]) {
          const found = shares.find((s) => s.target === id);
          if (found) found.role = body.role;
          else shares.push({ target: id, name: nick(id), role: body.role });
        }
        return json({ success: true });
      }
      shares.splice(
        shares.findIndex((s) => s.target === decodeURIComponent(share[1] ?? '')),
        1,
      );
      return json({ success: true });
    }
    return route.fallback();
  });
  return { ...places, members, shares, writes };
}

/** Design captures for review, kept out of git (.work is ignored). */
export async function collabShot(page: Page, name: string) {
  mkdirSync('.work/collab', { recursive: true });
  await page.screenshot({ path: `.work/collab/${name}.png` });
}
