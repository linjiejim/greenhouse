import { Hono } from 'hono';
import {
  appCardRequestSchema,
  appBindingSchema,
  appReviewSchema,
  appCreateSchema,
  appDraftSchema,
  appExecuteSchema,
  appFlagSchema,
  appListQuerySchema,
  appPublishSchema,
  appRestoreSchema,
  appRuntimeQuerySchema,
  idParamSchema,
  pageQuerySchema,
  templateInstallSchema,
  templateReviewSchema,
  templateSaveSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { AppsService } from './service.js';

export function appsRoutes(service: AppsService) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, appListQuerySchema))))
    .post('/', async (c) => c.json(await service.create(c.get('member').id, await readJson(c, appCreateSchema)), 201))
    .get('/reviews', async (c) => c.json(await service.reviews(c.get('member').id, readQuery(c, pageQuerySchema))))
    .get('/templates', async (c) =>
      c.json(await service.templates.list(c.get('member').id, readQuery(c, pageQuerySchema))),
    )
    .get('/templates/:id', async (c) => c.json(await service.templates.get(c.get('member').id, id(c))))
    .post('/templates/:id/review', async (c) =>
      c.json(
        await service.templates.review(c.get('member').id, id(c), (await readJson(c, templateReviewSchema)).decision),
      ),
    )
    .post('/templates/:id/install', async (c) =>
      c.json(
        await service.templates.install(c.get('member').id, id(c), (await readJson(c, templateInstallSchema)).name),
        201,
      ),
    )
    .get('/:id/draft', async (c) => c.json(await service.draft(c.get('member').id, id(c))))
    .put('/:id/draft', async (c) =>
      c.json(await service.save(c.get('member').id, id(c), await readJson(c, appDraftSchema))),
    )
    .post('/:id/publish', async (c) =>
      c.json(await service.publish(c.get('member').id, id(c), await readJson(c, appPublishSchema))),
    )
    .get('/:id/versions', async (c) =>
      c.json(await service.versions(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/:id/restore', async (c) =>
      c.json(await service.restore(c.get('member').id, id(c), await readJson(c, appRestoreSchema))),
    )
    .get('/:id', async (c) =>
      c.json(await service.runtime(c.get('member').id, id(c), readQuery(c, appRuntimeQuerySchema).preview_role)),
    )
    .post('/:id/review', async (c) => {
      await service.review(c.get('member').id, id(c), await readJson(c, appReviewSchema));
      return c.body(null, 204);
    })
    .post('/:id/bindings/query', async (c) =>
      c.json(await service.binding(c.get('member').id, id(c), await readJson(c, appBindingSchema))),
    )
    .post('/:id/cards/query', async (c) =>
      c.json(await service.card(c.get('member').id, id(c), await readJson(c, appCardRequestSchema))),
    )
    .post('/:id/cards/:card/records/:record', async (c) => {
      const input = await readJson(c, appCardRequestSchema.omit({ card: true }));
      return c.json(
        await service.record(
          c.get('member').id,
          id(c),
          { ...input, card: readParam(c, 'card', idParamSchema) },
          readParam(c, 'record', idParamSchema),
        ),
      );
    })
    .post('/:id/actions', async (c) =>
      c.json(await service.execute(c.get('member').id, id(c), await readJson(c, appExecuteSchema))),
    )
    .post('/:id/templates', async (c) =>
      c.json(await service.templates.save(c.get('member').id, id(c), await readJson(c, templateSaveSchema)), 201),
    )
    .put('/:id/pin', async (c) => {
      await service.pin(c.get('member').id, id(c), (await readJson(c, appFlagSchema)).value);
      return c.body(null, 204);
    })
    .put('/:id/featured', async (c) => {
      await service.feature(c.get('member').id, id(c), (await readJson(c, appFlagSchema)).value);
      return c.body(null, 204);
    });
}
