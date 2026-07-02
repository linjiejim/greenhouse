/**
 * Fork extension point for chat body-artifact renderers — the ONLY file a
 * downstream fork edits to give a private tool a custom inline chat card.
 *
 * Upstream (greenhouse) ships this EMPTY. A fork adds `{ match, render }` entries;
 * `body-artifacts.tsx` consults them AFTER its core cases in both `isArtifactCall`
 * (does this call become an inline artifact vs. a trace-block row?) and
 * `BodyArtifactItem` (how is it rendered?). So a private tool's output renders as a
 * rich card WITHOUT editing body-artifacts.tsx — that file stays identical to
 * upstream and never conflicts on sync.
 *
 * Fork example (in the fork's copy of this file):
 *
 *   import { EvalResultCard } from './eval-result-card';
 *   export const ARTIFACT_RENDERERS: ArtifactRenderer[] = [
 *     { match: (c) => c.name === 'eval_message', render: (c) => <EvalResultCard call={c} /> },
 *   ];
 */

import type React from 'react';
import type { ArtifactCall, ArtifactCtx } from './body-artifacts';

export interface ArtifactRenderer {
  /** True if this call should render as a body artifact via this renderer. */
  match: (call: ArtifactCall) => boolean;
  /** Render the card. Return null to fall through to the trace block. */
  render: (call: ArtifactCall, ctx: ArtifactCtx) => React.ReactNode;
}

/** Private artifact renderers contributed by a downstream fork. Empty upstream. */
export const ARTIFACT_RENDERERS: ArtifactRenderer[] = [];

/** First fork renderer that matches this call, if any. */
export function findArtifactRenderer(call: ArtifactCall): ArtifactRenderer | undefined {
  return ARTIFACT_RENDERERS.find((r) => r.match(call));
}
