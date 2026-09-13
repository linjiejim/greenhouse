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

  register(registration: ApplicationRegistration<PlatformHandlerContext>): void {
    this.#registry.register(registration);
  }

  getManifest(appId: string): ApplicationManifest | undefined {
    return this.#registry.getManifest(appId);
  }

  listManifests(): ApplicationManifest[] {
    return this.#registry.listManifests();
  }

  async authorize(actor: ActorContext, capability: string): Promise<CapabilityDecision> {
    if (actor.orgId !== PLATFORM_ORG_ID) {
      return { allowed: false, capability, reason: 'default-deny' };
    }

    const userId = actor.onBehalfOfUserId ?? actor.actorId;
    const user = await this.#db.users.getById(userId);
    if (!user || user.status !== 'active') {
      return { allowed: false, capability, reason: 'default-deny' };
    }

    const snapshot = await this.#db.platform.getAuthorizationSnapshot(userId, actor.orgId);
    return resolveCapability({ capability, ...snapshot });
  }

  async listVisibleApplications(actor: ActorContext): Promise<VisibleApplication[]> {
    const visible: VisibleApplication[] = [];
    for (const manifest of this.#registry.listManifests()) {
      const decisions = await Promise.all(
        Object.values(manifest.actions).map(async (action) => ({
          action,
          decision: await this.authorize(actor, action.capability),
        })),
      );
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

  async dispatch(
    request: PlatformActionRequest,
    operation?: PlatformHandlerContext['operation'],
  ): Promise<PlatformActionResult> {
    try {
      return await this.#registry.dispatch(request, { db: this.#db, operation });
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
  registrations: readonly ApplicationRegistration<PlatformHandlerContext>[],
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
