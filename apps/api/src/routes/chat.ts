/**
 * Chat route — /api/chat
 *
 * POST /api/chat — 核心对话接口，NDJSON流式返回Agent响应（支持会话模式和无状态模式）
 */

import { Hono } from 'hono';
import { logger } from '@greenhouse/utils/logger';
import { stream as honoStream } from 'hono/streaming';
import { getDb } from '@greenhouse/db';
import { selectTools, buildSystemPrompt } from '../agent.js';
import type { AgentContext, ToolRegistry } from '../agent.js';
import { LAZY_TOOL_IDS, resolveEffectiveTools, buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import { createLocalToolBridge } from '../tools/local/bridge.js';
import type { LocalToolBridge } from '../tools/local/bridge.js';
import { sanitizeClientActions, createClientActionTools } from '../tools/client-actions.js';
import type { ClientActionDescriptor } from '@greenhouse/types/api';
import { normalizeProfileId, resolveProfileAsync } from '../profile.js';
import { validateProfileAccess, sanitizeForPrompt } from '../security.js';
import type { AuthUser } from '../auth/token.js';
import type { AgentProfile } from '../profile.js';
import type { AppEnv } from '../app-env.js';
import {
  createChatStreamAsync,
  createCollectors,
  processStreamPart,
  buildEngineResult,
  resolveModelChoice,
} from '@greenhouse/agent-core';
import { persistChatResult } from '../chat-persist.js';
import { generateSessionTitle } from '../llm/title.js';
import { readSessionContext, renderSessionContext } from '../session-context.js';

interface LocalSkillIndexItem {
  slug: string;
  name: string;
  description?: string;
  source?: string;
  version?: string;
  globs?: string[];
}

// ─── Route Factory ───────────────────────────────────────

export function createChatRoute(toolRegistry: ToolRegistry) {
  /**
   * POST /api/chat
   * Body: { session_id?: string, messages: Message[], context?: AgentContext, profile_id?: string }
   *
   * Returns: NDJSON stream
   */
  return new Hono<AppEnv>().post('/', async (c) => {
    const body = (await c.req.json()) as {
      session_id?: string;
      messages?: Array<{ role: string; content: string; images?: Array<{ id: string; url: string }> }>;
      context?: AgentContext;
      context_hint?: string; // frontend-generated page context description (from agent panel)
      profile_id?: string;
      model_override?: string;
      workspace_id?: string; // active workspace for per-user proxy
      local_skill_index?: LocalSkillIndexItem[]; // Desktop-provided local skill metadata only
      client_actions?: ClientActionDescriptor[]; // frontend UI actions available on the current screen
    };

    const { context } = body;
    const sessionId = body.session_id;
    let chatMessages: Array<{ role: string; content: string }>;
    let profileId = body.profile_id || 'default';

    // Get authenticated user
    const authUser = (c.get as (key: string) => AuthUser | undefined)('user');
    const userId = authUser?.id ?? null;
    const userRole = authUser?.role ?? 'external';

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
      if (userRole === 'external' && profile.access.level !== 'public') {
        return { allowed: false, error: `Profile "${requestedId}" is not available for external users` };
      }
      if (userRole !== 'super' && profile.access.level === 'hidden') {
        return { allowed: false, error: `Profile "${requestedId}" is not available` };
      }
      return { allowed: true };
    };

    const earlyAccess = checkCloudProfileAccess(earlyProfile, profileId);
    if (!earlyAccess.allowed) {
      return c.json({ error: earlyAccess.error }, 403);
    }

    if (profileId.startsWith('custom:')) {
      const customId = parseInt(profileId.slice(7), 10);
      if (isNaN(customId)) {
        return c.json({ error: 'Invalid custom profile ID' }, 400);
      }
      const customRow = await getDb().customProfiles.getById(customId);
      if (!customRow) {
        return c.json({ error: 'Custom profile not found' }, 404);
      }
      if (customRow.user_id !== userId && !customRow.is_shared && userRole !== 'super') {
        return c.json({ error: 'You do not have access to this custom profile' }, 403);
      }
    }

    // ── Quota check for internal users ──
    if (userId && userId !== 'external' && userId !== 'dev' && userId !== 'legacy') {
      const user = await getDb().users.getById(userId);
      if (user) {
        try {
          const msgCount = await getDb().usage.countTodayMessages(userId);
          if (msgCount >= user.daily_message_limit) {
            return c.json({ error: '已达到每日消息上限，请明天再试' }, 429);
          }

          const tokenTotal = await getDb().usage.sumMonthTokens(userId);
          if (tokenTotal >= user.monthly_token_limit) {
            return c.json({ error: '已达到每月 token 上限，请联系管理员' }, 429);
          }
        } catch {
          /* ignore quota check errors */
        }
      }
    }

    let titlePromise: Promise<string> | null = null;
    // Structured session context (device/grower/plants...) — set in session mode below.
    let sessionContextBlock = '';

    // ── External users: stateless only ──
    if (userRole === 'external' && sessionId) {
      return c.json({ error: 'External users cannot use session mode' }, 403);
    }

    if (sessionId) {
      // ── Session mode: load history + append new user message ──
      const session = await getDb().sessions.getById(sessionId);
      if (!session) {
        return c.json({ error: 'Session not found' }, 404);
      }

      profileId = normalizeProfileId(session.profile_id) || 'default';
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

      if (body.messages?.length) {
        const lastUserMsg = body.messages[body.messages.length - 1];
        if (lastUserMsg.role === 'user') {
          const sanitizedContent = sanitizeForPrompt(lastUserMsg.content);
          await getDb().sessions.addMessage({
            session_id: sessionId,
            role: 'user',
            content: sanitizedContent,
            images: lastUserMsg.images,
          });
        }
      }

      chatMessages = await getDb().sessions.buildChatMessages(sessionId);

      // Caller/admin-provided session context → rendered into the system prompt.
      sessionContextBlock = renderSessionContext(readSessionContext(session.metadata));

      // ── Auto-title: async LLM generation (fire-and-forget) ──
      // The titlePromise resolves with a generated title; the streaming loop
      // will inject a 'title' event once it's ready.
      if (!session.title) {
        const firstUser = chatMessages.find((m) => m.role === 'user');
        if (firstUser) {
          titlePromise = generateSessionTitle(firstUser.content)
            .then(async (title) => {
              await getDb().sessions.updateTitle(sessionId!, title);
              return title;
            })
            .catch(async (err) => {
              logger.warn('[chat] LLM title generation failed, using fallback:', err);
              const fallback = firstUser.content
                .replace(/[\n\r]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 50);
              await getDb()
                .sessions.updateTitle(sessionId!, fallback)
                .catch(() => {});
              return fallback;
            });
        }
      }
    } else if (body.messages?.length) {
      // ── Stateless mode ──
      const accessCheck = validateProfileAccess(profileId, false);
      if (!accessCheck.allowed) {
        return c.json({ error: accessCheck.reason }, 403);
      }
      chatMessages = body.messages;
    } else {
      return c.json({ error: 'Either session_id or messages is required' }, 400);
    }

    if (chatMessages.length === 0) {
      return c.json({ error: 'No messages to process' }, 400);
    }

    // ── Inject image analysis hint if user attached images ──
    const lastUserBody = body.messages?.[body.messages.length - 1];
    const imageIds = lastUserBody?.images?.map((img) => img.id) ?? [];

    if (imageIds.length > 0) {
      // The main LLM never receives the image bytes — only the IDs, which it must
      // pass to analyze_image. So we inject the IDs (data the model can't get any
      // other way). The "you MUST call analyze_image" instruction is NOT repeated
      // here: it already lives in the analyze_image tool description (registry.ts).
      const imageHint = `\n\n[Attached image ID(s): ${imageIds.join(', ')}.]`;
      const lastChat = chatMessages[chatMessages.length - 1];
      if (lastChat?.role === 'user') {
        lastChat.content += imageHint;
      }
    }

    // ── Resolve profile → model, tools, prompt ──
    let profile: AgentProfile;
    try {
      profile = await resolveProfileAsync(profileId);
    } catch (err) {
      return c.json({ error: `Invalid profile: ${err instanceof Error ? err.message : err}` }, 400);
    }

    // ── Resolve user tools (decoupled from profile; shared with /api/agent) ──
    const { effectiveTools } = await resolveEffectiveTools({
      userId,
      userRole,
      profile,
      profileId,
    });

    const tools = selectTools(
      toolRegistry,
      effectiveTools.filter((t) => !LAZY_TOOL_IDS.has(t)),
    );

    // Inject per-request lazy server tools (feature_request, project_manager,
    // email_manager, personal_knowledge, session_history) — shared logic.
    Object.assign(
      tools,
      buildLazyServerTools(getDb(), effectiveTools, {
        userId,
        userRole,
        sessionId,
        profileId: profile.id,
        toolRegistry,
      }),
    );

    // Check memory feature gate (cached for prompt injection below)
    let memoryEnabled = false;
    if (userId && userId !== 'external') {
      try {
        memoryEnabled = await getDb().userFeatures.isEnabled(userId, 'memory');
      } catch {
        /* ignore */
      }
    }

    // ── Client-side tools: wire a bridge so execution round-trips to the client ──
    // Web client actions — declared by the frontend per turn (navigate/prefill/...).
    // The bridge emits `local-tool-request` and awaits the real result the client posts
    // back to /api/client-tools/result before the agent step continues.
    let localBridge: LocalToolBridge | null = null;
    const clientActions = userRole === 'external' ? [] : sanitizeClientActions(body.client_actions);
    const usesClientActions = clientActions.length > 0;
    if (usesClientActions && sessionId) {
      localBridge = createLocalToolBridge(sessionId);
      Object.assign(tools, createClientActionTools(clientActions, localBridge));
    }

    // Prompt-side tool guidance never lists tool names — the LLM already gets
    // full definitions via `tools[]`, and a prompt-side list can diverge from
    // the profile-narrowed set actually registered (leaking internal tool names
    // into public-profile sessions). We only nudge proactive use.
    let systemPrompt = await buildSystemPromptWithUserNotes(
      profile,
      Object.keys(tools).length > 0,
      context,
      userId,
      body.context_hint,
      memoryEnabled,
      body.local_skill_index,
    );

    if (sessionContextBlock) {
      systemPrompt += `\n\n${sessionContextBlock}`;
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

    // ── Create chat stream via shared engine ──
    const { streamResult, startTime, modelId } = await createChatStreamAsync({
      profile,
      messages: chatMessages,
      tools,
      systemPrompt,
      sessionId: sessionId ?? undefined,
      // Profile policy decides switchability: overrides only apply when the
      // profile declares model.choices (e.g. team). Pinned profiles (default,
      // desktop) ignore them — this also covers external users, who can only
      // reach choice-less public profiles.
      modelOverride: resolveModelChoice(profile.model, body.model_override),
    });

    // ── Collectors ──
    const collectors = createCollectors();

    // ── Background save ──
    let resolveStreamLoop: () => void;
    const streamLoopDone = new Promise<void>((r) => {
      resolveStreamLoop = r;
    });

    const backgroundSave = sessionId
      ? (async () => {
          try {
            await streamLoopDone;
            const engineResult = await buildEngineResult(streamResult, collectors, startTime);

            // Fallback: if stream was interrupted and collectors have nothing, try SDK steps
            if (engineResult.pipelineSteps.length === 0 && !collectors.streamCompleted) {
              try {
                const steps = await streamResult.steps;
                for (const step of steps) {
                  if (step.toolCalls) {
                    for (const tc of step.toolCalls as unknown as Array<{
                      toolCallId: string;
                      toolName: string;
                      input: unknown;
                    }>) {
                      engineResult.pipelineSteps.push({
                        step: engineResult.pipelineSteps.length,
                        tool: tc.toolName,
                        input: tc.input,
                        output: null,
                        duration_ms: 0,
                      });
                    }
                  }
                  if (step.toolResults) {
                    for (const tr of step.toolResults as unknown as Array<{
                      toolCallId: string;
                      toolName: string;
                      output: Record<string, unknown>;
                    }>) {
                      if (
                        (tr.toolName === 'knowledge_query' || tr.toolName === 'team_knowledge') &&
                        (tr.output as any)?.action === 'get' &&
                        tr.output &&
                        !(tr.output as any).error
                      ) {
                        const out = tr.output;
                        if (out.doc_id) {
                          engineResult.references.push({
                            slug: out.doc_id as string,
                            doc_id: out.doc_id as string,
                            title: (out.title as string) ?? '',
                            type: 'wiki',
                            category: (out.category as string) ?? undefined,
                          });
                        }
                      }
                    }
                  }
                }
              } catch {
                /* steps promise failed */
              }
            }

            if (engineResult.text) {
              if (!collectors.streamCompleted) {
                logger.info(`[chat] background save: client disconnected, persisting from SDK promises`);
              }
            }

            await persistChatResult({
              sessionId,
              profileId,
              caller: 'chat',
              userId: userId ?? 'anonymous',
              modelId,
              engineResult,
              streamCompleted: collectors.streamCompleted,
            });
          } catch (err) {
            logger.error('[chat] background save failed:', err);
          }
        })()
      : Promise.resolve();

    // ── Stream NDJSON ──
    c.header('Content-Type', 'application/x-ndjson');
    c.header('Cache-Control', 'no-cache');
    if (sessionId) {
      c.header('X-Session-Id', sessionId);
    }

    return honoStream(c, async (stream) => {
      // Serialize writes so the local-tool bridge (which writes from inside a tool's
      // execute()) can't interleave a partial line with the main stream loop.
      let writeChain: Promise<unknown> = Promise.resolve();
      const safeWrite = (obj: Record<string, unknown>): Promise<void> => {
        writeChain = writeChain.then(() => stream.write(JSON.stringify(obj) + '\n')).catch(() => {});
        return writeChain as Promise<void>;
      };

      // Let the local-tool bridge emit `local-tool-request` events to the client.
      // streamText is lazy, so execute() can't run before this is set.
      if (localBridge) {
        localBridge.setWriter(safeWrite);
      }

      // Track whether title event has been sent
      let titleSent = false;
      let resolvedTitle: string | null = null;

      // If we have a pending title promise, race it — when it resolves,
      // inject the title event at the next opportunity.
      if (titlePromise) {
        titlePromise
          .then((title) => {
            resolvedTitle = title;
          })
          .catch(() => {});
      }

      try {
        for await (const part of streamResult.fullStream) {
          // Check if title is ready and inject before other events
          if (resolvedTitle && !titleSent) {
            titleSent = true;
            await safeWrite({ type: 'title', title: resolvedTitle });
          }

          // Update collectors
          processStreamPart(part, collectors);

          // Emit NDJSON events (internal format — unchanged for Web/CLI)
          let event: Record<string, unknown> | null = null;

          switch (part.type) {
            case 'text-delta':
              event = { type: 'text-delta', text: part.text };
              break;

            case 'reasoning-delta':
              event = { type: 'reasoning-delta', text: part.text };
              break;

            case 'tool-input-start':
              event = { type: 'tool-call-start', id: part.id, toolName: part.toolName };
              break;

            case 'tool-input-delta':
              event = { type: 'tool-call-delta', id: part.id, delta: part.delta };
              break;

            case 'tool-input-end':
              event = { type: 'tool-call-end', id: part.id };
              break;

            case 'tool-call':
              event = { type: 'tool-call', id: part.toolCallId, toolName: part.toolName, input: part.input };
              break;

            case 'tool-result':
              event = {
                type: 'tool-result',
                id: part.toolCallId,
                toolName: part.toolName,
                output: part.output as Record<string, unknown>,
              };
              break;

            case 'start-step':
              event = { type: 'step-start' };
              break;

            case 'finish-step':
              event = { type: 'step-finish', finishReason: part.finishReason, usage: part.usage };
              break;

            case 'finish':
              event = { type: 'finish', finishReason: part.finishReason, totalUsage: part.totalUsage };
              break;

            case 'error':
              event = { type: 'error', error: String(part.error) };
              break;

            default:
              break;
          }

          if (event) {
            await safeWrite(event);
          }
          // Local-tool-request events are emitted by the bridge from inside the
          // tool's execute() (see createLocalToolBridge), not from this loop.
        }

        collectors.streamCompleted = true;

        // Emit title event if not yet sent (title gen finished after stream loop)
        if (!titleSent && titlePromise) {
          try {
            const title = await titlePromise;
            await safeWrite({ type: 'title', title });
          } catch {
            /* fallback already handled in promise */
          }
        }
      } catch (err: any) {
        if (err?.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          logger.info('[chat] stream interrupted:', err?.message || err);
        }
      } finally {
        resolveStreamLoop!();
      }

      await backgroundSave;
    });
  });
}

// ─── User Notes Injection ─────────────────────────────────

async function buildSystemPromptWithUserNotes(
  profile: AgentProfile,
  hasTools: boolean,
  context: AgentContext | undefined,
  userId: string | null,
  contextHint?: string,
  memoryEnabled?: boolean,
  localSkillIndex?: LocalSkillIndexItem[],
): Promise<string> {
  let userInfo = context?.userInfo;

  if (userId && userId !== 'external') {
    try {
      const user = await getDb().users.getById(userId);
      if (user?.notes) {
        const sanitizedNotes = sanitizeForPrompt(user.notes);
        const notesHint = `User "${user.nickname}" has set the following preferences — adhere to them:\n${sanitizedNotes}`;
        userInfo = userInfo ? `${userInfo}\n\n${notesHint}` : notesHint;
      }
    } catch {
      /* ignore */
    }

    // Inject user memories if feature is enabled
    if (memoryEnabled) {
      try {
        const { retrieveUserMemories } = await import('../llm/memory.js');
        const memoriesBlock = await retrieveUserMemories(userId!);
        if (memoriesBlock) {
          const memoryHint =
            `\n## User Memory\n` +
            `The following are learned facts about this user from previous conversations. ` +
            `Use them to personalize your responses — but don't explicitly mention that you "remember" these unless asked:\n` +
            memoriesBlock;
          userInfo = userInfo ? `${userInfo}\n${memoryHint}` : memoryHint;
        }
      } catch {
        /* ignore memory retrieval errors */
      }
    }
  }

  const enrichedContext = { ...context, userInfo };

  let prompt = buildSystemPrompt(profile, enrichedContext);
  if (hasTools) {
    prompt += `\n\n## Tool Guidance\nUse your available tools proactively when they are relevant to the user's request.`;
  }

  // Append page context hint from agent panel
  if (contextHint) {
    prompt += `\n\n## ${contextHint}\n`;
  }

  const localSkillsBlock = formatLocalSkillsPrompt(localSkillIndex);
  if (localSkillsBlock) {
    prompt += `\n\n${localSkillsBlock}`;
  }

  return prompt;
}

function formatLocalSkillsPrompt(skills?: LocalSkillIndexItem[]): string {
  if (!skills?.length) return '';

  const cleaned = skills
    .filter((skill) => typeof skill.slug === 'string' && typeof skill.name === 'string')
    .slice(0, 50)
    .map((skill) => {
      const slug = sanitizeForPrompt(skill.slug).slice(0, 128);
      const name = sanitizeForPrompt(skill.name).slice(0, 128);
      const description = sanitizeForPrompt(skill.description ?? '').slice(0, 500);
      const version = skill.version ? ` v${sanitizeForPrompt(skill.version).slice(0, 32)}` : '';
      const source = skill.source ? ` [${sanitizeForPrompt(skill.source).slice(0, 32)}]` : '';
      const globs =
        Array.isArray(skill.globs) && skill.globs.length > 0
          ? ` globs: ${skill.globs
              .slice(0, 5)
              .map((g) => sanitizeForPrompt(g).slice(0, 80))
              .join(', ')}`
          : '';
      return `- ${slug}: ${name}${version}${source}${description ? ` — ${description}` : ''}${globs}`;
    });

  if (cleaned.length === 0) return '';

  return (
    `## Available Local Skills\n` +
    `The Desktop client has discovered these local SKILL.md skills. ` +
    `Use local_skill_view({ slug }) to load a skill only when it is relevant to the current task. ` +
    `Do not assume a skill's full instructions until you have loaded it.\n` +
    cleaned.join('\n')
  );
}
