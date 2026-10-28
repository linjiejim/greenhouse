import { afterEach, expect, it, vi } from 'vitest';
import { registerNotificationTransports } from '../../../../apps/api/src/notifications/transports.js';
import { notifySuspiciousSkill } from './notify.js';
afterEach(() => {
  vi.unstubAllEnvs();
  registerNotificationTransports([]);
});
it('sends system webhooks only through an enabled adapter', async () => {
  vi.stubEnv('SKILLS_WECOM_WEBHOOK_URL', 'https://notify.example/hook');
  const send = vi.fn().mockResolvedValue({ ok: true });
  const input = { skill: { name: 'fixture', owner_user_id: 'member' } as never, version: '1.0.0', findings: [] };
  registerNotificationTransports([]);
  await notifySuspiciousSkill(input);
  expect(send).not.toHaveBeenCalled();
  registerNotificationTransports([
    {
      id: 'fixture',
      title: 'Fixture',
      deliver: async () => ({ ok: true }),
      acceptsWebhook: (url) => url.protocol === 'https:' && url.hostname === 'notify.example',
      sendWebhook: send,
    },
  ]);
  await notifySuspiciousSkill(input);
  expect(send).toHaveBeenCalledWith('https://notify.example/hook', expect.stringContaining('fixture'));
});
