/**
 * `RequestCard` — a "needs you" card (approval, task start, Bot proposal,
 * instructions change, sign-in, takeover) with its decision buttons, in a
 * thread and in the needs-you sheet (spec docs/specs/20261008-mobile-bots.md
 * §2.5.4; props: ../contract.ts `RequestCardProps`).
 *
 * P0 STUB (package C implements it): renders nothing yet.
 */

import React, { memo } from 'react';
import type { RequestCardProps } from '../contract';

export const RequestCard: React.NamedExoticComponent<RequestCardProps> = memo(function RequestCard(
  _props: RequestCardProps,
) {
  return null;
});
