/**
 * The three take-over cards' bodies. The phone cannot show the computer, so
 * each says plainly what can be done from here (D11):
 * - `handback` — the computer raised it itself (the member took over while a
 *   Bot was mid-action, or holds it while one waits): the page and site, and
 *   "Hand Back" is the only action. The page title is page content: on this
 *   card only, never in a transcript line or a notification.
 * - `captcha` — a site asked for human verification, which only a person at
 *   the computer screen can pass: skip it here (the Bot tries another way) or
 *   do it on the web.
 * - `takeover` — a Bot asked for a hand on the computer: skip, or confirm it
 *   was done on the web (the server reads approve as "done, hand back").
 */

import React from 'react';
import { Text } from 'react-native';
import type { BotRequestView, BotTakeoverPayload } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { typo, useTheme } from '../../theme';
import { humanCheckTakeover, implicitTakeover } from '../vendor/web-helpers';
import { CardNote, InfoRow } from './card-frame';
import { cardKind, hostOf } from './decision';

export function TakeoverBody({
  request,
  name,
  full = false,
}: {
  request: BotRequestView;
  name: string;
  full?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const kind = cardKind(request);
  const pending = request.status === 'pending';

  if (kind === 'handback') {
    const implicit = implicitTakeover(request.payload);
    return (
      <>
        {implicit?.title ? (
          <InfoRow label={t('bots.card.page')} value={implicit.title} lines={full ? undefined : 2} />
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
        <Text style={{ ...typo.body, color: c.label }} numberOfLines={full ? undefined : 3} selectable={full}>
          {reason}
        </Text>
      ) : null}
      {full && url ? (
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
