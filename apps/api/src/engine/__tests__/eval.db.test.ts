/** Replay recorded model steps through the current prompt builders, registry, schema and approval gate. */
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getDb, newId, runs } from '@greenhouse/db';
import { runLoop } from '@greenhouse/agent-core';
import { createTestApp } from '../../testing.js';
import { assembleHarness, digest, toolDefinition, type Harness } from '../eval.js';
import { assembleTools } from '../tools/assemble.js';
import { scriptedModel, text, toolCall, systemText } from './model.js';
import type { ModelMessage } from 'ai';

interface Fixture {
  harness: Harness;
  expected: { system: string; tail: string; tools: { name: string; hash: string }[] };
  steps: {
    kind: string;
    tool: string | null;
    input: Record<string, unknown>;
    output: unknown;
    status: string;
    risk: string;
  }[];
}
const folder = resolve('fixtures/eval');
const paths = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();

describe('Eval fixtures', () => {
  it('keeps a real-model regression corpus', () => expect(paths.length).toBeGreaterThanOrEqual(3));
  for (const path of paths)
    it(`replays ${path}`, async () => {
      const fixture = JSON.parse(await readFile(resolve(folder, path), 'utf8')) as Fixture;
      const { harness } = fixture;
      const built = assembleHarness(harness);
      expect(digest(built.system)).toBe(fixture.expected.system);
      expect(digest(built.tail)).toBe(fixture.expected.tail);
      const scripts = fixture.steps
        .filter((step) => step.kind === 'model')
        .map((step) => {
          const assistant = ((step.output as { messages: ModelMessage[] }).messages ?? []).find(
            (message) => message.role === 'assistant',
          );
          if (!assistant) return text('');
          if (typeof assistant.content === 'string') return text(assistant.content);
          return assistant.content
            .flatMap((part) =>
              part.type === 'tool-call'
                ? toolCall(part.toolName, part.input, part.toolCallId)
                : part.type === 'text'
                  ? text(part.text)
                  : [],
            )
            .filter(
              (part, index, all) =>
                !['stream-start', 'finish'].includes(part.type) ||
                (part.type === 'stream-start' ? index === 0 : index === all.length - 1),
            );
        });
      const model = scriptedModel(scripts);
      const app = createTestApp({}, { languageModel: model.languageModel });
      const member = await app.member();
      const main = await app.services.agents.load(member.id, 'main');
      const runId = newId('run');
      await getDb().insert(runs).values({
        id: runId,
        agentId: main.agent.id,
        ownerId: member.id,
        kind: 'turn',
        source: 'conversation',
        status: 'running',
      });
      const calls = fixture.steps.filter((step) => step.kind === 'tool');
      let callIndex = 0;
      const raised: unknown[] = [];
      let tainted = harness.tainted === true;
      const defs = app.services.engine.toolsForEvaluation();
      const toolset = await assembleTools({
        defs: defs.map((def) => ({
          ...def,
          async execute(args, ctx) {
            const expected = calls[callIndex++];
            expect(def.name).toBe(expected?.tool);
            expect(args).toEqual(expected?.input);
            if (def.name === 'ask_user') return def.execute(args, ctx);
            return expected?.output;
          },
        })),
        context: {
          memberId: member.id,
          agent: main.agent,
          manifest: harness.manifest,
          conversation: null,
          runId,
          locale: harness.recipe?.rules.locale ?? harness.background!.locale,
          readOnly: harness.readOnly,
          surface: harness.surface,
          signal: new AbortController().signal,
          taint() {
            tainted = true;
          },
          tainted: () => tainted,
        },
        availability: {
          memberId: member.id,
          manifest: harness.manifest,
          modules: harness.modules,
          surface: harness.surface,
          mainAgent: harness.mainAgent,
          runKind: harness.surface === 'background' ? 'background' : 'turn',
          publicAgent: harness.publicAgent,
          available: async (capability) =>
            new Map(harness.capabilities as [string, boolean][]).get(capability) === true,
        },
        raise: async (card) => {
          raised.push(card);
          return { id: 'fixture-request' } as never;
        },
        approvalTitle: (summary) => summary,
      });
      expect(
        await Promise.all(
          [...toolset.defs.values()].map(async (def) => ({ name: def.name, hash: digest(await toolDefinition(def)) })),
        ),
      ).toEqual(fixture.expected.tools);
      await runLoop({
        model: {
          model: (await model.languageModel()).model,
          modelId: 'scripted',
          deepseek: false,
        },
        instructions: built.system,
        messages: harness.transcript,
        tools: toolset.tools,
        stopWhen: [() => toolset.waiting()],
        maxSteps: Math.max(1, scripts.length + 1),
      });
      expect(systemText(model.prompts[0])).toBe(built.system);
      for (const step of calls.filter((step) => step.status === 'pending' && step.risk !== 'read'))
        expect(raised).toContainEqual(
          expect.objectContaining({ kind: 'approval', payload: expect.objectContaining({ tool: step.tool }) }),
        );
    });
});
