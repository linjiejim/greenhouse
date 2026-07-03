/**
 * Fenced-block registry — the one place to extend the renderer. Map a fence
 * language (```<lang>) to a component and it renders automatically: the parser
 * (./parse) and the root (./index) need no edits. Each block owns its own
 * fallback (Chart renders a plain code block on bad JSON), so a malformed block
 * degrades to code rather than breaking the message.
 *
 * To add mermaid / a custom component, drop one entry here:
 *   mermaid: ({ raw }) => <Mermaid src={raw} />,
 */
import type { ReactElement } from 'react';
import { Chart } from './blocks/chart';

/** Renders the raw body between the ``` fences for its registered language. */
export type FenceBlock = (props: { raw: string }) => ReactElement | null;

export const fenceBlocks: Record<string, FenceBlock> = {
  chart: ({ raw }) => <Chart spec={raw} />,
};
