/**
 * A tool is one file: what the model sees (name, description, input schema), how risky it is,
 * when it exists, and what it does. HTTP routes and tools call the same services.
 */

import type { z } from 'zod';
import type { AgentManifest, MemberModules } from '@greenhouse/contract';
import type { Agent, Conversation, MessageCitation, NeedsYouRequest, RequestKind } from '@greenhouse/db';
import type { Capability } from '@greenhouse/providers';

export type ToolRisk = 'read' | 'write' | 'external';
export type CallRisk = 'read' | 'tier1' | 'tier2' | 'tier3';
export interface ApprovalScope {
  type: 'folder' | 'table';
  id: string;
  actions: string[];
}
/** `turn`: a reply someone is waiting for. `background`: a run nobody watches. */
export type Surface = 'turn' | 'background';

export interface AvailabilityContext {
  runKind?: 'turn' | 'background';
  memberId: string;
  modules: MemberModules;
  manifest: AgentManifest;
  surface: Surface;
  /** Set in a turn of someone else's public Agent: what its publication grants the asker. */
  publicAgent: { computer: boolean } | null;
  backgroundComputer?: boolean;
  /** Whether the member can use a provider capability right now. */
  available(capability: Capability): Promise<boolean>;
}

/** A card a tool raises for the member. */
export interface Card {
  kind: RequestKind;
  subject: string;
  title: string;
  payload: Record<string, unknown>;
  /** The turn ends after this step and the Agent is woken with the outcome. */
  waits: boolean;
  expiresInMs?: number;
}

export interface ToolContext {
  /** Whose rights the tool acts with. */
  memberId: string;
  agent: Agent;
  manifest: AgentManifest;
  conversation: Conversation | null;
  runId: string;
  stepId: string;
  /** Which attempt of the run this is; background runs can be retried. */
  attempt?: number;
  locale: 'zh' | 'en';
  surface: Surface;
  signal: AbortSignal;
  backgroundComputer?: boolean;
  eventWoken?: boolean;
  /** The turn has read outside text (a page, another Agent, a file): some writes get stricter. */
  taint(): void;
  tainted(): boolean;
  /** Raises a card in this conversation for the member. */
  raise(card: Card): Promise<NeedsYouRequest>;
  /**
   * Where a fact came from (engine/sources.ts): `read` shows under the reply, `seen` (a search
   * result) only when the reply links it. Turns that write no reply leave it out.
   */
  cite?(source: MessageCitation, how: 'read' | 'seen'): void;
  /** Ends the turn after this step (a hand-off: the other Agent answers next). */
  endTurn(): void;
  /** The hand-offs this turn's request has gone through, for their limits. */
  chain?: { key: string; path: string[] };
  /** Set when the engine runs a call the member approved on its card. */
  approved?: boolean;
  /** Present when the model sees images: shows it one (a screenshot) with its next step. */
  attachImage?(image: Uint8Array, mediaType: string): void;
}

/** What a decision on a tool's card means for the conversation. */
export interface DecisionOutcome {
  /** One line in the transcript, in the member's language. */
  line: string;
  /** What the Agent is told when it is woken; null leaves it asleep. */
  note: string | null;
}

export interface DecisionContext {
  memberId: string;
  agent: Agent;
  locale: 'zh' | 'en';
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
  /**
   * What the tool adds to the turn's closing message (<turn_context>): a list that changes from
   * turn to turn (the connectors the asker can use, the Agent's skills), so that the description
   * stays fixed and the prompt prefix cacheable. Fence what others wrote. Null adds nothing.
   */
  turnContext?(ctx: AvailabilityContext): Promise<string | null>;
  /**
   * The risk of one call, when it depends on the arguments (a connector tool that only reads).
   * `risk` is the lowest and decides where the tool is offered; a call classed above read waits
   * for the member's approval like a write tool. Class a call above read only when this turn may
   * make it with approval; the tool refuses the rest itself.
   */
  callRisk?(input: I, ctx: Omit<ToolContext, 'stepId' | 'raise' | 'endTurn'>): Promise<CallRisk>;
  approvalScope?(input: I, ctx: ToolContext): Promise<ApprovalScope | null>;
  /** State needed to undo a reversible write, captured before it executes. */
  before?(input: I, ctx: ToolContext): Promise<unknown>;
  /** Holds scope changes still while risk is checked again and a reversible write commits. */
  guard?(input: I, ctx: ToolContext): Promise<void>;
  undo?(input: I, output: unknown, before: unknown, ctx: ToolContext): Promise<void>;
  undoResult?(output: unknown): unknown;
  /** The approval card. */
  describe?(input: I, ctx: ToolContext): ApprovalCard | Promise<ApprovalCard>;
  /** Reading its result brings outside text into the turn. */
  taints?: boolean;
  /**
   * The same call twice does what it does once: a pure read. A call of any other tool that an
   * earlier attempt left unfinished is not made again by itself: its outcome is unknown.
   */
  idempotent?: boolean;
  /** Reads the member's own data (conversations, documents, memories). */
  private?: boolean;
  /** Sends something out of Greenhouse (a search query, a URL). Unwatched runs stop using it after a private read. */
  outbound?: boolean;
  /**
   * Offered in a turn of someone else's public Agent (default: not). Only tools that act on the
   * asker's own data or this conversation, with the asker's rights, may say yes.
   */
  publicAgent?: boolean;
  execute(input: I, ctx: ToolContext): Promise<unknown>;
  /** Applies the member's decision on a card this tool raised (proposals, questions). */
  decide?(request: NeedsYouRequest, ctx: DecisionContext): Promise<DecisionOutcome>;
  /** One line for the steps under a reply. */
  summarize?(input: I, output: unknown, locale: 'zh' | 'en'): string;
}

export function defineTool<I>(def: ToolDef<I>): ToolDef<I> {
  return {
    ...def,
    callRisk:
      def.callRisk ?? (async () => (def.risk === 'read' ? 'read' : def.risk === 'external' ? 'tier3' : 'tier2')),
  };
}

export const surfacesOf = (def: ToolDef): readonly Surface[] =>
  def.surfaces ?? (def.risk === 'read' ? ['turn', 'background'] : ['turn']);
