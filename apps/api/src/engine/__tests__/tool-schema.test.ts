import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestServices } from '../../testing.js';
import type { ToolDef } from '../tools/define.js';
import { toolInputSchema } from '../tools/schema.js';

let builtinTools: () => readonly ToolDef[];
// Capture the app's actual registry without starting an engine or requiring a database.
vi.mock('../engine.js', () => ({
  createEngine: ({ tools }: { tools: (engine: never) => readonly ToolDef[] }) => {
    builtinTools = () => tools({} as never);
    return {};
  },
}));

function definitions() {
  createTestServices();
  return builtinTools();
}

describe('provider tool inputs', () => {
  it('registers human step summaries for every engine tool', () => {
    for (const def of definitions()) expect(def.summarize, def.name).toBeTypeOf('function');
  });

  it('offers every built-in as a root object without union combinators', async () => {
    const defs = definitions();
    expect(defs.length).toBeGreaterThan(15);
    for (const def of defs) {
      const schema = await toolInputSchema(def.input).jsonSchema;
      expect(schema, def.name).toMatchObject({ type: 'object', properties: expect.any(Object) });
      for (const keyword of ['anyOf', 'oneOf', 'allOf']) expect(schema, def.name).not.toHaveProperty(keyword);
      expect(JSON.stringify(schema), def.name).not.toContain('"type":null');
    }
  });

  it('keeps action enums, field constraints and original validation including defaults', async () => {
    const memory = definitions().find((def) => def.name === 'memory')!;
    const schema = toolInputSchema(memory.input);
    expect(await schema.jsonSchema).toMatchObject({
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['remember', 'recall', 'update', 'forget'] },
        category: { default: 'fact' },
      },
    });
    expect(await schema.validate!({ action: 'remember', title: 'Tea' })).toMatchObject({
      success: true,
      value: { action: 'remember', title: 'Tea', content: '', category: 'fact' },
    });
    for (const invalid of [
      { action: 'remember' },
      { action: 'recall', title: 'Tea' },
      { action: 'forget', query: 'Tea' },
      { action: 'invented' },
      { action: 'remember', title: 'x'.repeat(121) },
    ])
      expect(await schema.validate!(invalid)).toMatchObject({ success: false });
  });

  it('preserves different constraints on shared fields and rejects non-object inputs', async () => {
    const input = z.union([z.object({ value: z.string() }), z.object({ value: z.number() })]);
    const schema = toolInputSchema(input);
    expect(await schema.jsonSchema).toMatchObject({ properties: { value: { anyOf: expect.any(Array) } } });
    expect(await schema.validate!({ value: true })).toMatchObject({ success: false });
    const mixed = toolInputSchema(z.union([z.object({ value: z.literal('a') }), z.object({ value: z.literal(1) })]));
    expect(await mixed.jsonSchema).toMatchObject({ properties: { value: { anyOf: expect.any(Array) } } });
    const knowledge = definitions().find((def) => def.name === 'knowledge_mutation')!;
    const knowledgeSchema = await toolInputSchema(knowledge.input).jsonSchema;
    expect(JSON.stringify(knowledgeSchema.properties?.space)).toContain('your own private reference folder');
    await expect(toolInputSchema(z.string()).jsonSchema).rejects.toThrow('Tool inputs must be objects');
  });
});
