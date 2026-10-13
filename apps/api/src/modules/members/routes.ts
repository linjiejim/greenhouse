/**
 * GET    /api/me                        the signed-in member
 * PATCH  /api/me                        name, locale, timezone, theme, about, notification settings
 * POST   /api/me/password               change password (signs out other sessions)
 * GET    /api/members                   directory: active members (id, name, email, avatar)
 * GET    /api/admin/members             admin: all members, cursor paged
 * POST   /api/admin/members             admin: invite → member + one-time activation link
 * PATCH  /api/admin/members/:id         admin: role, status, modules, name
 * POST   /api/admin/members/:id/link    admin: a fresh activation or reset link
 * GET    /api/admin/groups              admin: groups with member ids
 * POST   /api/admin/groups              admin: create a group
 * PUT    /api/admin/groups/:id          admin: replace name, description and members
 * DELETE /api/admin/groups/:id          admin: delete a group
 */

import { Hono } from 'hono';
import {
  changePasswordInputSchema,
  groupInputSchema,
  inviteInputSchema,
  pageQuerySchema,
  updateMeInputSchema,
  updateMemberInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { MembersService } from './service.js';

export function meRoutes(service: MembersService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.me(c.get('member').id)))
    .patch('/', async (c) => c.json(await service.updateMe(c.get('member').id, await readJson(c, updateMeInputSchema))))
    .post('/password', async (c) => {
      const input = await readJson(c, changePasswordInputSchema);
      await service.changePassword(c.get('member').id, input.current_password, input.new_password);
      return c.body(null, 204);
    });
}

export function directoryRoutes(service: MembersService) {
  return new Hono<AppEnv>().get('/', async (c) => c.json({ items: await service.directory() }));
}

export function adminMemberRoutes(service: MembersService) {
  return new Hono<AppEnv>()
    .get('/members', async (c) => c.json(await service.list(readQuery(c, pageQuerySchema))))
    .post('/members', async (c) => c.json(await service.invite(await readJson(c, inviteInputSchema)), 201))
    .patch('/members/:id', async (c) =>
      c.json(await service.update(c.get('member').id, c.req.param('id'), await readJson(c, updateMemberInputSchema))),
    )
    .post('/members/:id/link', async (c) => c.json(await service.issueResetLink(c.req.param('id'))))
    .get('/groups', async (c) => c.json({ items: await service.listGroups() }))
    .post('/groups', async (c) =>
      c.json(await service.saveGroup(c.get('member').id, await readJson(c, groupInputSchema)), 201),
    )
    .put('/groups/:id', async (c) =>
      c.json(await service.saveGroup(c.get('member').id, await readJson(c, groupInputSchema), c.req.param('id'))),
    )
    .delete('/groups/:id', async (c) => {
      await service.deleteGroup(c.req.param('id'));
      return c.body(null, 204);
    });
}
