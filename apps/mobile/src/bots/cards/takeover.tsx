/**
 * The three take-over cards' bodies (buttons: ./decision.ts `cardButtons`;
 * the computer page: app/bots/computer.tsx):
 * - `handback` — the computer raised it itself (the member took over while a
 *   Bot was mid-action, or holds it while one waits): the page and site;
 *   "Hand Back", or open the computer. The page title is page content: on
 *   this card only, never in a transcript line or a notification.
 * - `captcha` — a site asked for human verification, which only a person at
 *   the computer screen can pass: "Verify" opens the computer page in control,
 *   whose Done hands back for this card — or skip (the Bot tries another way).
 * - `takeover` — a Bot asked for a hand on the computer: "Take Over", the same
 *   way, or skip.
 */

import React from 'react';
import { Text } from 'react-native';
import type { BotRequestView, BotTakeoverPayload } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { typo, useTheme } from '../../theme';
import { humanCheckTakeover, implicitTakeover } from '../vendor/web-helpers';
import { CardNote, InfoRow } from './card-frame';
import { cardKind, hostOf } from './decision';

export function TakeoverBody({ request, name }: { request: BotRequestView; name: string }) {
  const t = useT();
  const { colors: c } = useTheme();
  const kind = cardKind(request);
  const pending = request.status === 'pending';

  if (kind === 'handback') {
    const implicit = implicitTakeover(request.payload);
    return (
      <>
        {implicit?.title ? (
          <InfoRow label={t('bots.card.page')} value={implicit.title} />
        ) : null}
        {implicit?.host ? <InfoRow label={t('bots.card.site')} value={implicit.host} lines={1} /> : null}
      </>
    );
  }

  const check = kind === 'captcha' ? humanCheckTakeover(request.payload) : null;
  const payload = request.payload as BotTakeoverPayload;
  const reason = (check ? check.reason : typeof payload.reason === 'string' ? payload.reason.trim() : '') || '';
  const url = check ? check.url : payload.url;
  const host = hostOf(url);
  return (
    <>
      {reason ? (
        <Text style={{ ...typo.body, color: c.label }} selectable>
          {reason}
        </Text>
      ) : null}
      {url ? (
        <InfoRow label={t('bots.card.page')} value={url} selectable />
      ) : host ? (
        <InfoRow label={t('bots.card.site')} value={host} lines={1} />
      ) : null}
      {pending ? (
        <CardNote text={t(kind === 'captcha' ? 'bots.card.captchaHint' : 'bots.card.otherHint', { name })} />
      ) : null}
    </>
  );
}
