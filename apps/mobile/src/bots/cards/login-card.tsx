/**
 * A sign-in card's body: where the values would go — the page's real origin,
 * server-derived, so the member checks it before typing anything — the Bot's
 * reason, and the saved logins that match. The values themselves are typed in
 * the secure sign-in sheet ("Sign In…" → /bots/login), never on the card.
 *
 * When the sheet's attempt was refused because the page itself moved on
 * (`LOGIN_PAGE_MOVED`, handed back through `useLoginRefusals`), retyping will
 * not help: the card says why and offers to have the Bot start over.
 */

import React from 'react';
import { Text, View } from 'react-native';
import type { BotLoginPayload, BotRequestErrorCode, BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { space, typo, useTheme } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon } from '../../ui/core';
import { CardNote, InfoRow } from './card-frame';
import { decisionErrorKey } from './decision';
import { useLoginRefusals } from './use-login-form';

/** Saved logins listed on the card (the sheet's footer does not repeat them). */
const MATCHES_SHOWN = 2;

export function LoginBody({
  request,
  name,
  full = false,
  onAskAgain,
}: {
  request: BotRequestView;
  name: string;
  full?: boolean;
  /** Offered after a page-moved refusal (a thread that can still send). */
  onAskAgain?: () => void;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const payload = request.payload as BotLoginPayload;
  const refused = useLoginRefusals((s) => s.byId[request.id]);
  const origin = payload.origin ?? payload.url ?? '';
  const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
  const matches = (payload.vault_matches ?? []).slice(0, full ? undefined : MATCHES_SHOWN);
  return (
    <>
      {origin ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}
          accessible
          accessibilityLabel={`${t('bots.card.site')}: ${origin}`}
        >
          <Icon name="lock" size={13} weight="semibold" color={c.secondaryLabel} />
          <Text style={{ ...typo.subheadline, color: c.label, flex: 1 }} numberOfLines={1} ellipsizeMode="middle">
            {origin}
          </Text>
        </View>
      ) : null}
      {full && payload.url && payload.url !== payload.origin ? (
        <InfoRow label={t('bots.card.page')} value={payload.url} selectable />
      ) : null}
      {reason ? (
        <Text style={{ ...typo.body, color: c.label }} numberOfLines={full ? undefined : 3}>
          {reason}
        </Text>
      ) : null}
      {request.status === 'pending'
        ? matches.map((match) => (
            <CardNote
              key={match.id}
              text={t('bots.card.vaultHas', { label: match.label, hint: match.username_hint })}
            />
          ))
        : null}
      {refused && request.status === 'pending' ? (
        <>
          <CardNote text={t(decisionErrorKey(refused as BotRequestErrorCode, 409))} tone={c.orange} />
          {onAskAgain ? (
            <View style={{ alignSelf: 'flex-start' }}>
              <NativeButton label={t('bots.card.reissue', { name })} size="small" onPress={onAskAgain} />
            </View>
          ) : null}
        </>
      ) : null}
    </>
  );
}
