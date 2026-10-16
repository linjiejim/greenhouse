/**
 * GET    /api/skills?q=&space=&kind=&scan_status=&archived=&agent=   the skills I see; `available` for that Agent (main by default)
 * POST   /api/skills                    a template, or a package from a ZIP uploaded with purpose `skill`
 * GET    /api/skills/starters?agent=    the new chat: my three most-used skills for that Agent, else its template's starters
 * GET    /api/skills/:id                one skill, with its latest version's text and files
 * PATCH  /api/skills/:id                display name, description, tags (its owner, or an admin for a team skill)
 * DELETE /api/skills/:id                archive
 * POST   /api/skills/:id/restore        bring it back
 * GET    /api/skills/:id/versions       its versions, newest first
 * POST   /api/skills/:id/versions       a new version: a new ZIP, or a template's new text and fields
 * POST   /api/skills/:id/scan           scan again, or a reviewer's decision: safe or malicious
 * GET    /api/skills/:id/download?version=   a signed URL to the package's ZIP
 */

import { Hono } from 'hono';
import {
  createSkillInputSchema,
  idParamSchema,
  newSkillVersionInputSchema,
  skillDownloadQuerySchema,
  skillListQuerySchema,
  skillScanDecisionInputSchema,
  skillStartersQuerySchema,
  updateSkillInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { SkillsService } from './service.js';

export function skillRoutes(service: SkillsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member'), readQuery(c, skillListQuerySchema))))
    .post('/', async (c) =>
      c.json(await service.create(c.get('member'), await readJson(c, createSkillInputSchema)), 201),
    )
    .get('/starters', async (c) =>
      c.json(await service.starters(c.get('member'), readQuery(c, skillStartersQuerySchema).agent)),
    )
    .get('/:id', async (c) => c.json(await service.get(c.get('member'), readParam(c, 'id', idParamSchema))))
    .patch('/:id', async (c) =>
      c.json(
        await service.update(
          c.get('member'),
          readParam(c, 'id', idParamSchema),
          await readJson(c, updateSkillInputSchema),
        ),
      ),
    )
    .delete('/:id', async (c) => {
      await service.archive(c.get('member'), readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    })
    .post('/:id/restore', async (c) =>
      c.json(await service.restore(c.get('member'), readParam(c, 'id', idParamSchema))),
    )
    .get('/:id/versions', async (c) =>
      c.json({ items: await service.versions(c.get('member'), readParam(c, 'id', idParamSchema)) }),
    )
    .post('/:id/versions', async (c) =>
      c.json(
        await service.addVersion(
          c.get('member'),
          readParam(c, 'id', idParamSchema),
          await readJson(c, newSkillVersionInputSchema),
        ),
        201,
      ),
    )
    .post('/:id/scan', async (c) =>
      c.json(
        await service.scan(
          c.get('member'),
          readParam(c, 'id', idParamSchema),
          await readJson(c, skillScanDecisionInputSchema),
        ),
      ),
    )
    .get('/:id/download', async (c) =>
      c.json(
        await service.download(
          c.get('member'),
          readParam(c, 'id', idParamSchema),
          readQuery(c, skillDownloadQuerySchema).version,
        ),
      ),
    );
}
