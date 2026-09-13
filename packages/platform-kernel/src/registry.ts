import { AuthorizationDeniedError } from './authz.js';
import type { PlatformActionRequest, PlatformAuditEvent, PlatformActionResult, ActorContext } from './contract.js';
import { compileApp, type ApplicationManifest, type ManifestAction } from './dsl.js';

export type PlatformActionHandler<TContext = unknown> = (
  request: PlatformActionRequest,
  context: TContext,
) => Promise<PlatformActionResult>;

export interface RuntimeAuthorizationDecision {
  allowed: boolean;
  reason: string;
}

export type RuntimeAuthorizer = (
  actor: ActorContext,
  action: ManifestAction,
  request: PlatformActionRequest,
) => RuntimeAuthorizationDecision | Promise<RuntimeAuthorizationDecision>;

export type RuntimeAuditSink = (event: PlatformAuditEvent) => void | Promise<void>;

export interface ApplicationRegistration<TContext = unknown> {
  manifest: ApplicationManifest;
  handlers: Record<string, PlatformActionHandler<TContext>>;
}

export interface ApplicationRegistryOptions {
  authorize: RuntimeAuthorizer;
  audit: RuntimeAuditSink;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/**
 * In-memory application catalog and guarded dispatcher.
 *
 * Persistence of release manifests belongs to the DB service. The registry
 * only accepts a compiled manifest plus a complete, separately defined handler
 * map, keeping persisted manifests executable-code free.
 */
export class ApplicationRegistry<TContext = unknown> {
  readonly #applications = new Map<string, ApplicationRegistration<TContext>>();
  readonly #authorize: RuntimeAuthorizer;
  readonly #audit: RuntimeAuditSink;

  constructor(options: ApplicationRegistryOptions) {
    this.#authorize = options.authorize;
    this.#audit = options.audit;
  }

  register(registration: ApplicationRegistration<TContext>): void {
    const manifest = deepFreeze(compileApp(registration.manifest));
    const handlers = Object.freeze({ ...registration.handlers });
    if (this.#applications.has(manifest.id)) {
      throw new ApplicationRegistrationError(`应用 ${manifest.id} 已注册`);
    }

    const actionIds = new Set(Object.keys(manifest.actions));
    const handlerIds = new Set(Object.keys(handlers));
    const missingHandlers = [...actionIds].filter((id) => !handlerIds.has(id));
    const unknownHandlers = [...handlerIds].filter((id) => !actionIds.has(id));
    if (missingHandlers.length > 0 || unknownHandlers.length > 0) {
      const details = [
        missingHandlers.length > 0 ? `缺少 handlers: ${missingHandlers.join(', ')}` : '',
        unknownHandlers.length > 0 ? `存在未声明 handlers: ${unknownHandlers.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('；');
      throw new ApplicationRegistrationError(`应用 ${manifest.id} handler 不完整：${details}`);
    }

    this.#applications.set(manifest.id, Object.freeze({ manifest, handlers }));
  }

  unregister(appId: string): boolean {
    return this.#applications.delete(appId);
  }

  getManifest(appId: string): ApplicationManifest | undefined {
    return this.#applications.get(appId)?.manifest;
  }

  listManifests(): ApplicationManifest[] {
    return [...this.#applications.values()].map((item) => item.manifest);
  }

  async listVisibleManifests(actor: ActorContext): Promise<ApplicationManifest[]> {
    const visible: ApplicationManifest[] = [];
    for (const registration of this.#applications.values()) {
      let hasVisibleAction = false;
      for (const action of Object.values(registration.manifest.actions)) {
        const request: PlatformActionRequest = {
          actor,
          appId: registration.manifest.id,
          actionId: action.id,
          payload: undefined,
        };
        const decision = await this.#authorize(actor, action, request);
        if (decision.allowed) {
          hasVisibleAction = true;
          break;
        }
      }
      if (hasVisibleAction) visible.push(registration.manifest);
    }
    return visible;
  }

  async dispatch(request: PlatformActionRequest, context: TContext): Promise<PlatformActionResult> {
    const registration = this.#applications.get(request.appId);
    if (!registration) {
      throw new ApplicationNotFoundError(request.appId);
    }
    const action = registration.manifest.actions[request.actionId];
    if (!action) {
      throw new ActionNotFoundError(request.appId, request.actionId);
    }

    const decision = await this.#authorize(request.actor, action, request);
    if (!decision.allowed) {
      await this.#recordAudit(request, action, 'denied', { reason: decision.reason });
      throw new AuthorizationDeniedError(`缺少能力 ${action.capability}`);
    }

    let result: PlatformActionResult;
    try {
      result = await registration.handlers[action.id]!(request, context);
    } catch (error) {
      await this.#recordAudit(request, action, 'error', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
    await this.#recordAudit(request, action, result.ok ? 'success' : result.code === 'FORBIDDEN' ? 'denied' : 'error', {
      resultCode: result.ok ? undefined : result.code,
    });
    return result;
  }

  async #recordAudit(
    request: PlatformActionRequest,
    action: ManifestAction,
    result: PlatformAuditEvent['result'],
    summary: Record<string, unknown>,
  ): Promise<void> {
    await this.#audit({
      orgId: request.actor.orgId,
      actorId: request.actor.actorId,
      actorType: request.actor.actorType,
      onBehalfOfUserId: request.actor.onBehalfOfUserId,
      clientId: request.actor.clientId,
      requestId: request.actor.requestId,
      resource: request.resource ?? {
        appId: request.appId,
        moduleId: action.module,
        entityId: action.entity,
      },
      actionId: action.id,
      capability: action.capability,
      result,
      summary,
    });
  }
}

export class ApplicationRegistrationError extends Error {
  readonly code = 'APPLICATION_REGISTRATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'ApplicationRegistrationError';
  }
}

export class ApplicationNotFoundError extends Error {
  readonly code = 'APPLICATION_NOT_FOUND';

  constructor(appId: string) {
    super(`应用 ${appId} 未注册`);
    this.name = 'ApplicationNotFoundError';
  }
}

export class ActionNotFoundError extends Error {
  readonly code = 'ACTION_NOT_FOUND';

  constructor(appId: string, actionId: string) {
    super(`应用 ${appId} 未声明动作 ${actionId}`);
    this.name = 'ActionNotFoundError';
  }
}
