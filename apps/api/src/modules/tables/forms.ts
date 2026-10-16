/**
 * Internal forms (TBL-11). A builder lays out some fields of one data table as a form and
 * publishes it; each submission adds one record, written as the submitter and named in its
 * history as the form (actor `form`), plus a submission row.
 *
 * Who may submit: the form's own shares (resource `form`, role `submitter`: members, groups,
 * everyone), or with none, the base's members who may add records to that table (a custom role
 * among them is not asked the fields it does not see). Builders always may, and only they open
 * a draft (a preview that takes nothing). Anyone else finds no such form: its existence stays
 * private.
 *
 * Submitting needs no access to the base. The record is written with the form's own rights (its
 * fields, as an editor would write them), and the submitter sees no record data. A member whose
 * tables module is off still fills in a form shared with them: it shows them nothing of the base.
 * They have no base role there, though, and a link field is asked only of people who can read
 * the table it links to (its records' titles are what they pick from).
 */

import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  formConfigSchema,
  isComputedType,
  isEmptyValue,
  isLinkType,
  MAX_FORMS,
  roleAtLeast,
  type CreateFormInput,
  type FieldConfig,
  type Form,
  type FormConfig,
  type FormField,
  type FormFill,
  type FormFillField,
  type FormReceipt,
  type FormShareInput,
  type FormShares,
  type FormStatus,
  type FormSubmission,
  type FormUpload,
  type Page,
  type RecordValues,
  type UpdateFormInput,
} from '@greenhouse/contract';
import {
  baseFormSubmissions,
  baseForms,
  baseRecords,
  baseTables,
  bases,
  getDb,
  groupMembers,
  groups,
  members,
  newId,
  shares,
  transaction,
  type BaseFieldRow,
  type BaseFormRow,
  type BaseRow,
  type BaseTableRow,
} from '@greenhouse/db';
import { isUniqueViolation } from '@greenhouse/utils/error';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, encodeCursor } from '../../http/pagination.js';
import { inList, principalMatch } from '../knowledge/access.js';
import { memberNames, refOf, shareViews } from '../knowledge/views.js';
import { effectiveModules } from '../members/service.js';
import { loadReader, type TablesReader } from './access.js';
import type { TablesKit } from './kit.js';
import { configOfField, fieldsOf, tableAt, titlesOf, type TableAt } from './load.js';
import { scopeOf } from './scope.js';

/** A member as forms see them: tables' own reader, and whether their tables module is on. */
interface Person {
  reader: TablesReader;
  tables: boolean;
}

/** A form someone may fill in now, with what it belongs to. */
interface Filling {
  form: BaseFormRow;
  base: BaseRow;
  table: BaseTableRow;
  person: Person;
  /** They build the base: a draft opens for them as a preview. */
  builder: boolean;
  /**
   * Fields they may be asked, when the form reaches them only as the table's editors through a
   * custom role: a form never widens a member's own role. Null: every field of the form.
   */
  within: ReadonlySet<string> | null;
}

/** A field of the form as one person is asked it. */
interface Asked {
  field: BaseFieldRow;
  label: string;
  help: string;
  required: boolean;
}

const closed = () => new ApiError(409, 'form_closed', 'This form is not taking submissions.');
const alreadySubmitted = () => new ApiError(409, 'already_submitted', 'You have already submitted this form.');

/** Not allowed, or not there: either way the form is not found. */
const asFormMissing = (error: unknown) =>
  error instanceof ApiError && (error.status === 403 || error.status === 404) ? notFound('Form') : error;

/** Configs are stored only after cleanConfig checked them; one that no longer reads asks nothing. */
function configOf(row: Pick<BaseFormRow, 'config'>): FormConfig {
  const parsed = formConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : { fields: [] };
}

/** Fields a person can fill in: everything but computed ones. */
const fillable = (fields: readonly BaseFieldRow[]) => fields.filter((field) => !isComputedType(field.type));

/**
 * A form's settings checked against its table's live fields: fields that can be filled in, each
 * once, then every field the table requires (a record without it could not be written).
 */
function cleanConfig(live: readonly BaseFieldRow[], input: FormConfig): FormConfig {
  const byId = new Map(live.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const fields: FormField[] = [];
  for (const item of input.fields) {
    const field = byId.get(item.field_id);
    if (!field) throw invalidInput('Some fields are not in this table.', { field: item.field_id });
    if (isComputedType(field.type)) {
      throw invalidInput(`「${field.name}」 is worked out by the table and cannot be filled in.`, { field: field.id });
    }
    if (seen.has(field.id)) throw invalidInput(`「${field.name}」 is in the form twice.`, { field: field.id });
    seen.add(field.id);
    fields.push({
      field_id: field.id,
      ...(item.label ? { label: item.label } : {}),
      ...(item.help ? { help: item.help } : {}),
      ...(item.required ? { required: true } : {}),
    });
  }
  for (const field of fillable(live)) if (field.required && !seen.has(field.id)) fields.push({ field_id: field.id });
  return {
    fields,
    ...(input.submit_label ? { submit_label: input.submit_label } : {}),
    ...(input.success_message ? { success_message: input.success_message } : {}),
    ...(input.single_submit ? { single_submit: true } : {}),
  };
}

/** A new form asks for every field a person fills in, but not parents and dependencies: those shape the table. */
const defaultConfig = (live: readonly BaseFieldRow[]): FormConfig => ({
  fields: fillable(live)
    .filter((field) => field.type !== 'parent' && field.type !== 'dependency')
    .map((field) => ({ field_id: field.id })),
});

const toForm = (row: BaseFormRow, live: readonly BaseFieldRow[], count: number): Form => {
  const config = configOf(row);
  // A field in the recycle bin leaves the form until it comes back.
  const ids = new Set(fillable(live).map((field) => field.id));
  return {
    id: row.id,
    base_id: row.baseId,
    table_id: row.tableId,
    name: row.name,
    description: row.description,
    status: row.status,
    config: { ...config, fields: config.fields.filter((item) => ids.has(item.field_id)) },
    revision: row.revision,
    submission_count: count,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
};

/** Of a field's settings, only what filling it in needs. */
function fillConfig(field: BaseFieldRow): FieldConfig {
  const config = configOfField(field);
  switch (field.type) {
    case 'single_select':
    case 'multi_select':
      return { options: config.options ?? [] };
    case 'number':
      return {
        ...(config.precision === undefined ? {} : { precision: config.precision }),
        ...(config.currency ? { currency: config.currency } : {}),
      };
    case 'member':
      return { multiple: config.multiple === true };
    case 'relation':
      return { ...(config.table_id ? { table_id: config.table_id } : {}), multiple: config.multiple !== false };
    default:
      return {};
  }
}

const toFillField = (entry: Asked): FormFillField => ({
  id: entry.field.id,
  table_id: entry.field.tableId,
  name: entry.label,
  help: entry.help,
  type: entry.field.type,
  required: entry.required,
  config: fillConfig(entry.field),
});

/** loadReader without refusing a member whose tables module is off. */
async function personOf(memberId: string): Promise<Person> {
  const [member] = await getDb()
    .select({ name: members.name, locale: members.locale, timezone: members.timezone, modules: members.modules })
    .from(members)
    .where(eq(members.id, memberId));
  if (!member) throw notFound('Form');
  const groupIds = (
    await getDb().select({ id: groupMembers.groupId }).from(groupMembers).where(eq(groupMembers.memberId, memberId))
  ).map((row) => row.id);
  return {
    reader: {
      memberId,
      name: member.name,
      locale: member.locale === 'en' ? 'en' : 'zh',
      timeZone: member.timezone || 'Asia/Shanghai',
      groupIds,
    },
    tables: effectiveModules(member.modules).tables,
  };
}

/** The person's own access to a data table, when their tables module is on and they reach it. */
async function ownAccess(person: Person, tableId: string): Promise<TableAt | null> {
  if (!person.tables) return null;
  return tableAt(person.reader, tableId, 'viewer').catch((error: unknown) => {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null;
    throw error;
  });
}

async function hasSubmitted(formId: string, memberId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: baseFormSubmissions.id })
    .from(baseFormSubmissions)
    .where(and(eq(baseFormSubmissions.formId, formId), eq(baseFormSubmissions.memberId, memberId)))
    .limit(1);
  return !!row;
}

async function countsOf(formIds: readonly string[]): Promise<Map<string, number>> {
  if (!formIds.length) return new Map();
  const rows = await getDb()
    .select({ id: baseFormSubmissions.formId, n: sql<number>`count(*)::int` })
    .from(baseFormSubmissions)
    .where(inArray(baseFormSubmissions.formId, [...formIds]))
    .groupBy(baseFormSubmissions.formId);
  return new Map(rows.map((row) => [row.id, row.n]));
}

async function sharesOf(formId: string): Promise<FormShares> {
  const rows = await getDb()
    .select()
    .from(shares)
    .where(and(eq(shares.resourceType, 'form'), eq(shares.resourceId, formId)))
    .orderBy(asc(shares.createdAt), asc(shares.id));
  const views = await shareViews(rows);
  return { items: views.map(({ type, id, name }) => ({ type, id, name })) };
}

export function createForms(kit: TablesKit) {
  /** A form of a base the reader builds; for anyone else there is no such form. */
  async function built(reader: TablesReader, formId: string) {
    const [form] = await getDb().select().from(baseForms).where(eq(baseForms.id, formId));
    if (!form) throw notFound('Form');
    const at = await tableAt(reader, form.tableId, 'viewer').catch((error: unknown) => {
      throw asFormMissing(error);
    });
    if (!roleAtLeast(at.role, 'builder')) throw notFound('Form');
    return { form, at };
  }

  /**
   * A form the member may fill in now: published, or a draft for its builders. Anyone who may
   * not submit finds no form; someone who may, finds a draft closed.
   */
  async function filling(memberId: string, formId: string): Promise<Filling> {
    const [row] = await getDb()
      .select({ form: baseForms, base: bases, table: baseTables })
      .from(baseForms)
      .innerJoin(bases, eq(bases.id, baseForms.baseId))
      .innerJoin(baseTables, eq(baseTables.id, baseForms.tableId))
      .where(eq(baseForms.id, formId));
    // A form of an archived base or data table takes nothing until that is restored.
    if (!row || row.base.archivedAt || row.table.archivedAt) throw notFound('Form');
    const person = await personOf(memberId);
    const own = await ownAccess(person, row.table.id);
    const builder = !!own && roleAtLeast(own.role, 'builder');
    const granted = await getDb()
      .select({ mine: sql<boolean>`${principalMatch(person.reader)}` })
      .from(shares)
      .where(and(eq(shares.resourceType, 'form'), eq(shares.resourceId, formId)));
    // With no shares of its own, a form is for those who may add records to its table.
    const scope = !builder && !granted.length && own ? await scopeOf(person.reader, own) : null;
    const may = builder || (granted.length ? granted.some((share) => share.mine) : !!scope?.canEdit);
    if (!may) throw notFound('Form');
    if (row.form.status !== 'published' && !builder) throw closed();
    const within = scope?.limited ? new Set(scope.fields.map((field) => field.id)) : null;
    return { ...row, person, builder, within };
  }

  /**
   * What one person is asked: the form's fields still in the table, then any field the table
   * requires that the form lacks (it became required later); links only to tables they read.
   */
  async function askedOf(at: Filling): Promise<Asked[]> {
    const live = fillable(await fieldsOf(at.table.id)).filter((field) => !at.within || at.within.has(field.id));
    const byId = new Map(live.map((field) => [field.id, field]));
    const asked: Asked[] = [];
    const seen = new Set<string>();
    for (const item of configOf(at.form).fields) {
      const field = byId.get(item.field_id);
      if (!field || seen.has(field.id)) continue;
      seen.add(field.id);
      asked.push({
        field,
        label: item.label || field.name,
        help: item.help ?? '',
        required: item.required === true || field.required,
      });
    }
    for (const field of live) {
      if (field.required && !seen.has(field.id)) asked.push({ field, label: field.name, help: '', required: true });
    }
    const reads = new Map<string, Promise<boolean>>();
    const canRead = (tableId: string) => {
      if (!reads.has(tableId))
        reads.set(
          tableId,
          ownAccess(at.person, tableId).then((found) => !!found),
        );
      return reads.get(tableId)!;
    };
    const kept: Asked[] = [];
    for (const entry of asked) {
      if (isLinkType(entry.field.type)) {
        const target = entry.field.type === 'relation' ? configOfField(entry.field).table_id : entry.field.tableId;
        if (!target || !(await canRead(target))) continue;
      }
      kept.push(entry);
    }
    return kept;
  }

  async function setStatus(memberId: string, formId: string, status: FormStatus): Promise<Form> {
    const reader = await loadReader(memberId);
    const { form, at } = await built(reader, formId);
    const live = await fieldsOf(at.table.id);
    if (status === 'published') {
      const ids = new Set(fillable(live).map((field) => field.id));
      if (!configOf(form).fields.some((item) => ids.has(item.field_id))) {
        throw invalidInput('Add a field to the form before publishing it.');
      }
    }
    const [row] = await getDb()
      .update(baseForms)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(baseForms.id, formId))
      .returning();
    await kit.baseChanged(at.base);
    return toForm(row!, live, (await countsOf([formId])).get(formId) ?? 0);
  }

  return {
    // ── Building (builders) ─────────────────────────────

    async list(memberId: string, tableId: string): Promise<{ items: Form[] }> {
      const reader = await loadReader(memberId);
      await tableAt(reader, tableId, 'builder');
      const [rows, live] = await Promise.all([
        getDb()
          .select()
          .from(baseForms)
          .where(eq(baseForms.tableId, tableId))
          .orderBy(asc(baseForms.createdAt), asc(baseForms.id)),
        fieldsOf(tableId),
      ]);
      const counts = await countsOf(rows.map((row) => row.id));
      return { items: rows.map((row) => toForm(row, live, counts.get(row.id) ?? 0)) };
    },

    /** A draft; without settings it asks for the table's fields. */
    async create(memberId: string, tableId: string, input: CreateFormInput): Promise<Form> {
      const reader = await loadReader(memberId);
      const at = await tableAt(reader, tableId, 'builder');
      const live = await fieldsOf(tableId);
      const config = cleanConfig(live, input.config ?? defaultConfig(live));
      const [{ n } = { n: 0 }] = await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(baseForms)
        .where(eq(baseForms.tableId, tableId));
      if (n >= MAX_FORMS) throw conflict('too_many_forms', `A data table can have up to ${MAX_FORMS} forms.`);
      const [row] = await getDb()
        .insert(baseForms)
        .values({
          id: newId('form'),
          baseId: at.base.id,
          tableId,
          name: input.name,
          description: input.description ?? '',
          config,
          createdBy: memberId,
        })
        .returning();
      await kit.baseChanged(at.base);
      return toForm(row!, live, 0);
    },

    async get(memberId: string, formId: string): Promise<Form> {
      const reader = await loadReader(memberId);
      const { form, at } = await built(reader, formId);
      return toForm(form, await fieldsOf(at.table.id), (await countsOf([formId])).get(formId) ?? 0);
    },

    /** A change based on `revision`; a newer form answers 409 `stale_revision` with the form now. */
    async update(memberId: string, formId: string, input: UpdateFormInput): Promise<Form> {
      const reader = await loadReader(memberId);
      const { form, at } = await built(reader, formId);
      const live = await fieldsOf(at.table.id);
      let config: FormConfig | undefined;
      if (input.config) {
        const current = toForm(form, live, 0).config;
        config = cleanConfig(live, { ...current, ...input.config, fields: input.config.fields ?? current.fields });
      }
      const [row] = await getDb()
        .update(baseForms)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(config ? { config } : {}),
          revision: sql`${baseForms.revision} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(baseForms.id, formId), eq(baseForms.revision, input.revision)))
        .returning();
      const count = (await countsOf([formId])).get(formId) ?? 0;
      if (!row) {
        const [now] = await getDb().select().from(baseForms).where(eq(baseForms.id, formId));
        if (!now) throw notFound('Form');
        throw new ApiError(409, 'stale_revision', 'Someone changed this form. Reload it before saving again.', {
          form: toForm(now, live, count),
        });
      }
      await kit.baseChanged(at.base);
      return toForm(row, live, count);
    },

    /** Deletes the form with its submissions and shares; the records it added stay. */
    async remove(memberId: string, formId: string): Promise<void> {
      const reader = await loadReader(memberId);
      const { at } = await built(reader, formId);
      await transaction(async () => {
        await getDb()
          .delete(shares)
          .where(and(eq(shares.resourceType, 'form'), eq(shares.resourceId, formId)));
        await getDb().delete(baseForms).where(eq(baseForms.id, formId));
      });
      await kit.baseChanged(at.base);
    },

    /** Starts taking submissions: it needs at least one field. */
    publish: (memberId: string, formId: string) => setStatus(memberId, formId, 'published'),
    unpublish: (memberId: string, formId: string) => setStatus(memberId, formId, 'draft'),

    async shares(memberId: string, formId: string): Promise<FormShares> {
      const reader = await loadReader(memberId);
      await built(reader, formId);
      return sharesOf(formId);
    },

    /** Replaces who may submit: members, groups or everyone; an empty list leaves it to the table's editors. */
    async share(memberId: string, formId: string, input: FormShareInput): Promise<FormShares> {
      const reader = await loadReader(memberId);
      const { at } = await built(reader, formId);
      const wanted = new Map<string, { type: 'member' | 'group' | 'workspace'; id: string | null }>();
      for (const entry of input.items)
        wanted.set(`${entry.type}:${entry.id ?? ''}`, { type: entry.type, id: entry.id ?? null });
      const memberIds = [...wanted.values()].filter((entry) => entry.type === 'member').map((entry) => entry.id!);
      const groupIds = [...wanted.values()].filter((entry) => entry.type === 'group').map((entry) => entry.id!);
      const [people, teams] = await Promise.all([
        getDb()
          .select({ id: members.id })
          .from(members)
          .where(and(inList(members.id, memberIds), ne(members.status, 'disabled'))),
        getDb().select({ id: groups.id }).from(groups).where(inList(groups.id, groupIds)),
      ]);
      if (people.length !== memberIds.length || teams.length !== groupIds.length) {
        throw invalidInput('Some members or groups do not exist.');
      }
      await transaction(async () => {
        const existing = await getDb()
          .select()
          .from(shares)
          .where(and(eq(shares.resourceType, 'form'), eq(shares.resourceId, formId)));
        const keyOf = (row: { principalType: string; principalId: string | null }) =>
          `${row.principalType}:${row.principalId ?? ''}`;
        const gone = existing.filter((row) => !wanted.has(keyOf(row))).map((row) => row.id);
        if (gone.length) await getDb().delete(shares).where(inArray(shares.id, gone));
        const kept = new Set(existing.map(keyOf));
        const fresh = [...wanted].filter(([key]) => !kept.has(key));
        if (fresh.length) {
          await getDb()
            .insert(shares)
            .values(
              fresh.map(([, entry]) => ({
                id: newId('share'),
                resourceType: 'form' as const,
                resourceId: formId,
                principalType: entry.type,
                principalId: entry.id,
                role: 'submitter',
                createdBy: memberId,
              })),
            );
        }
      });
      await kit.baseChanged(at.base);
      return sharesOf(formId);
    },

    /** Submissions, newest first, for the base's editors who see the whole table. */
    async submissions(
      memberId: string,
      formId: string,
      query: { cursor?: string | undefined; limit: number },
    ): Promise<Page<FormSubmission>> {
      const reader = await loadReader(memberId);
      const [form] = await getDb().select().from(baseForms).where(eq(baseForms.id, formId));
      if (!form) throw notFound('Form');
      const at = await tableAt(reader, form.tableId, 'viewer').catch((error: unknown) => {
        throw asFormMissing(error);
      });
      // A custom role may not see every record listed here.
      if (!roleAtLeast(at.role, 'editor') || (await scopeOf(reader, at)).limited) throw notFound('Form');
      const before = decodeCursor(query.cursor);
      const rows = await getDb()
        .select({
          id: baseFormSubmissions.id,
          memberId: baseFormSubmissions.memberId,
          recordId: baseFormSubmissions.recordId,
          createdAt: baseFormSubmissions.createdAt,
          deletedAt: baseRecords.deletedAt,
        })
        .from(baseFormSubmissions)
        .leftJoin(baseRecords, eq(baseRecords.id, baseFormSubmissions.recordId))
        .where(and(eq(baseFormSubmissions.formId, formId), before ? lt(baseFormSubmissions.id, before) : undefined))
        .orderBy(desc(baseFormSubmissions.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      const page = more ? rows.slice(0, query.limit) : rows;
      const live = (row: (typeof page)[number]) => (row.recordId && !row.deletedAt ? row.recordId : null);
      const [names, titles] = await Promise.all([
        memberNames(page.map((row) => row.memberId)),
        titlesOf(
          at.base.id,
          page.flatMap((row) => live(row) ?? []),
        ),
      ]);
      return {
        items: page.map((row) => {
          const recordId = live(row);
          return {
            id: row.id,
            member: refOf(names, row.memberId),
            created_at: row.createdAt,
            record: recordId ? { id: recordId, title: titles[recordId]?.title ?? '' } : null,
          };
        }),
        next_cursor: more ? encodeCursor(page[page.length - 1]!.id) : null,
      };
    },

    // ── Filling in (who may submit) ─────────────────────

    async fill(memberId: string, formId: string): Promise<FormFill> {
      const at = await filling(memberId, formId);
      const config = configOf(at.form);
      const [asked, submitted] = await Promise.all([askedOf(at), hasSubmitted(formId, memberId)]);
      return {
        id: at.form.id,
        name: at.form.name,
        description: at.form.description,
        status: at.form.status,
        fields: asked.map(toFillField),
        submit_label: config.submit_label ?? '',
        success_message: config.success_message ?? '',
        single_submit: config.single_submit === true,
        submitted,
      };
    },

    /**
     * Checks that the member may upload to the form now, before the route reads the body; the
     * returned function stores one file for its attachment fields, the member's own, in the
     * form's base (a submission naming it attaches it to the record).
     */
    async uploader(memberId: string, formId: string) {
      const at = await filling(memberId, formId);
      if (at.form.status !== 'published') throw closed();
      if (!(await askedOf(at)).some((entry) => entry.field.type === 'attachment')) {
        throw invalidInput('This form takes no files.');
      }
      if (configOf(at.form).single_submit && (await hasSubmitted(formId, memberId))) throw alreadySubmitted();
      return async (file: { name: string; contentType: string; bytes: Uint8Array }): Promise<FormUpload> => {
        const stored = await kit.files.store(memberId, { ...file, purpose: 'record', baseId: at.base.id });
        return {
          id: stored.id,
          name: stored.name,
          content_type: stored.content_type,
          size_bytes: stored.size_bytes,
        };
      };
    },

    /**
     * One record from the form's fields, written as the member with the form's rights, and the
     * submission that names it, in one transaction. Fields outside the form are refused.
     */
    async submit(memberId: string, formId: string, values: RecordValues): Promise<FormReceipt> {
      const at = await filling(memberId, formId);
      // A builder's preview of a draft takes nothing.
      if (at.form.status !== 'published') throw closed();
      const asked = await askedOf(at);
      if (!asked.length) throw invalidInput('This form has nothing for you to fill in.');
      const inForm = new Set(asked.map((entry) => entry.field.id));
      for (const key of Object.keys(values)) {
        if (!inForm.has(key)) throw invalidInput('Some fields are not in this form.', { field: key });
      }
      for (const entry of asked) {
        const value = values[entry.field.id];
        // A required checkbox is one that must be ticked (an agreement).
        const missing = entry.field.type === 'checkbox' ? value !== true : isEmptyValue(value);
        if (entry.required && missing) {
          throw invalidInput(`「${entry.label}」 is required.`, { field: entry.field.id });
        }
      }
      const single = configOf(at.form).single_submit === true;
      if (single && (await hasSubmitted(formId, memberId))) throw alreadySubmitted();
      const writeAt: TableAt = { base: at.base, table: at.table, role: 'editor', access: null, custom: null };
      let made;
      try {
        made = await transaction(async () => {
          const record = await kit.records.insertFrom(writeAt, at.person.reader, values, { type: 'form', id: formId });
          const [submission] = await getDb()
            .insert(baseFormSubmissions)
            .values({ id: newId('formSubmission'), formId, memberId, recordId: record.id, singleSubmit: single })
            .returning();
          return { record, submission: submission! };
        });
      } catch (error) {
        // Two submissions of a single-submit form at once: the partial unique index keeps one.
        if (!(error instanceof ApiError) && isUniqueViolation(error)) throw alreadySubmitted();
        throw error;
      }
      await kit.records.announce(writeAt, [made.record]);
      return { id: made.submission.id, created_at: made.submission.createdAt };
    },

    /**
     * Deletes the shares of the forms of a base or data table. Call it in the transaction that
     * deletes that for good: its forms go with it by cascade, their shares do not.
     */
    async dropShares(of: { baseId: string } | { tableId: string }): Promise<void> {
      const forms = getDb()
        .select({ id: baseForms.id })
        .from(baseForms)
        .where('baseId' in of ? eq(baseForms.baseId, of.baseId) : eq(baseForms.tableId, of.tableId));
      await getDb()
        .delete(shares)
        .where(and(eq(shares.resourceType, 'form'), inArray(shares.resourceId, forms)));
    },
  };
}

export type FormsPart = ReturnType<typeof createForms>;
