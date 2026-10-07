/**
 * An approval card's body: what is about to happen (`payload.title`) and the
 * server-derived details — never the model's own description. On the card:
 * the first three rows, two lines each, and "View All ›" (the card sheet)
 * when anything is left out; in the sheet: every row in full, with the
 * server's truncation markers said in the member's language (web
 * request-card-parts.tsx `DetailList`).
 */

import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { BotApprovalPayload, BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { typo, useTheme } from '../../theme';
import { CardNote, InfoRow, MoreLink } from './card-frame';
import { CARD_DETAIL_ROWS, detailRows, detailsTruncated } from './decision';

export function ApprovalBody({
  request,
  sessionId,
  full = false,
}: {
  request: BotRequestView;
  sessionId: string;
  /** The card sheet: every row, whole. */
  full?: boolean;
}) {
  const t = useT();
  const { colors: c } = useTheme();
  const router = useRouter();
  const payload = request.payload as BotApprovalPayload;
  const parsed = useMemo(() => detailRows(payload.details), [payload.details]);
  const rows = full ? parsed.rows : parsed.rows.slice(0, CARD_DETAIL_ROWS);
  return (
    <>
      {payload.title ? (
        <Text style={{ ...typo.body, color: c.label }} numberOfLines={full ? undefined : 3} selectable={full}>
          {payload.title}
        </Text>
      ) : null}
      {rows.map((row, index) => (
        <InfoRow
          key={`${index}:${row.label}`}
          label={row.label}
          value={row.value}
          lines={full ? undefined : 2}
          selectable={full}
          note={full && row.moreChars !== null ? t('bots.card.moreChars', { n: row.moreChars }) : undefined}
        />
      ))}
      {full && parsed.hiddenFields !== null ? (
        <CardNote text={t('bots.card.moreFields', { n: parsed.hiddenFields })} />
      ) : null}
      {!full && detailsTruncated(parsed) ? (
        <MoreLink
          label={t('bots.card.viewAll')}
          onPress={() => router.push({ pathname: '/bots/request', params: { id: request.id, c: sessionId } })}
        />
      ) : null}
    </>
  );
}
