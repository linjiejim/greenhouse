import { z } from 'zod';
import { isoTime } from './common.js';
import { capabilitySchema } from './providers.js';

export const MEMBER_ROLES = ['admin', 'member'] as const;
export const MEMBER_STATUSES = ['invited', 'active', 'reset_required', 'disabled'] as const;
export const MEMBER_MODULES = ['knowledge', 'tables', 'apps', 'computer'] as const;
export const THEMES = ['system', 'light', 'dark'] as const;

export const modulesSchema = z.object({
  knowledge: z.boolean(),
  tables: z.boolean(),
  apps: z.boolean(),
  computer: z.boolean(),
});
export type MemberModules = z.infer<typeof modulesSchema>;

/** What any member may see about another. */
export const memberSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  /** Their picture, as a short-lived URL made for the reader (an `<img src>` needs no header). */
  avatar_url: z.string().nullable(),
});
export type MemberSummary = z.infer<typeof memberSummarySchema>;

export const meSchema = memberSummarySchema.extend({
  role: z.enum(MEMBER_ROLES),
  locale: z.string(),
  timezone: z.string(),
  theme: z.enum(THEMES),
  about: z.string(),
  modules: modulesSchema,
  /**
   * Which services can serve me now, by configuration (my own keys included where allowed),
   * not by a live check. The apps hide what needs a missing one: no sandbox, no computer.
   */
  capabilities: z.record(capabilitySchema, z.boolean()),
});
export type Me = z.infer<typeof meSchema>;

/** The directory, narrowed by name or email. */
export const directoryQuerySchema = z.object({ q: z.string().trim().max(100).optional() });

export const updateMeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    locale: z.enum(['zh', 'en']),
    timezone: z.string().min(1).max(64),
    theme: z.enum(THEMES),
    about: z.string().max(4000),
    /** A picture I uploaded with purpose `avatar`; null removes mine. The one it replaces is deleted. */
    avatar_file_id: z.string().min(1).max(64).nullable(),
  })
  .partial();
export type UpdateMeInput = z.infer<typeof updateMeInputSchema>;

export const changePasswordInputSchema = z.object({
  current_password: z.string().min(1).max(256),
  new_password: z.string().min(8).max(256),
});

/** The admin view of a member. */
export const memberAdminSchema = memberSummarySchema.extend({
  role: z.enum(MEMBER_ROLES),
  status: z.enum(MEMBER_STATUSES),
  modules: modulesSchema,
  last_login_at: isoTime.nullable(),
  created_at: isoTime,
});
export type MemberAdmin = z.infer<typeof memberAdminSchema>;

export const inviteInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(80),
  role: z.enum(MEMBER_ROLES).default('member'),
});
export type InviteInput = z.input<typeof inviteInputSchema>;

/** A one-time link the admin hands over (shown once; it is never stored in plain text). */
export const issuedLinkSchema = z.object({ url: z.string(), expires_at: isoTime });
export type IssuedLink = z.infer<typeof issuedLinkSchema>;

export const inviteResultSchema = z.object({ member: memberAdminSchema, link: issuedLinkSchema });
export type InviteResult = z.infer<typeof inviteResultSchema>;

export const updateMemberInputSchema = z
  .object({
    role: z.enum(MEMBER_ROLES),
    status: z.enum(['active', 'disabled']),
    modules: modulesSchema.partial(),
    name: z.string().trim().min(1).max(80),
  })
  .partial();
export type UpdateMemberInput = z.infer<typeof updateMemberInputSchema>;

export const groupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  member_ids: z.array(z.string()),
});
export type Group = z.infer<typeof groupSchema>;

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.string().max(500).default(''),
  member_ids: z.array(z.string()).max(1000).default([]),
});
export type GroupInput = z.input<typeof groupInputSchema>;
