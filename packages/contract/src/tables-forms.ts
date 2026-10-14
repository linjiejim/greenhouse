import { z } from 'zod';
import { AUDIENCE_TYPES } from './agents.js';
import { isoTime } from './common.js';
import { memberRefSchema } from './knowledge.js';
import { FIELD_TYPES, MAX_FIELDS, fieldConfigSchema, recordValuesSchema } from './tables.js';

/**
 * Internal forms (TBL-11): a builder lays out some fields of one data table as a form; the people
 * who may submit fill it in, and each submission adds one record whose history names the form.
 * Who may submit is the form's own share list (members, groups, everyone); with none, the
 * members who may add records to that table. Builders always may, and only they open a draft
 * (a preview that takes nothing). There are no public forms.
 *
 * Error codes: `stale_revision` (409, `details.form` is the form now), `form_closed` (409, a
 * draft to someone who may submit), `already_submitted` (409, a single-submit form),
 * `too_many_forms` (409), `invalid_input` (400, `details.field` names the field).
 */

export const FORM_STATUSES = ['draft', 'published'] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FORM_NAME_MAX = 100;
export const FORM_DESCRIPTION_MAX = 2000;
export const FORM_LABEL_MAX = 100;
export const FORM_HELP_MAX = 500;
export const FORM_SUBMIT_LABEL_MAX = 40;
export const FORM_MESSAGE_MAX = 1000;
/** Forms one data table may have. */
export const MAX_FORMS = 50;

const idField = z.string().min(1).max(64);

/** One field of a form, in the form's order. */
export const formFieldSchema = z.object({
  field_id: idField,
  /** Shown instead of the field's name. */
  label: z.string().trim().max(FORM_LABEL_MAX).optional(),
  /** One line under it. */
  help: z.string().trim().max(FORM_HELP_MAX).optional(),
  /** Must be filled in (a checkbox: ticked). A field the table requires always is. */
  required: z.boolean().optional(),
});
export type FormField = z.infer<typeof formFieldSchema>;

/**
 * What a form asks and how. Fields are live fields of its table that a person can fill in (not
 * computed ones), each once; every field the table requires is in it.
 */
export const formConfigSchema = z.object({
  fields: z.array(formFieldSchema).max(MAX_FIELDS),
  /** The submit button's words; empty: the app's own (提交表单). */
  submit_label: z.string().trim().max(FORM_SUBMIT_LABEL_MAX).optional(),
  /** Shown after submitting; empty: the app's own (已提交，谢谢). */
  success_message: z.string().trim().max(FORM_MESSAGE_MAX).optional(),
  /** One submission per member. */
  single_submit: z.boolean().optional(),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

/** A form as its base's builders see it. */
export const formSchema = z.object({
  id: z.string(),
  base_id: z.string(),
  table_id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(FORM_STATUSES),
  config: formConfigSchema,
  /** Send it back with a change; a newer one answers 409 `stale_revision`. */
  revision: z.number().int(),
  submission_count: z.number().int(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Form = z.infer<typeof formSchema>;

export const createFormInputSchema = z.object({
  name: z.string().trim().min(1).max(FORM_NAME_MAX),
  description: z.string().max(FORM_DESCRIPTION_MAX).optional(),
  /** Default: every field a person fills in, without parents and dependencies. */
  config: formConfigSchema.optional(),
});
export type CreateFormInput = z.infer<typeof createFormInputSchema>;

/** A change based on `revision`; the keys of `config` that are sent replace the form's, '' clears a text. */
export const updateFormInputSchema = z.object({
  revision: z.number().int().positive(),
  name: z.string().trim().min(1).max(FORM_NAME_MAX).optional(),
  description: z.string().max(FORM_DESCRIPTION_MAX).optional(),
  config: formConfigSchema.partial().optional(),
});
export type UpdateFormInput = z.infer<typeof updateFormInputSchema>;

/** Who may submit: a member, a group, or everyone (no id). */
export const formShareSchema = z.object({
  type: z.enum(AUDIENCE_TYPES),
  /** Null for everyone. */
  id: z.string().nullable(),
  /** The member's or group's name; empty for everyone. */
  name: z.string(),
});
export type FormShare = z.infer<typeof formShareSchema>;
/** Empty: the members who may add records to the form's table submit. */
export const formSharesSchema = z.object({ items: z.array(formShareSchema) });
export type FormShares = z.infer<typeof formSharesSchema>;
/** Replaces who may submit (builders). */
export const formShareInputSchema = z.object({
  items: z
    .array(
      z
        .object({ type: z.enum(AUDIENCE_TYPES), id: idField.optional() })
        .refine((entry) => (entry.type === 'workspace') === (entry.id === undefined), {
          message: 'A member or group needs its id; everyone has none.',
        }),
    )
    .max(200),
});
export type FormShareInput = z.infer<typeof formShareInputSchema>;

/** A field as the person filling the form in sees it. */
export const formFillFieldSchema = z.object({
  id: z.string(),
  /** Its data table: parent and dependency links pick from its records. */
  table_id: z.string(),
  /** The form's label for it, else the field's name. */
  name: z.string(),
  help: z.string(),
  type: z.enum(FIELD_TYPES),
  required: z.boolean(),
  /** Only what filling it in needs: options, decimal places, more than one, the linked table. */
  config: fieldConfigSchema,
});
export type FormFillField = z.infer<typeof formFillFieldSchema>;

/**
 * What someone who may submit needs to fill the form in, and nothing of the table's records.
 * Links are asked only of people who can read the table they link to.
 */
export const formFillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** A draft opens only for the base's builders, as a preview that takes nothing. */
  status: z.enum(FORM_STATUSES),
  fields: z.array(formFillFieldSchema),
  submit_label: z.string(),
  success_message: z.string(),
  single_submit: z.boolean(),
  /** I have submitted it before. */
  submitted: z.boolean(),
});
export type FormFill = z.infer<typeof formFillSchema>;

/** Values by field id, only the form's fields (shapes as in tables.ts). */
export const submitFormInputSchema = z.object({ values: recordValuesSchema.default({}) });
export type SubmitFormInput = z.input<typeof submitFormInputSchema>;
export const formReceiptSchema = z.object({ id: z.string(), created_at: isoTime });
export type FormReceipt = z.infer<typeof formReceiptSchema>;

/** A file for an attachment field of a form, waiting for the submission that names it. */
export const formUploadSchema = z.object({
  id: z.string(),
  name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
});
export type FormUpload = z.infer<typeof formUploadSchema>;

export const formSubmissionSchema = z.object({
  id: z.string(),
  member: memberRefSchema.nullable(),
  created_at: isoTime,
  /** The record it added; null once that record is deleted. */
  record: z.object({ id: z.string(), title: z.string() }).nullable(),
});
export type FormSubmission = z.infer<typeof formSubmissionSchema>;
