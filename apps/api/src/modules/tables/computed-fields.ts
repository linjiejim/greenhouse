/**
 * Settings of computed fields (TBL-02), checked when a field is saved: a formula is parsed
 * against its table's fields (tables-formula.ts) and kept as its expression; a lookup or rollup
 * names a link field of its table and a field of the table that links to; an AI field's prompt
 * names the fields it reads. What each reads goes in base_field_deps, and a field that would read
 * itself, directly or through others, is refused. The API answers with names written back in.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  AI_PROMPT_MAX,
  MAX_AI_INPUTS,
  ROLLUP_AGGREGATES,
  formatFormula,
  formulaExpressionSchema,
  formulaFieldRef,
  formulaResultOf,
  formulaTypeOf,
  formulaFields,
  isLinkType,
  parseFormula,
  type FieldConfig,
  type FieldType,
  type FormulaExpression,
  type FormulaField,
  type RollupAggregate,
} from '@greenhouse/contract';
import { baseFieldDeps, baseFields, getDb, type BaseFieldConfig, type BaseFieldRow } from '@greenhouse/db';
import { ApiError, conflict, invalidInput } from '../../http/errors.js';
import { fieldsOf } from './load.js';

export type DepKind = 'same' | 'link' | 'target';
export interface Dep {
  on: string;
  kind: DepKind;
}

export interface PreparedComputed {
  config: BaseFieldConfig;
  deps: Dep[];
}

/** A stored expression, or null when it cannot be read (a field saved by an older build). */
export function expressionOf(config: Pick<BaseFieldConfig, 'formula'>): FormulaExpression | null {
  const parsed = formulaExpressionSchema.safeParse(config.formula);
  return parsed.success ? parsed.data : null;
}

export const formulaFieldOf = (field: Pick<BaseFieldRow, 'id' | 'name' | 'type' | 'config'>): FormulaField => ({
  id: field.id,
  name: field.name,
  type: formulaTypeOf({ type: field.type, config: { result: field.config.result } }),
});

/** `{#id}` and `{Name}` references in an AI prompt. */
const REF = /\{((?:\\.|[^\\{}])*)\}/g;
const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

/** A prompt with `{Name}` (or `{#id}`) references, kept with `{#id}`; the fields it reads. */
function preparePrompt(prompt: string, fields: readonly BaseFieldRow[]): { prompt: string; inputs: string[] } {
  const inputs: string[] = [];
  const stored = prompt.replace(REF, (_whole, inner: string) => {
    const name = unescape(inner).trim();
    const byId = /^#(.+)$/.exec(name);
    const exact = fields.filter((field) => (byId ? field.id === byId[1] : field.name === name));
    const loose = exact.length ? exact : fields.filter((field) => field.name.toLowerCase() === name.toLowerCase());
    if (loose.length !== 1) {
      throw new ApiError(400, 'invalid_prompt', `The prompt names a field this table does not have: {${name}}.`, {
        name,
      });
    }
    const field = loose[0]!;
    if (!inputs.includes(field.id)) inputs.push(field.id);
    return `{#${field.id}}`;
  });
  if (inputs.length > MAX_AI_INPUTS) {
    throw invalidInput(`An AI field reads at most ${MAX_AI_INPUTS} fields.`, { field: 'prompt' });
  }
  return { prompt: stored, inputs };
}

/** A stored prompt with today's names (`{#id}` for a field that is gone). */
export function promptText(prompt: string, fields: ReadonlyArray<Pick<BaseFieldRow, 'id' | 'name'>>): string {
  return prompt.replace(/\{#([^{}]+)\}/g, (whole, id: string) => {
    const field = fields.find((entry) => entry.id === id);
    return field ? formulaFieldRef(field.name) : whole;
  });
}

/** The stored settings as the API shows them: the formula's text and the prompt with names. */
export function presentConfig(
  field: Pick<BaseFieldRow, 'type' | 'config'>,
  fields?: ReadonlyArray<Pick<BaseFieldRow, 'id' | 'name'>>,
): FieldConfig {
  const config = field.config as FieldConfig & { formula?: unknown };
  if (field.type === 'formula') {
    const { formula: _formula, ...rest } = config;
    const expression = expressionOf(field.config);
    return { ...rest, ...(expression && fields ? { formula_text: formatFormula(expression, fields) } : {}) };
  }
  if (field.type === 'ai' && fields && config.prompt) return { ...config, prompt: promptText(config.prompt, fields) };
  return config;
}

/** What a rollup's value is: a count or sum is a number; MIN and MAX keep the kind they read. */
function rollupResult(aggregate: RollupAggregate, target: BaseFieldRow | undefined): BaseFieldConfig['result'] {
  switch (aggregate) {
    case 'min':
    case 'max': {
      const kind = target ? formulaTypeOf({ type: target.type, config: { result: target.config.result } }) : 'number';
      return kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime' : 'number';
    }
    case 'join':
      return 'text';
    default:
      return 'number';
  }
}

const precisionOf = (config: FieldConfig) =>
  config.precision === undefined ? {} : { precision: Math.max(0, Math.min(6, Math.round(config.precision))) };

/**
 * A computed field's settings checked and made ready to store, with what it reads. `existing` is
 * the field being changed (its own settings fill in what the change leaves out).
 */
export async function prepareComputed(
  table: { id: string; baseId: string },
  type: FieldType,
  input: FieldConfig,
  existing?: BaseFieldRow,
): Promise<PreparedComputed> {
  const fields = (await fieldsOf(table.id)).filter((field) => field.id !== existing?.id);
  const before = existing?.type === type ? existing.config : {};
  switch (type) {
    case 'formula': {
      const text =
        input.formula_text ??
        (() => {
          const expression = expressionOf(before);
          return expression ? formatFormula(expression, fields) : '';
        })();
      const parsed = parseFormula(text, fields.map(formulaFieldOf));
      if (!parsed.ok) {
        throw new ApiError(400, 'invalid_formula', parsed.error.message, {
          code: parsed.error.code,
          start: parsed.error.start,
          end: parsed.error.end,
          ...(parsed.error.params ? { params: parsed.error.params } : {}),
        });
      }
      const inferred = ['unknown', 'null', 'list'].includes(parsed.type) ? null : formulaResultOf(parsed.type);
      const result = inferred ?? input.result ?? (before.result as FieldConfig['result']) ?? 'text';
      return {
        config: {
          formula: parsed.expression,
          result,
          ...(result === 'number' ? precisionOf({ ...before, ...input } as FieldConfig) : {}),
        },
        deps: formulaFields(parsed.expression).map((on) => ({ on, kind: 'same' as const })),
      };
    }
    case 'lookup':
    case 'rollup': {
      const linkId = input.link_field ?? before.link_field;
      const link = fields.find((field) => field.id === linkId);
      if (!link || !isLinkType(link.type)) {
        throw invalidInput('Choose a relation, parent or dependency field of this data table.', {
          field: 'link_field',
        });
      }
      const targetTable = link.type === 'relation' ? link.config.table_id : table.id;
      const aggregate = (input.aggregate ?? before.aggregate ?? (type === 'rollup' ? 'count' : undefined)) as
        | RollupAggregate
        | undefined;
      if (type === 'rollup' && !(ROLLUP_AGGREGATES as readonly string[]).includes(aggregate ?? '')) {
        throw invalidInput('Choose how the values are summed up.', { field: 'aggregate' });
      }
      const targetId = input.target_field ?? before.target_field;
      const needsTarget = type === 'lookup' || aggregate !== 'count';
      let target: BaseFieldRow | undefined;
      if (targetId) {
        [target] = await getDb()
          .select()
          .from(baseFields)
          .where(and(eq(baseFields.id, targetId), sql`${baseFields.archivedAt} IS NULL`));
        if (!target || target.tableId !== targetTable || target.id === existing?.id) {
          throw invalidInput('Choose a field of the data table the link leads to.', { field: 'target_field' });
        }
      } else if (needsTarget) {
        throw invalidInput('Choose the field to read in the linked records.', { field: 'target_field' });
      }
      if (type === 'rollup' && (aggregate === 'sum' || aggregate === 'avg')) {
        const kind = formulaTypeOf({ type: target!.type, config: { result: target!.config.result } });
        if (kind !== 'number') {
          throw invalidInput('SUM and AVERAGE read a number field.', { field: 'target_field' });
        }
      }
      const config: BaseFieldConfig = {
        link_field: link.id,
        ...(target ? { target_field: target.id } : {}),
        ...(type === 'rollup'
          ? {
              aggregate,
              result: rollupResult(aggregate!, target),
              ...(rollupResult(aggregate!, target) === 'number'
                ? precisionOf({ ...before, ...input } as FieldConfig)
                : {}),
            }
          : {}),
      };
      const deps: Dep[] = [{ on: link.id, kind: 'link' }];
      if (target) deps.push({ on: target.id, kind: 'target' });
      return { config, deps };
    }
    case 'ai': {
      const raw = input.prompt ?? (before.prompt ? promptText(before.prompt, fields) : '');
      if (!raw.trim()) throw invalidInput('Write what the AI should fill in.', { field: 'prompt' });
      if (raw.length > AI_PROMPT_MAX) throw invalidInput('The prompt is too long.', { field: 'prompt' });
      const { prompt, inputs } = preparePrompt(raw, fields);
      return {
        config: { prompt, inputs, auto_update: input.auto_update ?? before.auto_update ?? true },
        deps: inputs.map((on) => ({ on, kind: 'same' as const })),
      };
    }
    default:
      throw invalidInput('Not a computed field.');
  }
}

/**
 * Refuses a field that would read itself: through the fields it reads, what they read, and so
 * on, across the base. Run under the field's advisory lock (saveDeps) so two changes cannot
 * close a loop together.
 */
export async function checkNoCycle(baseId: string, fieldId: string, deps: readonly Dep[]): Promise<void> {
  if (deps.some((dep) => dep.on === fieldId)) {
    throw conflict('field_cycle', 'A field cannot read itself.');
  }
  const rows = await getDb().execute<{ field_id: string; depends_on_field_id: string }>(sql`
    SELECT d.field_id, d.depends_on_field_id FROM base_field_deps d
    JOIN base_fields f ON f.id = d.field_id JOIN base_tables t ON t.id = f.table_id
    WHERE t.base_id = ${baseId} AND d.field_id <> ${fieldId}`);
  const reads = new Map<string, string[]>();
  for (const row of rows) reads.set(row.field_id, [...(reads.get(row.field_id) ?? []), row.depends_on_field_id]);
  const seen = new Set<string>();
  const stack = deps.map((dep) => dep.on);
  while (stack.length) {
    const next = stack.pop()!;
    if (next === fieldId) throw conflict('field_cycle', 'These fields would read each other in a circle.');
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(reads.get(next) ?? []));
  }
}

/** Replaces what a field reads (in the caller's transaction, after checkNoCycle). */
export async function saveDeps(fieldId: string, deps: readonly Dep[]): Promise<void> {
  await getDb().delete(baseFieldDeps).where(eq(baseFieldDeps.fieldId, fieldId));
  const unique = new Map(deps.map((dep) => [dep.on, dep]));
  if (unique.size) {
    await getDb()
      .insert(baseFieldDeps)
      .values([...unique.values()].map((dep) => ({ fieldId, dependsOnFieldId: dep.on, kind: dep.kind })));
  }
}

/** Serialises changes that could close a loop of fields in one base (held until the transaction ends). */
export async function lockFieldGraph(baseId: string): Promise<void> {
  await getDb().execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`base_fields:${baseId}`}))`);
}
