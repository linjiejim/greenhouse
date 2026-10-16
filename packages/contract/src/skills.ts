import { z } from 'zod';
import { isoTime } from './common.js';
import { questionFieldSchema } from './requests.js';

/** A SKILL.md package (instructions, files, scripts), or a template: instructions and variables. */
export const SKILL_KINDS = ['package', 'template'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];
/** Team skills are for every member; personal ones for their owner only. */
export const SKILL_SPACES = ['team', 'personal'] as const;
export type SkillSpace = (typeof SKILL_SPACES)[number];
/** Only `clean` skills run; `pending` and `suspicious` wait for review, `blocked` never runs. */
export const SKILL_SCAN_STATUSES = ['pending', 'clean', 'suspicious', 'blocked'] as const;
export type SkillScanStatus = (typeof SKILL_SCAN_STATUSES)[number];
/** Why a skill cannot run for an Agent right now. */
export const SKILL_UNAVAILABLE_CODES = [
  'archived',
  'in_review',
  'blocked',
  'needs_computer',
  'needs_connector',
] as const;
export type SkillUnavailableCode = (typeof SKILL_UNAVAILABLE_CODES)[number];

/** The `/` call name: lower-case letters (any script), digits and hyphens, no hyphen at either end. */
export const SKILL_NAME_PATTERN = /^[\p{Ll}\p{Lo}\p{Nd}](?:[\p{Ll}\p{Lo}\p{Nd}-]{0,62}[\p{Ll}\p{Lo}\p{Nd}])?$/u;
/** A `{{key}}` placeholder name. */
export const SKILL_VARIABLE_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
export const SKILL_DISPLAY_NAME_MAX = 80;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_TEMPLATE_BODY_MAX = 8000;
export const SKILL_VARIABLES_MAX = 10;
export const SKILL_VARIABLE_VALUE_MAX = 4000;
export const SKILL_CHANGELOG_MAX = 2000;
export const SKILL_TAGS_MAX = 10;

export const skillNameSchema = z
  .string()
  .trim()
  .regex(SKILL_NAME_PATTERN, 'Use lower-case letters, digits and hyphens (at most 64), like weekly-report.');
export const skillVersionNumberSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a version like 1.2.0.');

/** A template's fill-in field, the same as an ask_user field, filling `{{key}}` in the body. */
export const skillVariableSchema = questionFieldSchema
  .extend({ key: z.string().regex(SKILL_VARIABLE_KEY_PATTERN, 'Use letters, digits and _ (at most 40).') })
  .refine((field) => field.type !== 'choice' || (field.options?.length ?? 0) > 0, {
    message: 'A choice needs its options.',
  });
export type SkillVariable = z.infer<typeof skillVariableSchema>;

/** What a skill needs to run. Packages declare it in SKILL.md's frontmatter (`requirements:`). */
export const skillRequirementsSchema = z.object({
  /** The Agent's own computer. */
  computer: z.boolean().default(false),
  /** Connectors by slug, usable by the Agent for the member who runs it. */
  connectors: z.array(z.string().min(1).max(40)).max(10).default([]),
});
export type SkillRequirements = z.infer<typeof skillRequirementsSchema>;

export const skillScanFindingSchema = z.object({
  /** A stable rule id, e.g. remote-script-execution, prompt-injection, secret. */
  rule: z.string(),
  /** Only `high` findings hold a skill for review; `medium` ones are for a reviewer to read. */
  severity: z.enum(['high', 'medium']),
  /** The file in the package; absent for a template's text. */
  path: z.string().optional(),
  excerpt: z.string(),
});
export type SkillScanFinding = z.infer<typeof skillScanFindingSchema>;

export const skillUnavailableSchema = z.object({
  code: z.enum(SKILL_UNAVAILABLE_CODES),
  message: z.string(),
  /** The connector it needs (`needs_connector`). */
  connector: z.string().optional(),
});
export type SkillUnavailable = z.infer<typeof skillUnavailableSchema>;

export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  display_name: z.string(),
  description: z.string(),
  kind: z.enum(SKILL_KINDS),
  space: z.enum(SKILL_SPACES),
  owner_id: z.string(),
  tags: z.array(z.string()),
  latest_version: z.string(),
  requirements: skillRequirementsSchema,
  /** The latest version's fields: the form `/` shows before it runs. */
  variables: z.array(skillVariableSchema),
  scan_status: z.enum(SKILL_SCAN_STATUSES),
  scan_findings: z.array(skillScanFindingSchema),
  scanned_at: isoTime.nullable(),
  /** Who marked it safe or confirmed it malicious. */
  scan_reviewed_by: z.string().nullable(),
  scan_note: z.string().nullable(),
  download_count: z.number().int(),
  archived_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
  /** May I change it: its owner, or an admin for a team skill. */
  can_manage: z.boolean(),
  /** May I mark it safe or malicious: an admin for a team skill, the owner for a personal one. */
  can_review: z.boolean(),
  /** Whether it can run for the Agent asked about (`?agent=`, the main Agent by default), and why not. */
  available: z.boolean(),
  unavailable: skillUnavailableSchema.nullable(),
});
export type Skill = z.infer<typeof skillSchema>;

export const skillFileSchema = z.object({ path: z.string(), size: z.number().int() });
export type SkillFile = z.infer<typeof skillFileSchema>;

/** An immutable version. `sha256` hashes its content: the package's files, or a template's text. */
export const skillVersionSchema = z.object({
  version: z.string(),
  changelog: z.string(),
  sha256: z.string(),
  file_count: z.number().int(),
  size_bytes: z.number().int(),
  created_by: z.string().nullable(),
  created_at: isoTime,
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const skillDetailSchema = skillSchema.extend({
  /** The latest version's instructions: a template's body with its `{{key}}` placeholders, or SKILL.md without its frontmatter. */
  body: z.string(),
  /** A package's files, SKILL.md included; empty for a template. */
  files: z.array(skillFileSchema),
  version: skillVersionSchema,
});
export type SkillDetail = z.infer<typeof skillDetailSchema>;

export const skillListQuerySchema = z.object({
  /** Matches the name, display name, description and tags. */
  q: z.string().trim().max(100).optional(),
  space: z.enum(SKILL_SPACES).optional(),
  kind: z.enum(SKILL_KINDS).optional(),
  scan_status: z.enum(SKILL_SCAN_STATUSES).optional(),
  /** `true`: the archived skills I may restore. */
  archived: z.enum(['true', 'false']).default('false'),
  /** The Agent `available` is judged for: an id, a handle, or `main` (the default). */
  agent: z.string().max(80).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type SkillListQuery = z.input<typeof skillListQuerySchema>;

const tagsSchema = z.array(z.string().trim().min(1).max(30)).max(SKILL_TAGS_MAX);
const displayNameSchema = z.string().trim().max(SKILL_DISPLAY_NAME_MAX);
const descriptionSchema = z.string().trim().min(1).max(SKILL_DESCRIPTION_MAX);
const templateBodySchema = z.string().trim().min(1).max(SKILL_TEMPLATE_BODY_MAX);

export const createSkillInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('package'),
    /** The ZIP, uploaded with `POST /api/files` (purpose `skill`); its SKILL.md gives the name, description and requirements. */
    file_id: z.string().min(1).max(64),
    space: z.enum(SKILL_SPACES).default('personal'),
    tags: tagsSchema.optional(),
    /** The first version; SKILL.md's `version`, else 1.0.0. */
    version: skillVersionNumberSchema.optional(),
    changelog: z.string().trim().max(SKILL_CHANGELOG_MAX).optional(),
  }),
  z.object({
    kind: z.literal('template'),
    name: skillNameSchema,
    display_name: displayNameSchema.optional(),
    description: descriptionSchema,
    tags: tagsSchema.optional(),
    body: templateBodySchema,
    variables: z.array(skillVariableSchema).max(SKILL_VARIABLES_MAX).default([]),
    requirements: skillRequirementsSchema.default({ computer: false, connectors: [] }),
    space: z.enum(SKILL_SPACES).default('personal'),
    version: skillVersionNumberSchema.optional(),
    changelog: z.string().trim().max(SKILL_CHANGELOG_MAX).optional(),
  }),
]);
export type CreateSkillInput = z.input<typeof createSkillInputSchema>;

/** A new version: a new ZIP for a package; a new body, variables or requirements for a template. */
export const newSkillVersionInputSchema = z.object({
  changelog: z.string().trim().min(1).max(SKILL_CHANGELOG_MAX),
  /** Higher than the latest; the next patch version when left out (or SKILL.md's `version`). */
  version: skillVersionNumberSchema.optional(),
  file_id: z.string().min(1).max(64).optional(),
  body: templateBodySchema.optional(),
  variables: z.array(skillVariableSchema).max(SKILL_VARIABLES_MAX).optional(),
  requirements: skillRequirementsSchema.optional(),
});
export type NewSkillVersionInput = z.input<typeof newSkillVersionInputSchema>;

/** Catalog details; the instructions change only with a new version. */
export const updateSkillInputSchema = z
  .object({ display_name: displayNameSchema, description: descriptionSchema, tags: tagsSchema })
  .partial();
export type UpdateSkillInput = z.infer<typeof updateSkillInputSchema>;

/** `rescan` runs the scan again; `safe` and `malicious` are a reviewer's decision. */
export const skillScanDecisionInputSchema = z.object({
  decision: z.enum(['rescan', 'safe', 'malicious']),
  note: z.string().trim().max(500).optional(),
});
export type SkillScanDecisionInput = z.input<typeof skillScanDecisionInputSchema>;

export const skillDownloadQuerySchema = z.object({ version: skillVersionNumberSchema.optional() });

/** A package as a ZIP (`<name>/SKILL.md` …), behind a signed URL for me. */
export const skillDownloadSchema = z.object({
  name: z.string(),
  version: z.string(),
  sha256: z.string(),
  size_bytes: z.number().int(),
  url: z.string(),
  expires_at: isoTime,
});
export type SkillDownload = z.infer<typeof skillDownloadSchema>;

export const skillStartersQuerySchema = z.object({ agent: z.string().max(80).optional() });

/** The new chat's empty state. */
export const skillStartersSchema = z.object({
  /** Up to three of my most-used skills that can run for this Agent. */
  skills: z.array(skillSchema),
  /** The Agent template's opening lines, when there is no skill to show. */
  starters: z.array(z.string()),
});
export type SkillStarters = z.infer<typeof skillStartersSchema>;
