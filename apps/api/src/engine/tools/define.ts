/**
 * A tool is one file: what the model sees (name, description, input schema), how risky it is,
 * when it exists, and what it does. HTTP routes and tools call the same services.
 */

import type { z } from 'zod';
import type { AgentManifest, MemberModules } from '@greenhouse/contract';
import type { Agent, Conversation } from '@greenhouse/db';
import type { Capability } from '@greenhouse/providers';

export type ToolRisk = 'read' | 'write' | 'external';
/** `turn`: a reply someone is waiting for. `background`: a run nobody watches. */
export type Surface = 'turn' | 'background';

export interface AvailabilityContext {
  memberId: string;
  modules: MemberModules;
  manifest: AgentManifest;
  surface: Surface;
  /** Whether the member can use a provider capability right now. */
  available(capability: Capability): Promise<boolean>;
}

export interface ToolContext {
  /** Whose rights the tool acts with. */
  memberId: string;
  agent: Agent;
  manifest: AgentManifest;
  conversation: Conversation | null;
  runId: string;
  stepId: string;
  locale: 'zh' | 'en';
  surface: Surface;
  signal: AbortSignal;
  /** The turn has read outside text (a page, another Agent, a file): some writes get stricter. */
  taint(): void;
  tainted(): boolean;
}

export interface ApprovalCard {
  /** What will happen, as a short phrase in the member's language: 修改知识库, edit the knowledge base. */
  summary: string;
  details: { label: string; value: string }[];
}

export interface ToolDef<I = any> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  risk: ToolRisk;
  /** Default: read tools everywhere, write and external tools only in turns. */
  surfaces?: readonly Surface[];
  /** Hidden unless this holds: a module the member has, a provider that is configured. */
  available?(ctx: AvailabilityContext): boolean | Promise<boolean>;
  /** Write and external tools wait for the member's approval unless this returns false. */
  needsApproval?(input: I, ctx: ToolContext): boolean;
  /** The approval card. */
  describe?(input: I, ctx: ToolContext): ApprovalCard;
  /** Reading its result brings outside text into the turn. */
  taints?: boolean;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
  /** One line for the steps under a reply. */
  summarize?(input: I, output: unknown, locale: 'zh' | 'en'): string;
}

export function defineTool<I>(def: ToolDef<I>): ToolDef<I> {
  return def;
}

export const surfacesOf = (def: ToolDef): readonly Surface[] =>
  def.surfaces ?? (def.risk === 'read' ? ['turn', 'background'] : ['turn']);
