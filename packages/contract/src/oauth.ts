import { z } from 'zod';
import { isoTime } from './common.js';

/**
 * External access (OPEN-01): outside clients reach `/api/mcp` as a member, through OAuth 2.1 or a
 * personal access token. A scope is one resource group and what may be done with it; each one
 * opens a fixed set of MCP tools (apps/api/src/modules/mcp/tools.ts). The consent page, the token
 * form and the client form list them in this order.
 */
export const OAUTH_SCOPES = [
  'agents:read',
  'agents:ask',
  'conversations:read',
  'runs:read',
  'memories:read',
  'apps:read',
  'apps:write',
] as const;
export const oauthScopeSchema = z.enum(OAUTH_SCOPES);
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/** `interactive`: signs a member in through the consent page. `machine`: a secret, acting as one member. */
export const OAUTH_CLIENT_KINDS = ['interactive', 'machine'] as const;
/** `dynamic`: the client registered itself (RFC 7591), so its name is its own claim. `admin`: an admin added it. */
export const OAUTH_CLIENT_REGISTRATIONS = ['dynamic', 'admin'] as const;

const scopeList = z.array(oauthScopeSchema).min(1).max(OAUTH_SCOPES.length);
const clientName = z.string().trim().min(1).max(120);

/** The consent page (`#/oauth/consent?request=`): which client asks, for what, and where it returns. */
export const consentRequestSchema = z.object({
  client: z.object({
    id: z.string(),
    name: z.string(),
    registration: z.enum(OAUTH_CLIENT_REGISTRATIONS),
  }),
  /** Where the browser goes back; show its host so the member can tell who receives the access. */
  redirect_uri: z.string(),
  /** What the client asks for, in OAUTH_SCOPES order. */
  scopes: z.array(oauthScopeSchema),
  /** What I already granted this client, or null. */
  granted_scopes: z.array(z.string()).nullable(),
  expires_at: isoTime,
});
export type ConsentRequest = z.infer<typeof consentRequestSchema>;

export const consentQuerySchema = z.object({ request: z.string().min(16).max(256) });

export const consentDecisionInputSchema = z.object({
  request: z.string().min(16).max(256),
  decision: z.enum(['approve', 'deny']),
  /** What I tick; left out, everything asked. Never more than was asked. */
  scopes: scopeList.optional(),
});
export type ConsentDecisionInput = z.infer<typeof consentDecisionInputSchema>;

/** Send the browser here: the client's redirect URI with a code, or with `error=access_denied`. */
export const consentResultSchema = z.object({ redirect_to: z.string() });
export type ConsentResult = z.infer<typeof consentResultSchema>;

/** A client I authorized (Settings → External access). */
export const grantSchema = z.object({
  id: z.string(),
  client: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(OAUTH_CLIENT_KINDS),
    registration: z.enum(OAUTH_CLIENT_REGISTRATIONS),
    status: z.enum(['active', 'disabled']),
  }),
  /** Exactly what was granted. */
  scopes: z.array(z.string()),
  /** `pending`: an admin bound a machine client to me; it acts as me only after I approve. */
  status: z.enum(['pending', 'active']),
  active_tokens: z.number().int(),
  last_used_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type Grant = z.infer<typeof grantSchema>;

/** A personal access token, for the CLI and scripts: a bearer token for `/api/mcp` only. */
export const personalTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(['active', 'expired']),
  last_used_at: isoTime.nullable(),
  expires_at: isoTime,
  created_at: isoTime,
});
export type PersonalToken = z.infer<typeof personalTokenSchema>;

export const PERSONAL_TOKEN_MAX_DAYS = 366;

export const createPersonalTokenInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: scopeList,
  expires_in_days: z.number().int().min(1).max(PERSONAL_TOKEN_MAX_DAYS).default(30),
});
export type CreatePersonalTokenInput = z.input<typeof createPersonalTokenInputSchema>;

/** Shown once: only a keyed hash of `token` is kept. */
export const createdPersonalTokenSchema = personalTokenSchema.extend({ token: z.string() });
export type CreatedPersonalToken = z.infer<typeof createdPersonalTokenSchema>;

/** The admin view of a client (Administration → External access), with its recent activity. */
export const adminClientSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(OAUTH_CLIENT_KINDS),
  registration: z.enum(OAUTH_CLIENT_REGISTRATIONS),
  status: z.enum(['active', 'disabled']),
  redirect_uris: z.array(z.string()),
  /** The most it may be granted; null: whatever a member approves. */
  allowed_scopes: z.array(z.string()).nullable(),
  /** A machine client's member, and whether they approved it. */
  bound_member: z.object({ id: z.string(), name: z.string(), email: z.string() }).nullable(),
  bound_grant_status: z.enum(['pending', 'active', 'revoked']).nullable(),
  /** Members it acts for now. */
  active_grants: z.number().int(),
  active_tokens: z.number().int(),
  last_used_at: isoTime.nullable(),
  created_at: isoTime,
  updated_at: isoTime,
});
export type AdminClient = z.infer<typeof adminClientSchema>;

export const createClientInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('interactive'),
    name: clientName,
    redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
    /** Cap what members can grant it; left out, no cap. */
    scopes: scopeList.optional(),
  }),
  z.object({
    kind: z.literal('machine'),
    name: clientName,
    /** It acts as this member, after they approve it (at once when it is the admin themself). */
    member_id: z.string().min(1).max(64),
    scopes: scopeList,
  }),
]);
export type CreateClientInput = z.infer<typeof createClientInputSchema>;

export const updateClientInputSchema = z.object({ name: clientName, status: z.enum(['active', 'disabled']) }).partial();
export type UpdateClientInput = z.infer<typeof updateClientInputSchema>;

/** A new client, with a machine client's secret shown once. */
export const createdClientSchema = z.object({ client: adminClientSchema, client_secret: z.string().nullable() });
export type CreatedClient = z.infer<typeof createdClientSchema>;

/** A rotated secret, shown once; the old one and its tokens stop working at once. */
export const rotatedSecretSchema = z.object({ client: adminClientSchema, client_secret: z.string() });
export type RotatedSecret = z.infer<typeof rotatedSecretSchema>;
