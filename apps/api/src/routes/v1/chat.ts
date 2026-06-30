/**
 * 外部 API 对话端点 — /api/v1/chat/completions
 *
 * POST /api/v1/chat/completions — OpenAI 兼容的流式/非流式对话
 *
 * 认证：Authorization: Bearer <api_key>
 * 限流：per API Key (RPM + RPD + daily token limit)
 * 审计：每次调用写入 api_audit_log
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { stream as honoStream } from 'hono/streaming';
import { getDb } from '@greenhouse/db';
import { selectTools, buildSystemPrompt } from '../../agent.js';
import type { ToolRegistry } from '../../agent.js';
import { resolveProfile } from '../../profile.js';
import { sanitizeForPrompt } from '../../security.js';
import { getApiClient, getClientIP } from '../../auth/api-key.js';
import {
  parseSessionContext,
  readSessionContext,
  renderSessionContext,
  writeSessionContext,
} from '../../session-context.js';
import type { SessionContext } from '../../session-context.js';
import type { ApiClientRow } from '@greenhouse/db';
import {
  createChatStreamAsync,
  createCollectors,
  processStreamPart,
  summarizeOutput,
  buildEngineResult,
} from '@greenhouse/agent-core';
import { persistChatResult } from '../../chat-persist.js';
import { generateSessionTitle } from '../../llm/title.js';
import type { AppEnv } from '../../app-env.js';

// ─── Types ───────────────────────────────────────────────

interface V1ChatRequest {
  // OpenAI standard fields
  model?: string;
  messages?: Array<{
    role: string;
    content: string;
    /** 多模态：图片旁挂（Greenhouse 扩展，§6）。url 或上传 id，交由 analyze_image 处理 */
    images?: Array<{ url?: string; id?: string }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;

  // Greenhouse extensions
  greenhouse?: {
    session_id?: string | null;
    /** Structured session context (role, locale, timezone, notes, attributes) — validated & injected into the prompt. */
    context?: unknown;
    meta?: {
      user_id?: string;
      locale?: string;
      [key: string]: unknown;
    };
  };
}

// ─── ID Generator ────────────────────────────────────────

function generateCompletionId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = 'chatcmpl-';
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// ─── OpenAI Error Format ─────────────────────────────────

function openaiError(
  message: string,
  type: 'auth_error' | 'invalid_request_error' | 'rate_limit_error' | 'server_error' | 'not_found_error',
  code?: string,
) {
  return { error: { message, type, code: code ?? type } };
}

// ─── Route Factory ───────────────────────────────────────

export function createV1ChatRoute(toolRegistry: ToolRegistry) {
  const chat = new Hono<AppEnv>().post('/', async (c) => {
    const startTime = Date.now();
    const client = getApiClient(c);
    const clientIP = getClientIP(c);
    const appId = client.app_id;
    const completionId = generateCompletionId();
    const created = Math.floor(Date.now() / 1000);

    // ── Parse body ──
    let body: V1ChatRequest;
    try {
      body = (await c.req.json()) as V1ChatRequest;
    } catch {
      return c.json(openaiError('Invalid JSON body', 'invalid_request_error'), 400);
    }

    const meta = body.greenhouse?.meta ?? {};
    const extUserId = (meta.user_id as string) ?? null;

    // Structured session context from the caller — validated (whitelisted keys, length-clamped)
    let callerContext: SessionContext | null = null;
    if (body.greenhouse?.context !== undefined && body.greenhouse.context !== null) {
      const parsed = parseSessionContext(body.greenhouse.context, 'app');
      if (!parsed.ok) {
        return c.json(openaiError(`Invalid context: ${parsed.error}`, 'invalid_request_error'), 400);
      }
      callerContext = parsed.context;
    }
    const isStream = body.stream !== false; // default true

    // ── Validate & clamp optional parameters ──
    const MAX_MESSAGES = 100;
    const MAX_TOKENS_CEILING = 16384;

    if (body.temperature !== undefined) {
      if (typeof body.temperature !== 'number' || body.temperature < 0 || body.temperature > 2) {
        return c.json(openaiError('temperature must be a number between 0 and 2', 'invalid_request_error'), 400);
      }
    }
    if (body.max_tokens !== undefined) {
      if (typeof body.max_tokens !== 'number' || body.max_tokens < 1) {
        return c.json(openaiError('max_tokens must be a positive integer', 'invalid_request_error'), 400);
      }
      body.max_tokens = Math.min(body.max_tokens, MAX_TOKENS_CEILING);
    }
    if (body.messages && body.messages.length > MAX_MESSAGES) {
      return c.json(
        openaiError(`messages array exceeds maximum of ${MAX_MESSAGES} items`, 'invalid_request_error'),
        400,
      );
    }

    // ── Profile: always use "default" (model field is ignored for now) ──
    const profileId = 'default';
    const allowedProfiles: string[] = JSON.parse(client.allowed_profiles);
    if (!allowedProfiles.includes(profileId)) {
      await recordAudit(client, null, extUserId, 403, Date.now() - startTime, meta, clientIP, 'Profile not allowed');
      return c.json(openaiError(`Profile "${profileId}" is not allowed for this API client`, 'auth_error'), 403);
    }

    // ── Daily token quota check ──
    try {
      const dailyTokens = await getDb().apiAudit.getDailyTokenUsage(appId);
      if (dailyTokens >= client.daily_token_limit) {
        await recordAudit(
          client,
          null,
          extUserId,
          429,
          Date.now() - startTime,
          meta,
          clientIP,
          'Daily token limit exceeded',
        );
        return c.json(openaiError('Daily token limit exceeded', 'rate_limit_error'), 429);
      }
    } catch {
      /* ignore quota check errors */
    }

    // ── Validate messages ──
    if (!body.messages?.length) {
      await recordAudit(client, null, extUserId, 400, Date.now() - startTime, meta, clientIP, 'No messages provided');
      return c.json(openaiError('messages is required and must be non-empty', 'invalid_request_error'), 400);
    }

    // Filter out system messages from external input (security: system prompt comes from profile only)
    const userMessages = body.messages.filter((m) => m.role !== 'system');
    if (userMessages.length === 0) {
      await recordAudit(
        client,
        null,
        extUserId,
        400,
        Date.now() - startTime,
        meta,
        clientIP,
        'No user/assistant messages',
      );
      return c.json(
        openaiError('messages must contain at least one user or assistant message', 'invalid_request_error'),
        400,
      );
    }

    // ── Session handling ──
    let sessionId = body.greenhouse?.session_id ?? null;
    let chatMessages: Array<{ role: string; content: string }>;
    let sessionMetadata = '{}';

    if (sessionId) {
      // ── Resume existing session ──
      const session = await getDb().sessions.getById(sessionId);
      if (!session) {
        await recordAudit(
          client,
          sessionId,
          extUserId,
          404,
          Date.now() - startTime,
          meta,
          clientIP,
          'Session not found',
        );
        return c.json(openaiError('Session not found', 'not_found_error'), 404);
      }
      if (session.app_id !== appId) {
        await recordAudit(
          client,
          sessionId,
          extUserId,
          403,
          Date.now() - startTime,
          meta,
          clientIP,
          'Session does not belong to this client',
        );
        return c.json(openaiError('Session does not belong to this API client', 'auth_error'), 403);
      }

      // Append the last user message
      const lastUserMsg = userMessages[userMessages.length - 1];
      if (lastUserMsg?.role === 'user') {
        const sanitizedContent = sanitizeForPrompt(lastUserMsg.content);
        await getDb().sessions.addMessage({
          session_id: sessionId,
          role: 'user',
          content: sanitizedContent,
        });
      }

      chatMessages = await getDb().sessions.buildChatMessages(sessionId);

      // Update metadata (legacy flat meta keys + structured context)
      sessionMetadata = session.metadata || '{}';
      if (Object.keys(meta).length > 0 || callerContext) {
        const existingMeta = JSON.parse(sessionMetadata);
        const mergedMeta = JSON.stringify({ ...existingMeta, ...meta });
        sessionMetadata = callerContext ? writeSessionContext(mergedMeta, callerContext) : mergedMeta;
        await getDb().sessions.update(sessionId, { metadata: sessionMetadata });
      }
    } else {
      // ── New session ──
      const firstUserMsg = userMessages.find((m) => m.role === 'user');

      const session = await getDb().sessions.create(undefined, profileId, undefined, appId);
      sessionId = session.id;

      // Fire-and-forget: async LLM title generation
      if (firstUserMsg) {
        generateSessionTitle(firstUserMsg.content)
          .then((title) => getDb().sessions.updateTitle(sessionId!, title))
          .catch(() => {
            // Fallback: truncated message
            const fallback = firstUserMsg.content
              .replace(/[\n\r]+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 50);
            getDb()
              .sessions.updateTitle(sessionId!, fallback)
              .catch(() => {});
          });
      }

      if (Object.keys(meta).length > 0 || callerContext) {
        sessionMetadata = writeSessionContext(JSON.stringify(meta), callerContext);
        await getDb().sessions.update(sessionId, { metadata: sessionMetadata });
      }

      // Save all user/assistant messages
      for (const msg of userMessages) {
        if (msg.role === 'user' || msg.role === 'assistant') {
          await getDb().sessions.addMessage({
            session_id: sessionId,
            role: msg.role as 'user' | 'assistant',
            content: msg.role === 'user' ? sanitizeForPrompt(msg.content) : msg.content,
          });
        }
      }

      chatMessages = await getDb().sessions.buildChatMessages(sessionId);
    }

    if (chatMessages.length === 0) {
      await recordAudit(
        client,
        sessionId,
        extUserId,
        400,
        Date.now() - startTime,
        meta,
        clientIP,
        'No messages to process',
      );
      return c.json(openaiError('No messages to process', 'invalid_request_error'), 400);
    }

    // ── Inject image hint (multimodal: images sidecar, §6) ──
    // 主模型为纯文本，图片走 analyze_image 旁路：只把 url/id 注入最后一条 user 消息，
    // 模型据此调用 analyze_image（该工具支持直接传 URL）。注入与内部 /api/chat 同形。
    const lastUserBody = userMessages[userMessages.length - 1] as {
      role: string;
      images?: Array<{ url?: string; id?: string }>;
    };
    const imageRefs = (lastUserBody?.images ?? []).map((im) => im.url ?? im.id).filter((v): v is string => !!v);
    if (imageRefs.length > 0) {
      const hint = `\n\n[Attached image(s): ${imageRefs.join(', ')}.]`;
      const lastChat = chatMessages[chatMessages.length - 1];
      if (lastChat?.role === 'user') lastChat.content += hint;
    }

    // ── Resolve profile ──
    let profile;
    try {
      profile = resolveProfile(profileId);
    } catch (err) {
      await recordAudit(
        client,
        sessionId,
        extUserId,
        400,
        Date.now() - startTime,
        meta,
        clientIP,
        `Invalid profile: ${err}`,
      );
      return c.json(
        openaiError(`Invalid profile: ${err instanceof Error ? err.message : err}`, 'invalid_request_error'),
        400,
      );
    }

    const tools = selectTools(toolRegistry, profile.tools);
    let systemPrompt = buildSystemPrompt(profile);
    const contextBlock = renderSessionContext(callerContext ?? readSessionContext(sessionMetadata));
    if (contextBlock) {
      systemPrompt += `\n\n${contextBlock}`;
    }

    // ── Create chat stream ──
    const {
      streamResult,
      startTime: engineStartTime,
      modelId,
    } = await createChatStreamAsync({
      profile,
      messages: chatMessages,
      tools,
      systemPrompt,
      sessionId: sessionId ?? undefined,
      temperatureOverride: body.temperature,
      maxTokensOverride: body.max_tokens,
    });

    const collectors = createCollectors();
    const finalSessionId = sessionId!;

    // ── Background save ──
    let resolveStreamLoop: () => void;
    const streamLoopDone = new Promise<void>((r) => {
      resolveStreamLoop = r;
    });

    const backgroundSave = (async () => {
      try {
        await streamLoopDone;
        const engineResult = await buildEngineResult(streamResult, collectors, engineStartTime);

        await persistChatResult({
          sessionId: finalSessionId,
          profileId,
          caller: 'api-v1',
          userId: appId,
          modelId,
          engineResult,
          streamCompleted: collectors.streamCompleted,
        });

        // v1-specific: record API audit log
        if (engineResult.usage.inputTokens || engineResult.usage.outputTokens) {
          recordAudit(
            client,
            finalSessionId,
            extUserId,
            200,
            engineResult.durationMs,
            meta,
            clientIP,
            undefined,
            engineResult.usage.inputTokens,
            engineResult.usage.outputTokens,
          ).catch(() => {});
        }
      } catch (err) {
        logger.error('[v1/chat] background save failed:', err);
        recordAudit(
          client,
          finalSessionId,
          extUserId,
          500,
          Date.now() - startTime,
          meta,
          clientIP,
          `Background save error: ${err}`,
        ).catch(() => {});
      }
    })();

    // ── Response: Streaming (SSE) ──
    if (isStream) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');
      c.header('X-Request-Id', completionId);
      c.header('X-Session-Id', finalSessionId);

      return honoStream(c, async (stream) => {
        try {
          // First chunk: role + session_id
          await writeSSE(stream, {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: profileId,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
            greenhouse: { session_id: finalSessionId },
          });

          let toolCallIndex = 0;

          for await (const part of streamResult.fullStream) {
            processStreamPart(part, collectors);

            switch (part.type) {
              case 'text-delta':
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [{ index: 0, delta: { content: part.text }, finish_reason: null }],
                });
                break;

              case 'tool-input-start':
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolCallIndex,
                            id: part.id,
                            type: 'function',
                            function: { name: part.toolName, arguments: '' },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
                break;

              case 'tool-input-delta':
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        tool_calls: [
                          {
                            index: toolCallIndex,
                            function: { arguments: part.delta },
                          },
                        ],
                      },
                      finish_reason: null,
                    },
                  ],
                });
                break;

              case 'tool-input-end':
                toolCallIndex++;
                break;

              case 'tool-result': {
                const toolOutput = part.output as Record<string, unknown>;
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [{ index: 0, delta: {}, finish_reason: null }],
                  greenhouse: {
                    tool_result: {
                      name: part.toolName,
                      output: summarizeOutput(part.toolName, toolOutput),
                    },
                  },
                });
                break;
              }

              case 'finish-step':
                if (part.finishReason === 'tool-calls') {
                  await writeSSE(stream, {
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: profileId,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                  });
                  // Reset tool call index for next step
                  toolCallIndex = 0;
                }
                break;

              case 'finish':
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  usage: {
                    prompt_tokens: (part.totalUsage as any)?.inputTokens ?? 0,
                    completion_tokens: (part.totalUsage as any)?.outputTokens ?? 0,
                    total_tokens:
                      ((part.totalUsage as any)?.inputTokens ?? 0) + ((part.totalUsage as any)?.outputTokens ?? 0),
                  },
                  // §9.3-A：finish 块富化，供下游带内捕获全量镜像。
                  // references 供前端展示；reasoning/pipeline/usage_detail 供下游落库排错。
                  greenhouse: {
                    session_id: finalSessionId,
                    references: [...collectors.referencesMap.values()],
                    reasoning: collectors.reasoningText || undefined,
                    pipeline: collectors.pipelineSteps,
                    usage_detail: {
                      cached_tokens: (part.totalUsage as any)?.cachedInputTokens ?? 0,
                      reasoning_tokens: (part.totalUsage as any)?.reasoningTokens ?? 0,
                    },
                  },
                });
                break;

              case 'error':
                await writeSSE(stream, {
                  id: completionId,
                  object: 'chat.completion.chunk',
                  created,
                  model: profileId,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                  greenhouse: { error: String(part.error) },
                });
                break;

              default:
                break;
            }
          }

          // Send [DONE] marker
          await stream.write('data: [DONE]\n\n');
          collectors.streamCompleted = true;
        } catch (err: any) {
          if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            logger.info('[v1/chat] stream interrupted:', err?.message || err);
          }
        } finally {
          resolveStreamLoop!();
        }

        await backgroundSave;
      });
    }

    // ── Response: Non-streaming ──
    try {
      // Consume the full stream to collect results.
      let streamError: string | undefined;
      for await (const part of streamResult.fullStream) {
        processStreamPart(part, collectors);
        if (part.type === 'error') streamError = String(part.error);
      }
      collectors.streamCompleted = true;
      resolveStreamLoop!();

      const engineResult = await buildEngineResult(streamResult, collectors, engineStartTime);

      // Wait for background save to complete
      await backgroundSave;

      c.header('X-Request-Id', completionId);
      c.header('X-Session-Id', finalSessionId);

      return c.json({
        id: completionId,
        object: 'chat.completion',
        created,
        model: profileId,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: engineResult.text,
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: engineResult.usage.inputTokens,
          completion_tokens: engineResult.usage.outputTokens,
          total_tokens: engineResult.usage.inputTokens + engineResult.usage.outputTokens,
        },
        greenhouse: {
          session_id: finalSessionId,
          references: engineResult.references,
          // 与 SSE finish 块（§9.3-A）对齐：流式/非流式返回同样的富化元数据。
          // references 供前端展示；reasoning/pipeline/usage_detail 供下游镜像/排错。
          reasoning: engineResult.reasoningText || undefined,
          pipeline: engineResult.pipelineSteps,
          usage_detail: {
            cached_tokens: engineResult.usage.cachedInputTokens,
            reasoning_tokens: engineResult.usage.reasoningTokens,
          },
          ...(streamError ? { error: streamError } : {}),
        },
      });
    } catch (err) {
      resolveStreamLoop!();
      await backgroundSave;
      logger.error('[v1/chat] non-stream error:', err);
      return c.json(openaiError('Internal server error', 'server_error'), 500);
    }
  });

  return chat;
}

// ─── SSE Helper ──────────────────────────────────────────

async function writeSSE(stream: any, data: Record<string, unknown>): Promise<void> {
  await stream.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Audit Helper ────────────────────────────────────────

async function recordAudit(
  client: ApiClientRow,
  sessionId: string | null,
  extUserId: string | null,
  statusCode: number,
  durationMs: number,
  meta: Record<string, unknown>,
  ip: string,
  error?: string,
  inputTokens?: number,
  outputTokens?: number,
): Promise<void> {
  try {
    await getDb().apiAudit.record({
      app_id: client.app_id,
      endpoint: '/api/v1/chat/completions',
      method: 'POST',
      session_id: sessionId ?? undefined,
      ext_user_id: extUserId ?? undefined,
      status_code: statusCode,
      duration_ms: durationMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      meta,
      ip_address: ip,
      error,
    });
  } catch (err) {
    logger.error('[v1/audit] Failed to record audit:', err);
  }
}
