/**
 * Platform runtime bridge.
 *
 * The kernel stays transport/database neutral. This module is the single API
 * adapter that resolves persisted permissions, owns the guarded registry, and
 * writes platform audits.
 */

import {
  ApplicationRegistry,
  AuthorizationDeniedError,
  resolveCapability,
  type ActorContext,
  type ApplicationManifest,
  type ApplicationRegistration,
  type CapabilityDecision,
  type PlatformActionRequest,
  type PlatformActionResult,
} from '@greenhouse/platform-kernel';
import type { DatabaseProvider } from '@greenhouse/db';

export const PLATFORM_ORG_ID = 'default';

export interface PlatformHandlerContext {
  db: DatabaseProvider;
  /**
   * Transitional adapter for existing domains whose service logic already has
   * a single access implementation. The registered handler invokes this bound
   * operation inside the guarded/audited registry call.
   */
  operation?: () => Promise<PlatformActionResult>;
}

/**
 * Where an app files a dispatch's audit event (`resource.scopeType` /
 * `scopeId`), resolved before the handler runs. Undefined = no scope.
 */
export type PlatformAuditScopeResolver = (
  db: DatabaseProvider,
  request: PlatformActionRequest,
) => Promise<{ scopeType: string; scopeId: string } | undefined>;

/** A kernel registration plus what only this host does with it. */
export interface PlatformRegistration extends ApplicationRegistration<PlatformHandlerContext> {
  auditScope?: PlatformAuditScopeResolver;
}

export interface VisibleApplication {
  manifest: ApplicationManifest;
  allowedActionIds: string[];
  allowedCapabilities: string[];
}

/**
 * Runtime authorization deliberately has no cache: user disable and explicit
 * permission revocation must take effect on the next request.
 */
export class PlatformRuntime {
  readonly #db: DatabaseProvider;
  readonly #registry: ApplicationRegistry<PlatformHandlerContext>;
  readonly #auditScopes = new Map<string, PlatformAuditScopeResolver>();

  constructor(db: DatabaseProvider) {
    this.#db = db;
    this.#registry = new ApplicationRegistry<PlatformHandlerContext>({
      authorize: async (actor, action) => {
        const decision = await this.authorize(actor, action.capability);
        return { allowed: decision.allowed, reason: decision.reason };
      },
      audit: async (event) => {
        await this.#db.platform.recordAudit(event);
      },
    });
  }

  register(registration: PlatformRegistration): void {
    this.#registry.register(registration);
    if (registration.auditScope) this.#auditScopes.set(registration.manifest.id, registration.auditScope);
  }

  getManifest(appId: string): ApplicationManifest | undefined {
    return this.#registry.getManifest(appId);
  }

  listManifests(): ApplicationManifest[] {
    return this.#registry.listManifests();
  }

  async authorize(actor: ActorContext, capability: string): Promise<CapabilityDecision> {
    return (await this.#decider(actor))(capability);
  }

  /**
   * The actor's capability decisions for this one call: the user and the
   * permission snapshot are loaded once, then every capability resolves
   * against them. Never kept beyond the call (revocation is immediate).
   */
  async #decider(actor: ActorContext): Promise<(capability: string) => CapabilityDecision> {
    const deny = (capability: string): CapabilityDecision => ({ allowed: false, capability, reason: 'default-deny' });
    if (actor.orgId !== PLATFORM_ORG_ID) return deny;
    const userId = actor.onBehalfOfUserId ?? actor.actorId;
    const user = await this.#db.users.getById(userId);
    if (!user || user.status !== 'active') return deny;
    const snapshot = await this.#db.platform.getAuthorizationSnapshot(userId, actor.orgId);
    return (capability) => resolveCapability({ capability, ...snapshot });
  }

  /** Every manifest with the actions the actor may call — one user + snapshot load for the whole catalog. */
  async listVisibleApplications(actor: ActorContext): Promise<VisibleApplication[]> {
    const decide = await this.#decider(actor);
    const visible: VisibleApplication[] = [];
    for (const manifest of this.#registry.listManifests()) {
      const decisions = Object.values(manifest.actions).map((action) => ({
        action,
        decision: decide(action.capability),
      }));
      const allowed = decisions.filter((entry) => entry.decision.allowed);
      if (allowed.length === 0) continue;
      visible.push({
        manifest,
        allowedActionIds: allowed.map((entry) => entry.action.id),
        allowedCapabilities: [...new Set(allowed.map((entry) => entry.action.capability))].sort(),
      });
    }
    return visible;
  }

  /** The request with the app's audit scope stamped on its resource (callers' own scope wins). */
  async #withAuditScope(request: PlatformActionRequest): Promise<PlatformActionRequest> {
    const resolve = this.#auditScopes.get(request.appId);
    if (!resolve || (request.resource?.scopeType && request.resource.scopeId)) return request;
    const scope = await resolve(this.#db, request);
    if (!scope) return request;
    return {
      ...request,
      resource: {
        ...(request.resource ?? { appId: request.appId }),
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      },
    };
  }

  async dispatch(
    request: PlatformActionRequest,
    operation?: PlatformHandlerContext['operation'],
  ): Promise<PlatformActionResult> {
    try {
      return await this.#registry.dispatch(await this.#withAuditScope(request), { db: this.#db, operation });
    } catch (error) {
      if (error instanceof AuthorizationDeniedError) {
        return { ok: false, code: 'FORBIDDEN', message: error.message };
      }
      throw error;
    }
  }
}

export async function runBoundPlatformOperation(
  _request: PlatformActionRequest,
  context: PlatformHandlerContext,
): Promise<PlatformActionResult> {
  if (!context.operation) {
    return {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'No application operation was bound to this action',
    };
  }
  return context.operation();
}

let runtime: PlatformRuntime | undefined;

export function initializePlatformRuntime(
  db: DatabaseProvider,
  registrations: readonly PlatformRegistration[],
): PlatformRuntime {
  const next = new PlatformRuntime(db);
  for (const registration of registrations) next.register(registration);
  runtime = next;
  return next;
}

export function getPlatformRuntime(): PlatformRuntime {
  if (!runtime) throw new Error('Platform runtime has not been initialized');
  return runtime;
}

/** Tests replace the process singleton between isolated runtime cases. */
export function resetPlatformRuntimeForTests(): void {
  runtime = undefined;
}
