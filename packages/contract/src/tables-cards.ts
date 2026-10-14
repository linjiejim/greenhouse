import { z } from 'zod';
import {
  DATE_BUCKETS,
  OPTION_COLORS,
  VIEW_NAME_MAX,
  cardSchema,
  linkedRecordSchema,
  recordFileSchema,
  recordSchema,
} from './tables.js';

/**
 * Dashboards (TBL-13): a dashboard is a view of a base (`type` dashboard, no table) whose config
 * is `{ cards }` (cardSchema in tables.ts, which apps reuse). This file is what a card shows: its
 * figures, worked out by the server with the reader's own access, so two people may see different
 * numbers on the same card. A card that cannot be worked out says why instead of failing the rest.
 */

/** Groups a chart shows when its card does not say (`group.limit`, at most MAX_CARD_GROUPS). */
export const DEFAULT_CARD_GROUPS = 10;
/** Records a list card shows when it does not say (`list.limit`, at most MAX_CARD_LIST). */
export const DEFAULT_CARD_LIST = 10;

/**
 * Why a card shows no figures: its data table is gone or not mine to see; a field it counts,
 * groups or filters by is gone or hidden from me; it lacks what its kind needs (a sum without a
 * number field, a chart without a group); the database could not answer it.
 */
export const CARD_ERRORS = ['table_hidden', 'field_hidden', 'incomplete', 'failed'] as const;
export type CardError = (typeof CARD_ERRORS)[number];

/**
 * What a chart's groups are keyed by: an option id (with its label and colour), a member id (with
 * the name), `true` / `false`, a date bucket's first day (YYYY-MM-DD; weeks start on Monday, in
 * the reader's time zone), a number, or text.
 */
export const CARD_GROUP_KEYS = ['option', 'member', 'checkbox', 'date', 'number', 'text'] as const;
export type CardGroupKey = (typeof CARD_GROUP_KEYS)[number];

export const cardGroupSchema = z.object({
  /** Null: the records without a value. */
  key: z.string().nullable(),
  /** An option's label, a member's name, the text itself; empty where the client words it (dates, checkboxes, numbers). */
  label: z.string(),
  color: z.enum(OPTION_COLORS).optional(),
  /** The figure: a count, or a sum, average, least or most (null when no record has a number). */
  value: z.number().nullable(),
  /** How many records it covers. */
  records: z.number().int(),
});
export type CardGroup = z.infer<typeof cardGroupSchema>;

export const cardDataSchema = z.discriminatedUnion('kind', [
  /** A number card. */
  z.object({ kind: z.literal('number'), value: z.number().nullable(), records: z.number().int() }),
  /**
   * A bar, line or pie card: one figure per group, in order (options as the field lists them,
   * dates oldest first with the empty ones in between, the rest by figure, the empty group last).
   * Past the card's limit the rest add up in `other` (for dates: the earlier ones).
   */
  z.object({
    kind: z.literal('groups'),
    key_type: z.enum(CARD_GROUP_KEYS),
    bucket: z.enum(DATE_BUCKETS).optional(),
    groups: z.array(cardGroupSchema),
    other: z.object({ value: z.number().nullable(), records: z.number().int() }).nullable(),
    records: z.number().int(),
  }),
  /** A list card: the first records in the card's order, with only its fields that I see. */
  z.object({
    kind: z.literal('list'),
    /** The records' title field (null when I do not see it). */
    title_field: z.string().nullable(),
    /** The other fields shown, in the card's order. */
    fields: z.array(z.string()),
    items: z.array(recordSchema),
    linked: z.record(z.string(), linkedRecordSchema),
    files: z.record(z.string(), recordFileSchema),
    /** Every record that matches. */
    records: z.number().int(),
  }),
  z.object({ kind: z.literal('error'), code: z.enum(CARD_ERRORS) }),
]);
export type CardData = z.infer<typeof cardDataSchema>;

/** Every card of a dashboard, each worked out on its own, for the dashboard's config at `revision`. */
export const dashboardDataSchema = z.object({
  revision: z.number().int(),
  items: z.array(z.object({ id: z.string(), data: cardDataSchema })),
});
export type DashboardData = z.infer<typeof dashboardDataSchema>;

/** One card, saved or not (the card editor's preview). */
export const cardQueryInputSchema = z.object({ card: cardSchema });

/** A new dashboard has no cards; shared ones need builder access, personal ones any access. */
export const createDashboardInputSchema = z.object({
  name: z.string().trim().min(1).max(VIEW_NAME_MAX),
  personal: z.boolean().default(false),
});
export type CreateDashboardInput = z.input<typeof createDashboardInputSchema>;
