/**
 * Bots engine — the provider seams (swappable in tests).
 *
 * Everything that talks to a model goes through here, so engine tests can run
 * the real floor controller, tools, persistence and projection against a
 * scripted model (`ai/test` MockLanguageModelV4 through `streamText`), with no
 * provider and no network.
 */

import { generateText } from 'ai';
import { createChatStreamAsync, createModelFromConfig, type ChatEngineInput } from '@greenhouse/agent-core';
import { getDb } from '@greenhouse/db';
import { resolveProfileAsync, type AgentProfile } from '../../profiles/profile.js';
import { createProviderAttemptBudgetHook } from '../../llm/usage-budget.js';

export interface SummarizeInput {
  userId: string;
  sessionId: string;
  system: string;
  prompt: string;
  model: AgentProfile['model'];
}

export interface BotsEngineDeps {
  createStream: (input: ChatEngineInput) => ReturnType<typeof createChatStreamAsync>;
  resolveProfile: (id: string) => Promise<AgentProfile>;
  /** One budgeted, tool-less completion for the rolling digest. Returns the raw text. */
  summarize: (input: SummarizeInput) => Promise<string>;
}

async function summarizeWithModel(input: SummarizeInput): Promise<string> {
  const hook = createProviderAttemptBudgetHook({
    db: getDb(),
    userId: input.userId,
    caller: 'bots-digest',
    profileId: 'sprouty',
    sessionId: input.sessionId,
    runId: input.sessionId,
    metadata: { session_id: input.sessionId },
  });
  const model = await createModelFromConfig(input.model, { onProviderAttempt: hook });
  const result = await generateText({
    model,
    instructions: input.system,
    messages: [{ role: 'user', content: input.prompt }],
    temperature: 0.2,
    // A full digest (6 goals, 20 decisions, 30 facts, 15 + 15 items) is several
    // thousand tokens of JSON; a cut-off answer could never validate.
    maxOutputTokens: 8000,
    maxRetries: 1,
    // A structured rewrite, not a reasoning task: thinking only burns budget here.
    providerOptions: { deepseek: { thinking: { type: 'disabled' } } },
  });
  if (result.finishReason === 'length') throw new Error('digest answer was cut off at the output limit');
  return result.text;
}

const defaults: BotsEngineDeps = {
  createStream: (input) => createChatStreamAsync(input),
  resolveProfile: (id) => resolveProfileAsync(id),
  summarize: summarizeWithModel,
};

let current: BotsEngineDeps = defaults;

export function botsEngineDeps(): BotsEngineDeps {
  return current;
}

/** Tests only: replace some seams; returns a restore function. */
export function setBotsEngineDepsForTest(partial: Partial<BotsEngineDeps>): () => void {
  const previous = current;
  current = { ...current, ...partial };
  return () => {
    current = previous;
  };
}
