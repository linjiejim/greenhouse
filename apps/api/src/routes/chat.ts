/**
 * Chat route — /api/chat
 *
 * POST /api/chat                          — 核心对话接口，NDJSON流式返回Agent响应（支持会话模式和无状态模式）
 * GET  /api/chat/runs                     — 当前用户所有生成中的 run（刷新后恢复侧栏状态/自动重连的种子）
 * GET  /api/chat/runs/:sessionId          — 探测某会话是否有生成中/刚结束的 run
 * GET  /api/chat/runs/:sessionId/stream   — 重连流：按 seq 回放缓冲事件后实时尾随（NDJSON）
 * POST /api/chat/runs/:sessionId/stop     — 服务端停止生成（abort agent loop，安全部分照常落库）
 *
 * 生成与 HTTP 响应解耦：agent loop 泵进 ChatRun 的事件缓冲（chat-runs.ts），
 * POST 响应只是 0 号订阅者。客户端断连/刷新不影响生成；重开页面经 runs 端点连回。
 * 本文件只做协议适配（鉴权 → 装配 → 起 run → 订阅）；泵循环与订阅层在 chat-turn.ts。
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { stream as honoStream } from 'hono/streaming';
import { getDb } from '@greenhouse/db';
import { selectTools, buildSystemPrompt } from '../agent.js';
import type { ToolRegistry } from '../agent.js';
import {
  buildLazyServerTools,
  filterUnattendedToolIds,
  LAZY_TOOL_IDS,
  resolveEffectiveTools,
} from '../agent-runtime/tool-resolution.js';
import { createClientActionBridge } from '../tools/client-action-bridge.js';
import type { ClientActionBridge } from '../tools/client-action-bridge.js';
import { sanitizeClientActions, createClientActionTools } from '../tools/client-actions.js';
import type { ClientActionDescriptor } from '@greenhouse/types/api';
import { resolveProfileAsync } from '../profiles/profile.js';
import { isChatModelAllowed } from '../config/models.js';
import { sanitizeForPrompt } from '../security/security.js';
import { sanitizeChatMessagesForPrompt } from '../chat/user-message.js';
import { resolveMemoryContext } from '../llm/memory.js';
import { pinProfileIdForUser, ProfileAccessError } from '../profiles/access.js';
import type { AuthUser } from '../auth/token.js';
import type { AgentProfile } from '../profiles/profile.js';
import type { AppEnv } from '../app-env.js';
import {
  createChatStreamAsync,
  createCollectors,
  windowMessagesByBudget,
  resolveHistoryBudget,
  modelSupportsVision,
} from '@greenhouse/agent-core';
import type { EngineMessage } from '@greenhouse/agent-core';
import { inlineImagesForVision } from '../chat/vision.js';
import { generateSessionTitle } from '../llm/title.js';
import { resolveCoworker } from '../coworkers/identity.js';
import { canWriteSession } from '../sessions/access.js';
import { formatAmbientContextPrompt, sanitizeAmbientContext } from '../chat/ambient-context.js';
import type { AmbientContextEnvelope } from '@greenhouse/types/agent-context';
import { chatRunRegistry, ChatRun } from '../chat/runs.js';
import { pumpChatTurn, streamRunToResponse } from '../chat/turn.js';
import { createProviderAttemptBudgetHook, type UsageBudgetPool } from '../llm/usage-budget.js';
import {
  recordChatRuntimeProviderInput,
  settleChatRuntimeTrace,
  startChatRuntimeTrace,
  type ChatRuntimeTrace,
} from '../chat/runtime.js';
import { runtimeAdapterEnabled } from '../trusted-execution/kill-switches.js';
import { instrumentRuntimeTools } from '../runtime/tool-evidence.js';

interface ChatRequestMessage {
  role: string;
  content: string;
  images?: Array<{ id: string; url: string }>;
}

/** Session status alone is not an execution credential. */
export function isTrustedEvalExecution(user: Pick<AuthUser, 'role'>, sessionStatus: string): boolean {
  return user.role === 'super' && sessionStatus === 'eval';
}

/**
 * The language model receives upload IDs rather than image bytes. Resolve them
 * from the effective transcript (including persisted history), so regeneration
 * with no new body message still retains an image-only user's visual context.
 */
export function appendLastUserImageHint(messages: ChatRequestMessage[]): ChatRequestMessage[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex < 0) return messages;

  const lastUser = messages[lastUserIndex];
  const imageIds = [
    ...new Set(
      (lastUser?.images ?? []).map((image) => sanitizeForPrompt(image.id).trim().slice(0, 256)).filter(Boolean),
    ),
  ];
  if (imageIds.length === 0 || !lastUser) return messages;

  const imageHint = `\n\n[Attached image ID(s): ${imageIds.join(', ')}.]`;
  return messages.map((message, index) =>
    index === lastUserIndex ? { ...message, content: message.content + imageHint } : message,
  );
}

// ─── Route Factory ───────────────────────────────────────

export function createChatRoute(toolRegistry: ToolRegistry) {
  /**
   * POST /api/chat
   * Body: { session_id?: string, messages: Message[], profile_id?: string }
   *
   * Returns: NDJSON stream
   */
  return (
    new Hono<AppEnv>()
      .post('/', async (c) => {
        const body = (await c.req.json()) as {
          session_id?: string;
          messages?: ChatRequestMessage[];
          ambient_context?: AmbientContextEnvelope;
          profile_id?: string;
          /**
           * Per-turn model choice. The agent's `model.id` is the default;
           * headless callers (scheduled tasks, eval runs, workflow nodes,
           * spawned sub-sessions) never send this and keep that default.
           */
          model?: string;
          workspace_id?: string; // active workspace for per-user proxy
          client_actions?: ClientActionDescriptor[]; // frontend UI actions available on the current screen
          client_action_scope_id?: string;
          regenerate_assistant_message_id?: unknown;
        };

        const sessionId = body.session_id;
        const rawRegenerationTarget = body.regenerate_assistant_message_id;
        if (
          rawRegenerationTarget !== undefined &&
          (typeof rawRegenerationTarget !== 'string' || rawRegenerationTarget.trim() === '')
        ) {
          return c.json({ error: 'regenerate_assistant_message_id must be a non-empty string' }, 400);
        }
        const regenerationTargetId =
          typeof rawRegenerationTarget === 'string' ? rawRegenerationTarget.trim() : undefined;
        if (regenerationTargetId && !sessionId) {
          return c.json({ error: 'Regeneration requires session_id' }, 400);
        }
        let chatMessages: ChatRequestMessage[];
        let profileId = body.profile_id || 'team';
        let budgetPool: UsageBudgetPool = 'standard';

        // Get authenticated user
        const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!authUser) return c.json({ error: 'Authentication required' }, 401);
        if (authUser.role !== 'super' && authUser.role !== 'team') {
          return c.json({ error: 'Internal account required' }, 403);
        }
        const userId = authUser.id;
        const userRole = authUser.role;

        try {
          profileId = await pinProfileIdForUser(authUser, profileId);
        } catch (err) {
          if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
          throw err;
        }

        // Sprouty (mission) is a cloud-agent profile, not a chat-engine one: its
        // execution path is POST /api/missions/runs (disposable sandbox). The
        // web client routes by profile; this guard catches direct/legacy callers.
        if (profileId === 'sprouty-mission') {
          return c.json({ error: 'sprouty-mission runs via /api/missions/runs, not /api/chat' }, 400);
        }

        // ── Profile access control (MUST run before quota check) ──
        let earlyProfile: AgentProfile;
        try {
          earlyProfile = await resolveProfileAsync(profileId);
        } catch (err) {
          return c.json({ error: `Invalid profile: ${err instanceof Error ? err.message : 'unknown error'}` }, 400);
        }

        const checkCloudProfileAccess = (
          profile: AgentProfile,
          requestedId: string,
        ): { allowed: boolean; error?: string } => {
          if (profile.access.level === 'hidden') {
            return { allowed: false, error: `Profile "${requestedId}" is not available` };
          }
          return { allowed: true };
        };

        const earlyAccess = checkCloudProfileAccess(earlyProfile, profileId);
        if (!earlyAccess.allowed) {
          return c.json({ error: earlyAccess.error }, 403);
        }

        // Read the owner row once; hard token admission happens atomically just
        // before provider I/O after the exact model payload is assembled.
        const user = await getDb().users.getById(userId);
        if (!user || user.status !== 'active') {
          return c.json({ error: 'Authenticated account is unavailable' }, 401);
        }

        // One generation per session. Claimed BEFORE the user message is
        // persisted so a duplicate POST can't double-append it; released on any
        // pre-stream failure below.
        let run: ChatRun | null = null;
        let runtimeTrace: ChatRuntimeTrace | null = null;
        const releaseClaim = () => {
          if (run) chatRunRegistry.release(run);
        };

        let titlePromise: Promise<string> | null = null;
        let pendingTitleMessage: string | null = null;
        let unattendedExecution = false;
        let triggeringUserMessageId: string | undefined;
        let sourceMode: 'message' | 'regeneration' | 'continuation' = 'continuation';
        let expectedAssistantTail: { id: string; content: string } | undefined;
        try {
          if (sessionId) {
            // ── Session mode: load history + append new user message ──
            const session = await getDb().sessions.getById(sessionId);
            if (!session) {
              return c.json({ error: 'Session not found' }, 404);
            }
            // `status` is user-editable for normal lifecycle actions. Only a
            // trusted super-owned Eval self-call may select the isolated Eval
            // budget pool and retry-safe unattended tool policy; a team user
            // cannot promote an ordinary chat into that execution class.
            if (isTrustedEvalExecution(authUser, session.status)) {
              budgetPool = 'eval';
              unattendedExecution = true;
            }
            // Continuing a chat mutates the session and reads its full history.
            // Sharing grants read-only inbox access, so only the owner or super may
            // reach addMessage/buildChatMessages/title updates below.
            if (!canWriteSession(authUser, session)) {
              return c.json({ error: 'Session not found' }, 404);
            }

            try {
              profileId = await pinProfileIdForUser(authUser, session.profile_id);
            } catch (err) {
              if (err instanceof ProfileAccessError) return c.json({ error: err.message }, err.status);
              throw err;
            }
            if (profileId === 'sprouty-mission') {
              return c.json({ error: 'sprouty-mission runs via /api/missions/runs, not /api/chat' }, 400);
            }
            let sessionProfile: AgentProfile;
            try {
              sessionProfile = await resolveProfileAsync(profileId);
            } catch (err) {
              return c.json(
                { error: `Invalid session profile: ${err instanceof Error ? err.message : 'unknown error'}` },
                400,
              );
            }
            const sessionAccess = checkCloudProfileAccess(sessionProfile, profileId);
            if (!sessionAccess.allowed) {
              return c.json({ error: sessionAccess.error }, 403);
            }

            if (session.agent_instance_id === null && session.user_id === userId) {
              const { instance } = await resolveCoworker(authUser, profileId);
              await getDb().coworkers.bindSession(sessionId, instance.id);
            }
            run = chatRunRegistry.claim(sessionId, userId);
            if (!run) {
              return c.json({ error: 'A response is already being generated for this session' }, 409);
            }

            if (regenerationTargetId) {
              if (body.messages?.length) {
                releaseClaim();
                return c.json({ error: 'Regeneration cannot include a new user message' }, 400);
              }
              const prepared = await getDb().sessions.prepareRegeneration(sessionId, regenerationTargetId);
              if (!prepared.ok) {
                releaseClaim();
                if (prepared.reason === 'session_not_found') {
                  return c.json({ error: 'Session not found' }, 404);
                }
                return c.json({ error: 'Assistant message is no longer the latest message' }, 409);
              }
              sourceMode = 'regeneration';
              triggeringUserMessageId = prepared.last_user?.id;
            }

            if (body.messages?.length) {
              const lastUserMsg = body.messages[body.messages.length - 1];
              if (lastUserMsg.role === 'user') {
                // The permanent transcript keeps the exact authored message.
                // Sanitisation/truncation is applied later to the model-only
                // projection, so audit and super review never lose content.
                const persistedUser = await getDb().sessions.addMessage({
                  session_id: sessionId,
                  role: 'user',
                  content: lastUserMsg.content,
                  images: lastUserMsg.images,
                });
                expectedAssistantTail = {
                  id: persistedUser.id,
                  content: persistedUser.content,
                };
                sourceMode = 'message';
                triggeringUserMessageId = persistedUser.id;
              } else {
                releaseClaim();
                return c.json({ error: 'The last session message must have role "user"' }, 400);
              }
            } else if (!regenerationTargetId) {
              // Legacy continuation requests do not append a new user message.
              // Capture the exact revision used for generation so a concurrent
              // edit makes terminal persistence fail closed.
              const latestMessage = await getDb().sessions.getLatestMessage(sessionId);
              if (latestMessage) {
                expectedAssistantTail = {
                  id: latestMessage.id,
                  content: latestMessage.content,
                };
                if (latestMessage.role === 'user') {
                  sourceMode = 'message';
                  triggeringUserMessageId = latestMessage.id;
                }
              }
            }

            chatMessages = regenerationTargetId
              ? await getDb().sessions.buildChatMessages(sessionId, {
                  excludeMessageId: regenerationTargetId,
                })
              : await getDb().sessions.buildChatMessages(sessionId);

            // Defer title-provider I/O until the durable Chat Runtime trace is
            // running. The pump still awaits this promise and emits the same
            // title event; only the admission/trace ordering changes.
            if (!session.title) {
              const firstUser = chatMessages.find((m) => m.role === 'user');
              if (firstUser) pendingTitleMessage = firstUser.content;
            }
          } else if (body.messages?.length) {
            // ── Stateless mode ──
            chatMessages = body.messages;
          } else {
            return c.json({ error: 'Either session_id or messages is required' }, 400);
          }

          if (chatMessages.length === 0) {
            releaseClaim();
            return c.json({ error: 'No messages to process' }, 400);
          }

          // Runtime retains the complete transcript revision used for this
          // turn. Prompt safety/windowing below only changes the provider
          // projection and must never rewrite historical evidence.
          const exactChatMessages = JSON.parse(JSON.stringify(chatMessages)) as ChatRequestMessage[];

          // Prompt safety is a projection, never a persistence transform. This
          // also covers stateless callers and historical exact transcripts.
          chatMessages = sanitizeChatMessagesForPrompt(chatMessages);

          // ── Resolve profile → model, tools, prompt ──
          let profile: AgentProfile;
          try {
            profile = await resolveProfileAsync(profileId);
          } catch (err) {
            releaseClaim();
            return c.json({ error: `Invalid profile: ${err instanceof Error ? err.message : err}` }, 400);
          }

          // ── Per-turn model choice ──
          // Only models the catalog marks chat-selectable AND that have a
          // reachable provider; anything else is a client bug, not a fallback.
          let requestedModel: string | undefined;
          if (typeof body.model === 'string' && body.model) {
            if (!isChatModelAllowed(body.model)) {
              releaseClaim();
              return c.json({ error: `Model "${body.model}" is not available` }, 400);
            }
            requestedModel = body.model;
          }

          // Pre-send context budget: the transcript itself is never trimmed, but
          // the model payload keeps only the newest turns within the token window —
          // otherwise a long-lived session grows until the provider rejects it.
          // The budget follows THIS turn's model (per-turn override wins over the
          // profile default): context_window × compaction threshold from the
          // catalog, 80k fallback for models with no declared window.
          const historyBudget = resolveHistoryBudget(requestedModel ?? profile.model.id);
          const historyWindow = windowMessagesByBudget(chatMessages, historyBudget);
          if (historyWindow.dropped > 0) {
            logger.info(
              `[Chat] history window dropped ${historyWindow.dropped} oldest message(s), ` +
                `kept ${historyWindow.messages.length} (~${historyWindow.estimatedTokens} est. tokens, ` +
                `budget ${historyBudget} for model ${requestedModel ?? profile.model.id ?? 'direct'})`,
            );
            chatMessages = historyWindow.messages;
          }

          // ── Attached images: pixels for vision models, IDs for the rest ──
          // Catalog `vision: true` models get image bytes inlined into the
          // payload (windowed history included, budget-capped in chat-vision).
          // Everything else keeps the ID hint + analyze_image contract; the
          // hint covers regeneration too, so an image-only persisted turn
          // retains its visual context without a new request-body message.
          const effectiveModelId = requestedModel ?? profile.model.id;
          let engineMessages: EngineMessage[];
          let visionInlinedImages = 0;
          if (modelSupportsVision(effectiveModelId)) {
            const visionResult = await inlineImagesForVision(chatMessages);
            engineMessages = visionResult.messages;
            visionInlinedImages = visionResult.inlined;
            if (visionResult.inlined > 0 || visionResult.hinted > 0) {
              logger.info(
                `[Chat] vision model ${effectiveModelId}: inlined ${visionResult.inlined} image(s)` +
                  (visionResult.hinted > 0 ? `, ${visionResult.hinted} over budget/unavailable → ID hint` : ''),
              );
            }
          } else {
            engineMessages = appendLastUserImageHint(chatMessages);
          }

          // When the deployment adapter is enabled, every authenticated Chat
          // provider turn gets a durable Runtime trace before title generation
          // or the main model can perform provider I/O. Disabling the adapter
          // is an emergency rollback for the derived trace only; domain Chat
          // keeps running under its own ChatRun id and persistence contract.
          // A newly appended/legacy user-message id closes the transcript→trace
          // crash window; regeneration and assistant-tail continuations add the
          // transport UUID because the same target may be explicitly retried.
          if (!run) {
            run = chatRunRegistry.createDetached(userId);
          }
          if (runtimeAdapterEnabled('chat')) {
            const sourceId = !sessionId
              ? `stateless:${run.runId}`
              : sourceMode === 'message' && triggeringUserMessageId
                ? `message:${triggeringUserMessageId}`
                : sourceMode === 'regeneration' && regenerationTargetId
                  ? `regeneration:${regenerationTargetId}:${run.runId}`
                  : `continuation:${expectedAssistantTail?.id ?? 'empty'}:${run.runId}`;
            runtimeTrace = await startChatRuntimeTrace(getDb(), {
              ownerUserId: userId,
              sessionId: sessionId ?? null,
              sourceId,
              input: {
                source_mode: sessionId ? sourceMode : 'stateless',
                triggering_user_message_id: triggeringUserMessageId ?? null,
                regeneration_target_id: regenerationTargetId ?? null,
                profile_id: profile.id,
                requested_model: requestedModel ?? null,
                effective_model: effectiveModelId,
                transcript: exactChatMessages,
                provider_message_projection: engineMessages,
                request_context: {
                  workspace_id: body.workspace_id ?? null,
                  ambient_context: body.ambient_context ?? null,
                  client_actions: body.client_actions ?? [],
                  client_action_scope_id: body.client_action_scope_id ?? null,
                },
              },
            });
          }

          // ── Resolve user tools (decoupled from profile; shared with /api/agent) ──
          const { effectiveTools } = await resolveEffectiveTools({
            userId,
            userRole,
            profile,
            profileId,
          });
          // Eval can retry only because its authenticated self-call is forced
          // through the same fail-closed read-only policy as every unattended
          // Runtime driver. A profile prompt can never opt mutation tools back in.
          const executionTools = unattendedExecution ? filterUnattendedToolIds(effectiveTools) : effectiveTools;

          const tools = selectTools(
            toolRegistry,
            executionTools.filter((t) => !LAZY_TOOL_IDS.has(t)),
          );

          // Inject per-request lazy server tools (feature_request, knowledge_query,
          // session_query, …) — shared logic.
          Object.assign(
            tools,
            buildLazyServerTools(getDb(), executionTools, {
              userId,
              userRole,
              sessionId,
              workspaceId: body.workspace_id,
              profileId: profile.id,
              runtimeRunId: runtimeTrace?.runId ?? null,
              toolRegistry,
              unattended: unattendedExecution,
            }),
          );

          // ── Client actions: wire a bridge so execution round-trips to the client ──
          // Browser-declared actions (navigate/prefill/...) ride the legacy
          // `local-tool-request` event: the bridge emits the request and awaits the
          // result posted to /api/client-actions/tool-result before the agent resumes.
          let clientActionBridge: ClientActionBridge | null = null;
          const ambientContext = sanitizeAmbientContext(body.ambient_context);
          const clientActions = sanitizeClientActions(body.client_actions);
          const clientActionScopeId =
            typeof body.client_action_scope_id === 'string'
              ? sanitizeForPrompt(body.client_action_scope_id).trim().slice(0, 256)
              : undefined;
          // A persisted session id is part of the result correlation key. Stateless
          // turns therefore ignore advertised actions instead of prompting the model
          // to call tools that were never registered.
          // When ambient context is present its scope and the actions must describe
          // the same page snapshot; a mismatched browser payload fails closed.
          const scopeMatchesAmbient = !ambientContext || ambientContext.scope_id === clientActionScopeId;
          const usesClientActions =
            Boolean(sessionId) && Boolean(clientActionScopeId) && scopeMatchesAmbient && clientActions.length > 0;
          if (usesClientActions && sessionId) {
            clientActionBridge = createClientActionBridge(userId, sessionId, clientActionScopeId);
            Object.assign(tools, createClientActionTools(clientActions, clientActionBridge));
          }

          // Runtime evidence belongs at the actual AI SDK execute boundary.
          // The wrapper awaits a durable `running` ToolCall before invoking the
          // tool, and settles exact output/error before releasing it to the
          // model; the later fullStream events remain UI/transcript data only.
          const executionToolRegistry = runtimeTrace
            ? instrumentRuntimeTools(tools, {
                db: getDb(),
                runId: runtimeTrace.runId,
                stepId: runtimeTrace.stepId,
                actorUserId: runtimeTrace.actorUserId,
                executionAuthority: { mode: 'chat_projection' },
                idempotencyPrefix: 'chat',
              })
            : tools;

          // Prompt-side tool guidance never lists tool names — the LLM already gets
          // full definitions via `tools[]`, and a prompt-side list can diverge from
          // the profile-narrowed set actually registered (leaking internal tool names
          // into profile-narrowed sessions). We only nudge proactive use.
          let systemPrompt = await buildSystemPromptWithUserNotes(
            profile,
            Object.keys(tools).length > 0,
            userId,
            ambientContext,
            sessionId,
          );

          // Vision models see attached images directly, but analyze_image's own
          // description commands "call this for each attached image" — verified
          // live: without this note the model invents a placeholder URL
          // (https://placeholder.local/…) to satisfy the tool, burns a step on a
          // guaranteed failure, then answers from the pixels anyway.
          if (visionInlinedImages > 0) {
            systemPrompt +=
              `\n\n## Attached Images\n` +
              `The user's attached images are embedded in this conversation — you can see them directly. ` +
              `Do NOT call analyze_image for images you can already see, and never invent an image ID or URL. ` +
              `analyze_image is only for a public HTTPS image URL, or an image ID explicitly listed in the message text.`;
          }

          // Nudge the model to actually drive the UI when a request maps to a client action,
          // instead of only describing the steps in prose.
          if (usesClientActions) {
            systemPrompt +=
              `\n\n## UI Actions (operate the user's current screen)\n` +
              `These tools operate the screen the user is currently looking at: ${clientActions
                .map((a) => a.name)
                .join(', ')}. ` +
              `When the user asks you to open, navigate to, show, or fill something that maps to one of these actions, ` +
              `CALL the tool to do it for them rather than only telling them where to click. ` +
              `Use the matching read action (e.g. *_get_current_view) when you need to know what is on screen. ` +
              `After a UI action succeeds, briefly confirm what you did. These actions only affect the UI — ` +
              `real data changes still go through the normal confirmed mutation tools.`;
          }

          if (runtimeTrace) {
            await recordChatRuntimeProviderInput(getDb(), runtimeTrace, {
              model: requestedModel ?? profile.model.id,
              model_config: profile.model,
              max_steps: profile.max_steps ?? 12,
              tool_choice: profile.tool_choice ?? 'auto',
              tool_ids: Object.keys(executionToolRegistry),
              system_prompt: systemPrompt,
              messages: engineMessages,
            });
          }

          // Auto-title stays concurrent with the main response, but its first
          // provider attempt now happens only after the Runtime trace and exact
          // provider envelope are durable.
          if (pendingTitleMessage && sessionId) {
            const firstUserMessage = pendingTitleMessage;
            titlePromise = generateSessionTitle(firstUserMessage, {
              userId,
              sessionId,
              ...(runtimeTrace ? { runId: runtimeTrace.runId } : {}),
            })
              .then(async (title) => {
                await getDb().sessions.updateTitle(sessionId, title);
                return title;
              })
              .catch(async (err) => {
                logger.warn('[chat] LLM title generation failed, using fallback:', err);
                const fallback = firstUserMessage
                  .replace(/[\n\r]+/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 50);
                await getDb()
                  .sessions.updateTitle(sessionId, fallback)
                  .catch(() => {});
                return fallback;
              });
          }

          // Stateless turns stream to this response only; session turns are
          // reconnectable via the registry claim made above. When the adapter
          // is on, both modes have a durable Runtime trace; only the stateless
          // transport buffer remains detached.

          const maxSteps = profile.max_steps ?? 12;
          const providerAttemptHook = createProviderAttemptBudgetHook({
            db: getDb(),
            userId,
            caller: 'chat',
            profileId,
            ...(sessionId ? { sessionId } : {}),
            runId: runtimeTrace?.runId ?? run.runId,
            budgetPool,
            metadata: { max_steps: maxSteps },
          });

          // ── Create chat stream via shared engine ──
          const stream = await createChatStreamAsync({
            profile,
            messages: engineMessages,
            tools: executionToolRegistry,
            systemPrompt,
            ...(sessionId ? { sessionId } : {}),
            // Server-side stop / graceful shutdown aborts the loop; the SDK
            // surfaces it as an `abort` part handled in the pump.
            abortSignal: run.signal,
            providerAttemptHook,
            // Validated above against the catalog's chat-selectable set, so an
            // arbitrary model id can never reach the engine.
            ...(requestedModel ? { modelOverride: requestedModel } : {}),
          });
          const { streamResult, dsmlRecoveries, startTime, modelId } = stream;

          // ── Detached pump: generation + persistence outlive this response ──
          void pumpChatTurn({
            run,
            streamResult,
            collectors: createCollectors(),
            dsmlRecoveries,
            startTime,
            modelId,
            profile,
            systemPrompt,
            chatMessages: engineMessages,
            sessionId: sessionId ?? undefined,
            userId,
            userLocale: user?.locale ?? undefined,
            titlePromise,
            clientActionBridge,
            replaceAssistantMessageId: regenerationTargetId,
            expectedTail: expectedAssistantTail,
            providerAttemptHook,
            runtimeTrace,
          });
        } catch (err) {
          if (runtimeTrace) {
            try {
              await settleChatRuntimeTrace(getDb(), runtimeTrace, {
                status: 'failed',
                output: { stage: 'before_chat_pump', error: err },
                errorCode: 'chat_preflight_failed',
                errorMessage: err instanceof Error ? err.message : String(err),
              });
            } catch (runtimeError) {
              logger.error('[chat-runtime] could not close failed preflight trace', runtimeError);
            }
          }
          releaseClaim();
          throw err;
        }

        if (!run) {
          // Unreachable — both modes assign a run before the pump starts.
          return c.json({ error: 'Failed to start generation' }, 500);
        }

        // ── Stream NDJSON: this response is just the run's first subscriber ──
        const subscribedRun: ChatRun = run;
        c.header('Content-Type', 'application/x-ndjson');
        c.header('Cache-Control', 'no-cache');
        // Tell nginx not to buffer this response, so a keepalive ping (and every delta)
        // reaches the browser when it is written rather than when a buffer happens to fill.
        c.header('X-Accel-Buffering', 'no');
        if (sessionId) {
          c.header('X-Session-Id', sessionId);
        }

        return honoStream(c, (stream) => streamRunToResponse(subscribedRun, stream, -1));
      })

      // ── GET /api/chat/runs — all in-flight runs owned by the caller ──
      .get('/runs', (c) => {
        const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!authUser) return c.json({ error: 'Authentication required' }, 401);
        if (authUser.role !== 'super' && authUser.role !== 'team') {
          return c.json({ error: 'Internal account required' }, 403);
        }
        const runs = chatRunRegistry.listActiveForUser(authUser.id).map((r) => ({
          session_id: r.sessionId as string,
          run_id: r.runId,
          started_at: r.startedAt,
          next_seq: r.nextSeq,
        }));
        return c.json({ runs });
      })

      // ── GET /api/chat/runs/:sessionId — probe a session's run state ──
      .get('/runs/:sessionId', async (c) => {
        const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!authUser) return c.json({ error: 'Authentication required' }, 401);
        const sessionId = c.req.param('sessionId');
        const session = await getDb().sessions.getById(sessionId);
        if (!session || !canWriteSession(authUser, session)) {
          return c.json({ error: 'Session not found' }, 404);
        }
        const run = chatRunRegistry.get(sessionId);
        if (!run) {
          return c.json({ active: false as const });
        }
        return c.json({
          active: run.status === 'running',
          run: {
            run_id: run.runId,
            status: run.status,
            started_at: run.startedAt,
            next_seq: run.nextSeq,
          },
        });
      })

      // ── GET /api/chat/runs/:sessionId/stream — reconnect: replay + live tail ──
      .get('/runs/:sessionId/stream', async (c) => {
        const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!authUser) return c.json({ error: 'Authentication required' }, 401);
        const sessionId = c.req.param('sessionId');
        const session = await getDb().sessions.getById(sessionId);
        if (!session || !canWriteSession(authUser, session)) {
          return c.json({ error: 'Session not found' }, 404);
        }
        const run = chatRunRegistry.get(sessionId);
        if (!run) {
          return c.json({ error: 'No generation to attach to for this session' }, 404);
        }
        const afterRaw = Number(c.req.query('after'));
        const afterSeq = Number.isFinite(afterRaw) ? afterRaw : -1;

        c.header('Content-Type', 'application/x-ndjson');
        c.header('Cache-Control', 'no-cache');
        c.header('X-Accel-Buffering', 'no');
        c.header('X-Session-Id', sessionId);

        return honoStream(c, (stream) => streamRunToResponse(run, stream, afterSeq));
      })

      // ── POST /api/chat/runs/:sessionId/stop — server-side stop ──
      .post('/runs/:sessionId/stop', async (c) => {
        const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!authUser) return c.json({ error: 'Authentication required' }, 401);
        const sessionId = c.req.param('sessionId');
        const activeRun = chatRunRegistry.getActive(sessionId);
        if (activeRun) {
          if (activeRun.userId !== authUser.id && authUser.role !== 'super') {
            return c.json({ error: 'Session not found' }, 404);
          }
          activeRun.requestStop('user');
          return c.json({ ok: true as const, run_id: activeRun.runId });
        }
        const session = await getDb().sessions.getById(sessionId);
        if (!session || !canWriteSession(authUser, session)) {
          return c.json({ error: 'Session not found' }, 404);
        }
        return c.json({ error: 'No active generation for this session' }, 404);
      })
  );
}

// ─── User Notes Injection ─────────────────────────────────

/** UI locales the assistant can be told to fall back to. Mirrors the web app's `Locale`. */
const LOCALE_DISPLAY_NAMES: Record<string, string> = {
  en: 'English',
  zh: 'Simplified Chinese (简体中文)',
};

async function buildSystemPromptWithUserNotes(
  profile: AgentProfile,
  hasTools: boolean,
  userId: string | null,
  ambientContext?: AmbientContextEnvelope,
  sessionId?: string,
): Promise<string> {
  let userInfo: string | undefined;
  let userLocale: string | undefined;

  if (userId) {
    try {
      const user = await getDb().users.getById(userId);
      userLocale = user?.locale ?? undefined;
      if (user?.notes) {
        const sanitizedNotes = sanitizeForPrompt(user.notes);
        const notesHint = `User "${user.nickname}" has set the following preferences — adhere to them:\n${sanitizedNotes}`;
        userInfo = userInfo ? `${userInfo}\n\n${notesHint}` : notesHint;
      }
    } catch {
      /* ignore */
    }

    // Memory index (feature-gated inside resolveMemoryContext, which also
    // sanitises — memory text is model-written and user-editable).
    const memoryBlock = await resolveMemoryContext(userId, undefined, { sessionId });
    if (memoryBlock) userInfo = userInfo ? `${userInfo}\n${memoryBlock}` : memoryBlock;
  }

  let prompt = buildSystemPrompt(profile, userInfo ? { userInfo } : undefined);
  if (hasTools) {
    prompt += `\n\n## Tool Guidance\nUse your available tools proactively when they are relevant to the user's request.`;
  }

  // Response language — the UI locale is a TIE-BREAKER, not a mandate. `users.locale`
  // defaults to 'en' for everyone who never opened Settings, so a hard "always answer
  // in English" would flip the whole team's existing Chinese threads.
  const localeName = LOCALE_DISPLAY_NAMES[userLocale ?? ''];
  if (localeName) {
    prompt +=
      `\n\n## Response Language\n` +
      `Reply in the same language the user writes in. When that is unclear ` +
      `(e.g. the opening turn, or a message with no language signal), default to ` +
      `${localeName} — it is the user's interface language.`;
  }

  if (ambientContext) {
    prompt += formatAmbientContextPrompt(ambientContext);
  }

  return prompt;
}
