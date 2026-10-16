import { jsonSchema, zodSchema, type JSONSchema7 } from 'ai';
import type { z } from 'zod';

type ObjectSchema = JSONSchema7 & {
  properties?: Record<string, JSONSchema7>;
  anyOf?: ObjectSchema[];
  oneOf?: ObjectSchema[];
};

/** Providers require an object at the root; Zod still validates each action's exact input. */
export function toolInputSchema<I>(input: z.ZodType<I>) {
  const original = zodSchema(input);
  return jsonSchema<I>(
    async () => {
      const schema = (await original.jsonSchema) as ObjectSchema;
      if (schema.allOf) throw new Error('Tool inputs must not have a root intersection.');
      const branches = (schema.anyOf ?? schema.oneOf) as ObjectSchema[] | undefined;
      if (!branches) {
        if (schema.type !== 'object' || !schema.properties) throw new Error('Tool inputs must be objects.');
        return schema;
      }
      if (branches.some((branch) => branch.type !== 'object' || !branch.properties)) {
        throw new Error('Tool input unions must contain only objects.');
      }
      const fields = new Map<string, JSONSchema7[]>();
      for (const branch of branches) {
        for (const [name, property] of Object.entries(branch.properties!)) {
          const variants = fields.get(name) ?? [];
          if (!variants.some((variant) => JSON.stringify(variant) === JSON.stringify(property)))
            variants.push(property);
          fields.set(name, variants);
        }
      }
      const properties = Object.fromEntries(
        [...fields].map(([name, variants]) => {
          if (variants.length === 1) return [name, variants[0]];
          if (
            variants.every(
              (variant) =>
                variant.type === variants[0]!.type && (variant.const !== undefined || Array.isArray(variant.enum)),
            )
          ) {
            return [
              name,
              {
                type: variants[0]!.type,
                enum: [...new Set(variants.flatMap((v) => v.enum ?? [v.const]))],
                description: [...new Set(variants.map((variant) => variant.description).filter(Boolean))].join('\n'),
              },
            ];
          }
          return [name, { anyOf: variants }];
        }),
      );
      const required = (branches[0]!.required ?? []).filter((name) =>
        branches.every((branch) => branch.required?.includes(name)),
      );
      const { anyOf: _anyOf, oneOf: _oneOf, ...metadata } = schema;
      const variants = branches.map((branch) => {
        const selectors = Object.entries(branch.properties!)
          .filter(([, property]) => property.const !== undefined || property.enum)
          .map(([name, property]) => `${name}=${(property.enum ?? [property.const]).join('|')}`);
        return `${selectors.join(', ') || 'variant'} requires: ${(branch.required ?? []).join(', ') || 'none'}`;
      });
      return {
        ...metadata,
        type: 'object',
        properties,
        required,
        additionalProperties: false,
        description: [schema.description, ...variants].filter(Boolean).join('\n'),
      } as JSONSchema7;
    },
    {
      validate: async (value) => {
        const result = await input.safeParseAsync(value);
        return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
      },
    },
  );
}
