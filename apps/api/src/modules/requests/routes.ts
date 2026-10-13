/**
 * GET  /api/requests?state=pending|all&conversation_id=   what needs me
 * POST /api/requests/:id/approve                           approve an action or accept a proposal
 * POST /api/requests/:id/reject                            decline, with an optional reason
 * POST /api/requests/:id/answer                            answer a question
 * POST /api/requests/:id/handback                          hand the computer back after a take-over or a sign-in
 */

import { Hono } from 'hono';
import {
  answerInputSchema,
  handbackInputSchema,
  rejectInputSchema,
  requestListQuerySchema,
  type QuestionField,
} from '@greenhouse/contract';
import type { Engine } from '../../engine/engine.js';
import { conflict, invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import { toRequest, type RequestsService } from './service.js';

export function requestRoutes(service: RequestsService, engine: Engine) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, requestListQuerySchema))))
    .post('/:id/approve', async (c) => {
      const memberId = c.get('member').id;
      const current = await service.get(memberId, c.req.param('id'));
      if (current.kind !== 'approval' && current.kind !== 'proposal') {
        throw conflict('wrong_decision', 'This card is not decided by approving.');
      }
      const settled = await service.settle(memberId, current.id, {
        status: 'approved',
        result: { decision: 'approved' },
      });
      engine.decide(settled);
      return c.json(toRequest(settled));
    })
    .post('/:id/reject', async (c) => {
      const memberId = c.get('member').id;
      const { reason } = await readJson(c, rejectInputSchema);
      const current = await service.get(memberId, c.req.param('id'));
      if (current.kind === 'login' || current.kind === 'takeover') {
        throw conflict('wrong_decision', 'Hand this back instead.');
      }
      const settled = await service.settle(memberId, current.id, {
        status: 'rejected',
        result: { decision: 'rejected', ...(reason ? { reason } : {}) },
      });
      engine.decide(settled);
      return c.json(toRequest(settled));
    })
    .post('/:id/answer', async (c) => {
      const memberId = c.get('member').id;
      const { answers } = await readJson(c, answerInputSchema);
      const current = await service.get(memberId, c.req.param('id'));
      if (current.kind !== 'question') throw conflict('wrong_decision', 'Only a question takes an answer.');
      const fields = (current.payload.fields ?? []) as QuestionField[];
      for (const field of fields) {
        const value = answers[field.key]?.trim();
        if (field.required && !value) throw invalidInput(`Answer "${field.label}".`);
        if (value && field.type === 'choice' && field.options && !field.options.includes(value)) {
          throw invalidInput(`Choose one of the options for "${field.label}".`);
        }
      }
      const known = Object.fromEntries(fields.map((field) => [field.key, (answers[field.key] ?? '').trim()]));
      const settled = await service.settle(memberId, current.id, { status: 'answered', result: { answers: known } });
      engine.decide(settled);
      return c.json(toRequest(settled));
    })
    .post('/:id/handback', async (c) => {
      const memberId = c.get('member').id;
      const { note } = await readJson(c, handbackInputSchema);
      const current = await service.get(memberId, c.req.param('id'));
      if (current.kind !== 'takeover' && current.kind !== 'login') {
        throw conflict('wrong_decision', 'Only a take-over or a sign-in is handed back.');
      }
      const settled = await service.settle(memberId, current.id, {
        status: 'handed_back',
        result: { decision: 'handed_back', ...(note ? { note } : {}) },
      });
      engine.decide(settled);
      return c.json(toRequest(settled));
    });
}
