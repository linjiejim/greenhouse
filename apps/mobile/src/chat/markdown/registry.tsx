/**
 * Fenced-block registry — the one place to extend the renderer. Map a fence
 * language (```<lang>) to a component and it renders automatically: the parser
 * (./parse) and the root (./index) need no edits. Each block validates its own
 * body (the Rich Output fences through the vendored shared parser, ./rich) and
 * owns its fallback — a malformed block degrades to a plain code block rather
 * than breaking the message; the root adds a per-block error boundary and, while
 * a reply streams, a placeholder for a fence that hasn't closed yet.
 *
 * Covers every Rich Output fence the agents are told to write (the web set):
 * chart, datatable, mermaid, html-preview, confirm, mission-artifacts — and
 * the turn-input fences (`attachments`, legacy `mission-attachments`), which
 * belong on the user's bubble and render nothing in a reply (web parity).
 */
import type { ReactElement } from 'react';
import { Chart } from './blocks/chart';
import { ConfirmBlock } from './blocks/confirm';
import { DataTableBlock } from './blocks/datatable';
import { MissionArtifactsBlock } from './blocks/files';
import { HtmlPreviewBlock } from './blocks/html-preview';
import { MermaidBlock } from './blocks/mermaid';
import type { RichFence } from '../../shared/rich-output';

/** Renders the raw body between the ``` fences for its registered language. */
export type FenceBlock = (props: { raw: string }) => ReactElement | null;

/**
 * One renderer per registered fence (plus the historical alias). `satisfies`
 * makes a block added to the shared registry fail to compile here until it has
 * a renderer — MOBILE_RICH_BLOCKS (./rich) declares every model-authored one.
 */
const REGISTRY = {
  chart: ({ raw }) => <Chart spec={raw} />,
  datatable: ({ raw }) => <DataTableBlock raw={raw} />,
  mermaid: ({ raw }) => <MermaidBlock raw={raw} />,
  'html-preview': ({ raw }) => <HtmlPreviewBlock raw={raw} />,
  confirm: ({ raw }) => <ConfirmBlock raw={raw} />,
  'mission-artifacts': ({ raw }) => <MissionArtifactsBlock raw={raw} />,
  attachments: () => null,
  'mission-attachments': () => null,
} satisfies Record<RichFence | 'mission-attachments', FenceBlock>;

export const fenceBlocks: Record<string, FenceBlock> = REGISTRY;
