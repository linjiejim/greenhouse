import { ProviderRequestError } from '@greenhouse/providers';
import type { SaveMediaInput } from '@greenhouse/contract';
/** Generated media are artifacts. Video submissions and polls use the one jobs queue. */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, jobs, members, messages, newId, runs, transaction, type JobRow, type Run } from '@greenhouse/db';
import { ApiError, conflict, forbidden, invalidInput } from '../../http/errors.js';
import { enqueueJob, type JobOutcome } from '../../jobs.js';
import { RUN_REPORT_JOB } from '../../engine/background.js';
import type { ToolContext } from '../../engine/tools/define.js';
import { toMessage, type ConversationsService } from '../conversations/service.js';
import type { FilesService } from '../files/service.js';
import { sniffImage } from '../files/service.js';
import type { KnowledgeService } from '../knowledge/service.js';
import type { ProvidersService } from '../../providers/service.js';
import type { Hub } from '../../realtime/hub.js';

export const imageInput = z.object({
  prompt: z.string().min(1).max(4000),
  size: z.enum(['auto', '1024x1024', '1536x1024', '1024x1536']).optional(),
  reference_file_id: z.string().max(100).optional(),
});
export const videoInput = z.object({
  prompt: z.string().min(1).max(4000),
  seconds: z.union([z.literal(4), z.literal(8), z.literal(12)]).default(4),
  size: z.enum(['1280x720', '720x1280', '1792x1024', '1024x1792']).optional(),
});
const POLL_MS = 5000;
const DEADLINE_MS = 20 * 60_000;
const usage = (ctx: ToolContext) => ({
  memberId: ctx.memberId,
  agentId: ctx.agent.id,
  conversationId: ctx.conversation?.id,
  runId: ctx.runId,
  personal: ctx.agent.ownerId === ctx.memberId,
});

export function createMediaService(deps: {
  providers: ProvidersService;
  files: FilesService;
  knowledge: KnowledgeService;
  conversations: ConversationsService;
  hub: Hub;
}) {
  function announce(run: Run) {
    deps.hub.publish([run.ownerId], {
      type: 'run.updated',
      data: { run_id: run.id, status: run.status, conversation_id: run.conversationId },
    });
  }
  async function held(job: JobRow) {
    const [lease] = await getDb()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, job.id),
          eq(jobs.status, 'claimed'),
          eq(jobs.leaseOwner, job.leaseOwner!),
          sql`${jobs.leaseExpiresAt} > now()`,
        ),
      )
      .for('update');
    return !!lease;
  }
  async function settleRun(job: JobRow, run: Run, changes: Partial<Run>, poll?: number) {
    return transaction(async (db) => {
      if (!(await held(job))) return false;
      const [current] = await db.select().from(runs).where(eq(runs.id, run.id)).for('update');
      if (!current || ['succeeded', 'failed', 'canceled'].includes(current.status)) return false;
      const canceled = current.desiredState === 'cancel';
      const final = canceled || ['succeeded', 'failed', 'canceled'].includes(changes.status ?? '');
      const [saved] = await db
        .update(runs)
        .set({
          ...changes,
          ...(canceled ? { status: 'canceled', output: null } : {}),
          ...(final ? { finishedAt: sql`now()` } : {}),
          updatedAt: sql`now()`,
        })
        .where(eq(runs.id, run.id))
        .returning();
      if (final)
        await enqueueJob({
          kind: RUN_REPORT_JOB,
          dedupeKey: `run-report:${run.id}:${run.attempt}`,
          payload: { run_id: run.id, attempt: run.attempt },
        });
      else if (poll !== undefined)
        await enqueueJob({
          kind: 'media_video',
          dedupeKey: `video:${run.id}:${poll}`,
          payload: { run_id: run.id, poll },
          delayMs: POLL_MS,
        });
      announce(saved!);
      return !canceled;
    });
  }
  const service = {
    async image(ctx: ToolContext, input: z.infer<typeof imageInput>) {
      if (!ctx.conversation || ctx.surface !== 'turn') throw forbidden('Images are generated in a conversation.');
      await deps.conversations.access(ctx.memberId, ctx.conversation.id);
      const reference = input.reference_file_id ? await deps.files.bytes(ctx.memberId, input.reference_file_id) : null;
      if (reference && (!sniffImage(reference.bytes) || reference.bytes.byteLength > 10 * 1024 * 1024))
        throw invalidInput('Use a reference image up to 10 MB.');
      const provider = await deps.providers.resolve('image', usage(ctx));
      if (!provider) throw new ApiError(503, 'image_not_configured', 'No image service is set up.');
      const result = await provider.client.generate({
        prompt: input.prompt,
        size: input.size,
        n: 1,
        ...(reference ? { reference: { data: reference.bytes, mimeType: sniffImage(reference.bytes)! } } : {}),
      });
      if (ctx.signal.aborted) throw conflict('stopped', 'Generation was stopped.');
      const ids: string[] = [];
      for (const image of result.images.slice(0, 1)) {
        const type = sniffImage(image.data);
        if (!type) throw invalidInput('The image service returned invalid bytes.');
        const file = await deps.files.store(ctx.memberId, {
          name: `image-${ids.length + 1}.${type === 'image/jpeg' ? 'jpg' : type.split('/')[1]}`,
          bytes: image.data,
          contentType: type,
          purpose: 'artifact',
          conversationId: ctx.conversation.id,
          runId: ctx.runId,
        });
        ids.push(file.id);
      }
      const saved = await transaction(async (db) => {
        const [active] = await db
          .select({ id: runs.id })
          .from(runs)
          .where(and(eq(runs.id, ctx.runId), eq(runs.desiredState, 'run')))
          .for('update');
        if (!active) return null;
        const [reply] = await db
          .select()
          .from(messages)
          .where(and(eq(messages.runId, ctx.runId), eq(messages.role, 'assistant'), eq(messages.status, 'streaming')))
          .orderBy(desc(messages.seq))
          .limit(1)
          .for('update');
        if (!reply) return null;
        const [changed] = await db
          .update(messages)
          .set({ attachments: [...reply.attachments, ...ids] })
          .where(eq(messages.id, reply.id))
          .returning();
        return changed!;
      });
      if (!saved) {
        for (const id of ids) await deps.files.discard(id);
        throw conflict('stopped', 'Generation was stopped.');
      }
      if (saved)
        await deps.conversations.publish(ctx.conversation.id, {
          type: 'message.updated',
          data: { message: toMessage(saved) },
        });
      return {
        file_ids: ids,
        note: 'The artifacts are already shown as result cards. Briefly describe the result; never print file ids, attachment markers or invented download URLs.',
      };
    },
    async video(ctx: ToolContext, input: z.infer<typeof videoInput>) {
      if (!ctx.approved || !ctx.conversation || ctx.surface !== 'turn')
        throw forbidden('Video generation requires the member’s approval.');
      await deps.conversations.access(ctx.memberId, ctx.conversation.id);
      const provider = await deps.providers.resolve('video', usage(ctx));
      if (!provider) throw new ApiError(503, 'video_not_configured', 'No video service is set up.');
      const run = await transaction(async (db) => {
        // The member lock serializes admission across processes.
        await db.select({ id: members.id }).from(members).where(eq(members.id, ctx.memberId)).for('update');
        const active = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.ownerId, ctx.memberId),
              eq(runs.kind, 'background'),
              inArray(runs.status, ['queued', 'running', 'waiting']),
            ),
          )
          .limit(3);
        if (active.length >= 3) throw conflict('run_limit', 'Up to three background runs may be active.');
        const [created] = await db
          .insert(runs)
          .values({
            id: newId('run'),
            agentId: ctx.agent.id,
            ownerId: ctx.memberId,
            requestedBy: ctx.memberId,
            kind: 'background',
            source: 'conversation',
            sourceId: ctx.stepId,
            conversationId: ctx.conversation!.id,
            title: ctx.locale === 'zh' ? '生成视频' : 'Generate video',
            status: 'queued',
            attempt: 1,
            deadlineAt: new Date(Date.now() + DEADLINE_MS).toISOString(),
            input: { media: 'video', provider_id: provider.instance.id, ...input },
          })
          .returning();
        await enqueueJob({
          kind: 'media_video',
          dedupeKey: `video:${created!.id}:0`,
          payload: { run_id: created!.id, poll: 0 },
        });
        return created!;
      });
      announce(run);
      return {
        run_id: run.id,
        status: run.status,
        note: 'Video generation is queued. Progress appears in Runs; completion will report here.',
      };
    },
    async save(memberId: string, fileId: string, input: SaveMediaInput) {
      const { row, bytes } = await deps.files.bytes(memberId, fileId);
      if (row.purpose !== 'artifact') throw invalidInput('Only generated artifacts can be saved here.');
      return deps.knowledge.upload(memberId, {
        name: row.name,
        contentType: row.contentType,
        bytes,
        space: input.space ?? 'personal',
        folderId: input.folder_id,
      });
    },
    async cancel(memberId: string, runId: string) {
      await transaction(async (db) => {
        const [run] = await db
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.ownerId, memberId)))
          .for('update');
        if (!run || run.input.media !== 'video' || ['succeeded', 'failed', 'canceled'].includes(run.status)) return;
        await db
          .update(runs)
          .set({ desiredState: 'cancel', status: 'canceled', finishedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(runs.id, run.id));
        await enqueueJob({
          kind: RUN_REPORT_JOB,
          dedupeKey: `run-report:${run.id}:${run.attempt}`,
          payload: { run_id: run.id, attempt: run.attempt },
        });
        announce({ ...run, status: 'canceled' });
      });
    },
    async sweep() {
      await transaction(async (db) => {
        const stranded = await db
          .select()
          .from(runs)
          .where(
            and(
              sql`${runs.input}->>'media' = 'video'`,
              inArray(runs.status, ['queued', 'running']),
              sql`(${runs.deadlineAt} < now() OR EXISTS (select 1 from jobs j where j.kind = 'media_video' and j.payload->>'run_id' = ${runs.id} and j.status = 'dead'))`,
            ),
          )
          .limit(20)
          .for('update', { skipLocked: true });
        for (const run of stranded) {
          await db
            .update(runs)
            .set({
              status: 'failed',
              errorCode: 'video_worker_failed',
              errorMessage: 'Video work stopped before completion. Check the video service before generating again.',
              finishedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(eq(runs.id, run.id));
          await enqueueJob({
            kind: RUN_REPORT_JOB,
            dedupeKey: `run-report:${run.id}:${run.attempt}`,
            payload: { run_id: run.id, attempt: run.attempt },
          });
          announce({ ...run, status: 'failed' });
        }
      });
    },
    async handle(job: JobRow): Promise<JobOutcome> {
      const [run] = await getDb()
        .select()
        .from(runs)
        .where(eq(runs.id, String(job.payload.run_id)));
      if (!run || run.input.media !== 'video' || ['succeeded', 'failed', 'canceled'].includes(run.status))
        return { status: 'succeeded' };
      let submitting = false;
      try {
        if (run.desiredState === 'cancel') {
          await settleRun(job, run, { status: 'canceled' });
          return { status: 'succeeded' };
        }
        const [member] = await getDb()
          .select({ status: members.status })
          .from(members)
          .where(eq(members.id, run.ownerId));
        if (member?.status !== 'active') throw forbidden('The member is no longer active.');
        await deps.conversations.access(run.ownerId, run.conversationId!);
        if (Date.now() > Date.parse(run.deadlineAt!))
          throw new ApiError(504, 'video_timeout', 'Video generation took too long.');
        const poll = Number(job.payload.poll);
        const checkpoint = run.checkpoint ?? {};
        if (typeof checkpoint.poll === 'number' && checkpoint.poll !== poll) return { status: 'succeeded' };
        const candidates = await deps.providers.chain('video', {
          memberId: run.ownerId,
          agentId: run.agentId,
          runId: run.id,
          conversationId: run.conversationId!,
        });
        const provider = candidates.find((candidate) => candidate.instance.id === run.input.provider_id);
        if (!provider) throw new ApiError(503, 'video_not_configured', 'The video service is unavailable.');
        let state;
        if (typeof checkpoint.video_id !== 'string') {
          if (checkpoint.submitting)
            throw new ApiError(
              409,
              'video_submission_uncertain',
              'The earlier submission may have succeeded. It will not be submitted again.',
            );
          if (
            !(await settleRun(job, run, {
              status: 'running',
              startedAt: new Date().toISOString(),
              checkpoint: { submitting: true, poll },
            }))
          )
            return { status: 'suppressed' };
          submitting = true;
          state = await provider.client.create(videoInput.parse(run.input));
        } else state = await provider.client.retrieve(checkpoint.video_id);
        if (state.status === 'failed')
          throw new ApiError(502, 'video_failed', 'The video service could not complete the video.');
        if (state.status === 'completed') {
          const content = await provider.client.content(state.id);
          const file = await deps.files.store(run.ownerId, {
            name: 'video.mp4',
            bytes: content.data,
            contentType: content.mimeType,
            purpose: 'artifact',
            conversationId: run.conversationId,
            runId: run.id,
          });
          const kept = await settleRun(job, run, {
            status: 'succeeded',
            checkpoint: { video_id: state.id, progress: 100 },
            output: { text: 'Video ready.', file_ids: [file.id], findings: ['video'] },
          });
          if (!kept) await deps.files.discard(file.id);
        } else
          await settleRun(
            job,
            run,
            { status: 'running', checkpoint: { video_id: state.id, progress: state.progress, poll: poll + 1 } },
            poll + 1,
          );
        return { status: 'succeeded' };
      } catch (error) {
        const refused =
          error instanceof ProviderRequestError &&
          error.statusCode !== undefined &&
          error.statusCode >= 400 &&
          error.statusCode < 500;
        const code =
          submitting && !refused
            ? 'video_submission_uncertain'
            : error instanceof ApiError
              ? error.code
              : 'video_failed';
        await settleRun(job, run, {
          status: 'failed',
          errorCode: code,
          errorMessage:
            code === 'video_submission_uncertain'
              ? 'Submission result unknown; check the video service before generating again.'
              : error instanceof ProviderRequestError
                ? error.message.slice(0, 500)
                : 'Video generation failed. Check the configured service.',
        });
        return { status: 'dead', error: code };
      }
    },
  };
  return service;
}
export type MediaService = ReturnType<typeof createMediaService>;
