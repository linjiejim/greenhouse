/**
 * An approval card's body in its sheet: what is about to happen
 * (`payload.title`) and every server-derived detail — never the model's own
 * description — with the server's truncation markers said in the member's
 * language (web request-card-parts.tsx `DetailList`). Short values sit beside
 * their label; a long one (a task prompt, a message body) gets the row's whole
 * width under its label (./decision.ts `detailStacked`).
 */

import React, { useMemo } from 'react';
import { Text } from 'react-native';
import type { BotApprovalPayload, BotRequestView } from '../../shared/bots';
import { useT } from '../../lib/i18n';
import { typo, useTheme, weight } from '../../theme';
import { CardNote, InfoRow } from './card-frame';
import { detailRows, detailStacked } from './decision';

export function ApprovalBody({ request }: { request: BotRequestView }) {
  const t = useT();
  const { colors: c } = useTheme();
  const payload = request.payload as BotApprovalPayload;
  const parsed = useMemo(() => detailRows(payload.details), [payload.details]);
  return (
    <>
      {payload.title ? (
        <Text style={{ ...typo.title3, fontWeight: weight.semibold, color: c.label }} selectable>
          {payload.title}
        </Text>
      ) : null}
      {parsed.rows.map((row, index) => (
        <InfoRow
          key={`${index}:${row.label}`}
          label={row.label}
          value={row.value}
          stack={detailStacked(row)}
          selectable
          note={row.moreChars !== null ? t('bots.card.moreChars', { n: row.moreChars }) : undefined}
        />
      ))}
      {parsed.hiddenFields !== null ? <CardNote text={t('bots.card.moreFields', { n: parsed.hiddenFields })} /> : null}
    </>
  );
}
