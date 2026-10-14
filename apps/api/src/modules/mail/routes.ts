/**
 * Public, verified by the vendor's signature (mailInboundRoutes):
 * POST   /api/mail/inbound/:instance             a vendor's notice of received mail (Resend webhook, Mailgun store notify)
 *
 * The Agent's owner (agentMailRoutes, under /api/agents):
 * GET    /api/agents/:id/mailbox                 the address, who may wake it, how much mail waits (made on first look)
 * PATCH  /api/agents/:id/mailbox                 a new address prefix; whether workspace members may wake it
 * POST   /api/agents/:id/mailbox/senders         let an address wake it
 * DELETE /api/agents/:id/mailbox/senders/:address
 * GET    /api/agents/:id/mail?status=            its mail, newest first
 * GET    /api/agents/:id/mail/:mailId            one mail: text, HTML as received, signed attachment links
 * POST   /api/agents/:id/mail/:mailId/release    let a screened mail's sender in; what waited goes into the thread
 *
 * Admins (adminMailRoutes, under /api/admin/mail):
 * GET    /api/admin/mail                         can it send, the Agent domain, the receiving instances and their inbound URLs
 * PUT    /api/admin/mail                         the Agent domain (null: back to MAIL_AGENT_DOMAIN)
 * POST   /api/admin/mail/test                    a test mail to me
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  addMailSenderInputSchema,
  idParamSchema,
  mailListQuerySchema,
  updateAdminMailInputSchema,
  updateMailboxInputSchema,
} from '@greenhouse/contract';
import { errorBody } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { MailService } from './service.js';

/** The largest notice any vendor sends (a Mailgun notify can carry the mail's attachments too). */
const NOTICE_LIMIT_BYTES = 41 * 1024 * 1024;
const instanceParamSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const senderParamSchema = z.string().trim().toLowerCase().email().max(254);

export function mailInboundRoutes(service: MailService) {
  return new Hono<AppEnv>().post(
    '/inbound/:instance',
    bodyLimit({
      maxSize: NOTICE_LIMIT_BYTES,
      onError: (c) => c.json(errorBody('too_large', 'The notice is too large.'), 413),
    }),
    async (c) => {
      const instance = readParam(c, 'instance', instanceParamSchema);
      // Signatures cover the exact bytes: read them before anything parses the body.
      const body = new Uint8Array(await c.req.arrayBuffer());
      return c.json(await service.receive(instance, { headers: c.req.raw.headers, body }));
    },
  );
}

export function agentMailRoutes(service: MailService) {
  return new Hono<AppEnv>()
    .get('/:id/mailbox', async (c) => c.json(await service.mailbox(c.get('member').id, c.req.param('id'))))
    .patch('/:id/mailbox', async (c) =>
      c.json(
        await service.updateMailbox(c.get('member').id, c.req.param('id'), await readJson(c, updateMailboxInputSchema)),
      ),
    )
    .post('/:id/mailbox/senders', async (c) => {
      const input = await readJson(c, addMailSenderInputSchema);
      return c.json(await service.addSender(c.get('member').id, c.req.param('id'), input.address), 201);
    })
    .delete('/:id/mailbox/senders/:address', async (c) =>
      c.json(
        await service.removeSender(c.get('member').id, c.req.param('id'), readParam(c, 'address', senderParamSchema)),
      ),
    )
    .get('/:id/mail', async (c) =>
      c.json(await service.list(c.get('member').id, c.req.param('id'), readQuery(c, mailListQuerySchema))),
    )
    .get('/:id/mail/:mailId', async (c) =>
      c.json(await service.get(c.get('member').id, c.req.param('id'), readParam(c, 'mailId', idParamSchema))),
    )
    .post('/:id/mail/:mailId/release', async (c) =>
      c.json(await service.release(c.get('member').id, c.req.param('id'), readParam(c, 'mailId', idParamSchema))),
    );
}

export function adminMailRoutes(service: MailService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.adminView()))
    .put('/', async (c) =>
      c.json(await service.saveAdmin(c.get('member').id, await readJson(c, updateAdminMailInputSchema))),
    )
    .post('/test', async (c) => c.json(await service.test(c.get('member').id)));
}
