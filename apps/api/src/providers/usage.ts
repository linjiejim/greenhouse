/**
 * Every provider call writes one usage_events row (docs/product/providers.md §8). Clients come
 * only from the providers service, which wraps them here, so no call goes unrecorded.
 */

import { getDb, usageEvents } from '@greenhouse/db';
import {
  withAttempts,
  type AttemptHook,
  type Capability,
  type ClientByCapability,
  type ImageClient,
  type LlmClient,
  type SearchClient,
  type SttClient,
  type TtsClient,
} from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

export interface UsageContext {
  /** The member whose rights the call acts with. Absent for system work. */
  memberId?: string;
  agentId?: string;
  runId?: string;
  conversationId?: string;
  /** False for public Agents and runs someone else started: a personal key serves only its owner. */
  personal?: boolean;
}

export interface MeteredInstance {
  id: string;
  capability: Capability;
  source: 'env' | 'workspace' | 'personal' | 'builtin';
  config: Record<string, unknown>;
}

interface Measure {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  quantity?: number;
  unit?: string;
}

export async function recordUsage(instance: MeteredInstance, ctx: UsageContext, measure: Measure): Promise<void> {
  const configured = typeof instance.config.model === 'string' ? instance.config.model : undefined;
  await getDb()
    .insert(usageEvents)
    .values({
      capability: instance.capability,
      providerId: instance.id,
      source: instance.source,
      memberId: ctx.memberId,
      agentId: ctx.agentId,
      runId: ctx.runId,
      conversationId: ctx.conversationId,
      model: measure.model ?? configured,
      inputTokens: measure.inputTokens,
      outputTokens: measure.outputTokens,
      cachedTokens: measure.cachedTokens,
      quantity: measure.quantity,
      unit: measure.unit,
    })
    // The provider already answered; a lost usage row must not lose the answer.
    .catch((error: unknown) => logger.warn('[providers] could not record usage', { error: toErrorMessage(error) }));
}

/** Wraps a client so each call records its usage: tokens for models, a unit count for the rest. */
export function meter<C extends Capability>(
  instance: MeteredInstance,
  client: ClientByCapability[C],
  ctx: UsageContext,
): ClientByCapability[C] {
  const record = (measure: Measure) => recordUsage(instance, ctx, measure);
  switch (instance.capability) {
    case 'llm': {
      const llm = client as LlmClient;
      const hook: AttemptHook = async ({ modelId }) => ({
        started: () => undefined,
        settle: (usage) =>
          record({
            model: modelId,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedTokens: usage.cachedInputTokens,
          }),
      });
      const metered: LlmClient = {
        languageModel: (modelId) => withAttempts(llm.languageModel(modelId), instance.id, hook),
        models: () => llm.models(),
      };
      return metered as ClientByCapability[C];
    }
    case 'search': {
      const search = client as SearchClient;
      const read = search.read?.bind(search);
      const metered: SearchClient = {
        async search(query, options) {
          const results = await search.search(query, options);
          await record({ quantity: 1, unit: 'request' });
          return results;
        },
        ...(read
          ? {
              async read(url: string) {
                const page = await read(url);
                await record({ quantity: 1, unit: 'page' });
                return page;
              },
            }
          : {}),
      };
      return metered as ClientByCapability[C];
    }
    case 'stt': {
      const stt = client as SttClient;
      const metered: SttClient = {
        async transcribe(input) {
          const result = await stt.transcribe(input);
          // Not every vendor reports the audio length; unknown stays unknown rather than 0.
          await record({ quantity: result.durationSeconds, unit: 'second' });
          return result;
        },
      };
      return metered as ClientByCapability[C];
    }
    case 'tts': {
      const tts = client as TtsClient;
      const metered: TtsClient = {
        async synthesize(input) {
          const result = await tts.synthesize(input);
          await record({ quantity: [...input.text].length, unit: 'character' });
          return result;
        },
      };
      return metered as ClientByCapability[C];
    }
    case 'image': {
      const image = client as ImageClient;
      const metered: ImageClient = {
        async generate(input) {
          const result = await image.generate(input);
          await record({ quantity: result.images.length, unit: 'image' });
          return result;
        },
      };
      return metered as ClientByCapability[C];
    }
    default:
      // Storage is measured by the files it holds, not per call.
      return client;
  }
}
