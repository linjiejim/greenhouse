import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { files, getDb, runSteps, usageEvents } from '@greenhouse/db';
import { scriptedModel, text, toolCall } from '../../../engine/__tests__/model.js';
import { createTestApp } from '../../../testing.js';

/**
 * 语音 through the providers: a recording to text, text to speech, each bounded, metered (STT in
 * seconds, measured from the recording when the service does not say; TTS in characters), and an
 * audio attachment transcribed once for the Agent.
 */

const STORAGE = () => ({ STORAGE_PROVIDER: 'local', STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-voice-')) });
const STT = {
  STT_PROVIDER: 'openai-compatible',
  STT_BASE_URL: 'https://stt.test/v1',
  STT_MODEL: 'whisper-1',
  STT_API_KEY: 'sk-stt-secret-0001',
};
const TTS = {
  TTS_PROVIDER: 'openai-compatible',
  TTS_BASE_URL: 'https://tts.test/v1',
  TTS_MODEL: 'tts-1',
  TTS_VOICE: 'alloy',
  TTS_API_KEY: 'sk-tts-secret-0001',
};

/** 2.5 s of a tone as Chrome's MediaRecorder writes it: WebM Opus without a duration. */
const recording = () =>
  new Uint8Array(
    readFileSync(new URL('../../../../../../packages/utils/src/__fixtures__/audio/tone-live.webm', import.meta.url)),
  );

/** A PCM WAV of `seconds` (8 kHz, 16-bit mono). */
function wav(seconds: number): Uint8Array {
  const data = Math.round(seconds * 8_000) * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const tag = (at: number, value: string) =>
    [...value].forEach((char, index) => (bytes[at + index] = char.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, data, true);
  return bytes;
}

/** The STT and TTS services: what they were sent, and what they answer. */
function services(answer: { text?: string; duration?: number; status?: number } = {}) {
  const sent: { url: string; headers: Headers; form?: FormData; json?: unknown }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === 'https://stt.test/v1/audio/transcriptions') {
      sent.push({ url, headers, form: init?.body as FormData });
      if (answer.status)
        return new Response(JSON.stringify({ error: { message: 'Invalid key sk-stt-secret-0001' } }), {
          status: answer.status,
        });
      return Response.json({
        text: answer.text ?? ' 帮我把本周进度整理成周报 ',
        ...(answer.duration === undefined ? {} : { duration: answer.duration }),
      });
    }
    if (url === 'https://tts.test/v1/audio/speech') {
      sent.push({ url, headers, json: JSON.parse(String(init?.body)) });
      if (answer.status) return new Response(JSON.stringify({ error: 'quota' }), { status: answer.status });
      return new Response(wav(0.5) as Uint8Array<ArrayBuffer>, { headers: { 'content-type': 'audio/wav' } });
    }
    return new Response('not here', { status: 404 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent, calls: fetch };
}

type App = ReturnType<typeof createTestApp>;

async function transcribe(app: App, token: string, bytes: Uint8Array, type: string, language?: string) {
  const form = new FormData();
  form.set('file', new File([bytes as Uint8Array<ArrayBuffer>], 'recording', { type }));
  if (language) form.set('language', language);
  const response = await app.app.request('/api/voice/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function speak(app: App, token: string, body: unknown) {
  const response = await app.app.request('/api/voice/speech', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response;
}

const usageOf = (memberId: string, capability: 'stt' | 'tts') =>
  getDb()
    .select()
    .from(usageEvents)
    .where(and(eq(usageEvents.memberId, memberId), eq(usageEvents.capability, capability)));

describe('voice', () => {
  it('turns a recording into text, with the seconds the service reports, else those the recording says', async () => {
    const reported = services({ duration: 2.4 });
    const app = createTestApp({ ...STORAGE(), ...STT }, { fetch: reported.fetch });
    const lin = await app.member();
    expect((await app.call('GET', '/api/me', { token: lin.token })).body.capabilities).toMatchObject({
      stt: true,
      tts: false,
    });

    const done = await transcribe(app, lin.token, recording(), 'audio/webm;codecs=opus', 'zh-CN');
    expect(done).toEqual({ status: 200, body: { text: '帮我把本周进度整理成周报', duration_seconds: 2.4 } });
    const [call] = reported.sent;
    // The key goes only to the service's own address, the language as ISO 639-1.
    expect(call!.headers.get('authorization')).toBe('Bearer sk-stt-secret-0001');
    expect(call!.form!.get('model')).toBe('whisper-1');
    expect(call!.form!.get('language')).toBe('zh');
    expect((call!.form!.get('file') as File).name).toBe('audio.webm');
    expect(await usageOf(lin.id, 'stt')).toEqual([
      expect.objectContaining({
        providerId: 'env-stt',
        source: 'env',
        unit: 'second',
        quantity: 2.4,
        model: 'whisper-1',
      }),
    ]);

    // A service that does not say how long it was: the recording's own length is recorded.
    const silent = services();
    const other = createTestApp({ ...STORAGE(), ...STT }, { fetch: silent.fetch });
    const chen = await other.member();
    const measured = await transcribe(other, chen.token, recording(), 'audio/webm');
    expect(measured.body.duration_seconds).toBeCloseTo(2.5, 1);
    const [row] = await usageOf(chen.id, 'stt');
    expect(row!.quantity).toBeCloseTo(2.5, 1);
  });

  it('bounds what it sends: audio only, at most 25 MB and 10 minutes, and none of it reaches the service', async () => {
    const network = services();
    const app = createTestApp({ ...STORAGE(), ...STT }, { fetch: network.fetch });
    const lin = await app.member();
    expect((await transcribe(app, lin.token, new TextEncoder().encode('hello'), 'text/plain')).body.error.code).toBe(
      'invalid_input',
    );
    const long = await transcribe(app, lin.token, wav(10 * 60 + 5), 'audio/wav');
    expect(long).toMatchObject({ status: 413, body: { error: { code: 'audio_too_long' } } });
    const big = await transcribe(app, lin.token, new Uint8Array(25 * 1024 * 1024 + 1), 'audio/webm');
    expect(big).toMatchObject({ status: 413, body: { error: { code: 'audio_too_large' } } });
    expect(network.calls).not.toHaveBeenCalled();
    expect(await usageOf(lin.id, 'stt')).toEqual([]);
  });

  it('speaks text, counted in characters, at most 4000 a request', async () => {
    const network = services();
    const app = createTestApp({ ...STORAGE(), ...TTS }, { fetch: network.fetch });
    const lin = await app.member();
    const response = await speak(app, lin.token, { text: '你好，Greenhouse' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(wav(0.5));
    expect(network.sent[0]!.json).toEqual({
      model: 'tts-1',
      input: '你好，Greenhouse',
      voice: 'alloy',
      response_format: 'mp3',
    });
    expect(network.sent[0]!.headers.get('authorization')).toBe('Bearer sk-tts-secret-0001');
    expect(await usageOf(lin.id, 'tts')).toEqual([
      expect.objectContaining({ providerId: 'env-tts', unit: 'character', quantity: 13 }),
    ]);

    const tooLong = await speak(app, lin.token, { text: 'a'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(network.sent).toHaveLength(1);
  });

  it('says when there is no service, and when the service fails, without its key', async () => {
    const bare = createTestApp(STORAGE());
    const lin = await bare.member();
    expect((await bare.call('GET', '/api/me', { token: lin.token })).body.capabilities).toMatchObject({
      stt: false,
      tts: false,
    });
    expect((await transcribe(bare, lin.token, recording(), 'audio/webm')).body.error.code).toBe('stt_not_configured');
    expect((await (await speak(bare, lin.token, { text: 'hi' })).json()).error.code).toBe('tts_not_configured');

    const refusing = services({ status: 401 });
    const app = createTestApp({ ...STORAGE(), ...STT, ...TTS }, { fetch: refusing.fetch });
    const chen = await app.member();
    const failed = await transcribe(app, chen.token, recording(), 'audio/webm');
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('provider_failed');
    expect(JSON.stringify(failed.body)).not.toContain('sk-stt-secret-0001');
    const spoken = await speak(app, chen.token, { text: 'hi' });
    expect(spoken.status).toBe(502);
    // Nothing was used: no usage rows for calls that failed.
    expect(await usageOf(chen.id, 'stt')).toEqual([]);
  });

  it('transcribes an audio attachment for the Agent once, and reads it from the file after that', async () => {
    const network = services({ text: '会议定在周三下午三点', duration: 2.5 });
    const scripts: Parameters<typeof scriptedModel>[0] = [];
    const model = scriptedModel(scripts);
    const app = createTestApp({ ...STORAGE(), ...STT }, { fetch: network.fetch, languageModel: model.languageModel });
    const lin = await app.member();
    const main = (await app.call('GET', '/api/conversations', { token: lin.token })).body.items[0];
    const form = new FormData();
    form.set('file', new File([recording() as Uint8Array<ArrayBuffer>], 'memo.webm', { type: 'audio/webm' }));
    form.set('purpose', 'attachment');
    form.set('conversation_id', main.id);
    const uploaded = (await (
      await app.app.request('/api/files', {
        method: 'POST',
        headers: { authorization: `Bearer ${lin.token}` },
        body: form,
      })
    ).json()) as { id: string };
    scripts.push(
      toolCall('read_attachment', { file_id: uploaded.id }),
      toolCall('read_attachment', { file_id: uploaded.id }, 'call_2'),
      text('周三下午三点开会。'),
    );
    const sent = await app.call('POST', `/api/conversations/${main.id}/messages`, {
      token: lin.token,
      body: { content: '听一下这段录音', attachments: [uploaded.id] },
    });
    await app.services.engine.idle();
    const steps = await getDb()
      .select()
      .from(runSteps)
      .where(and(eq(runSteps.runId, sent.body.run_id), eq(runSteps.kind, 'tool')))
      .orderBy(runSteps.startedAt);
    expect(steps.map((step) => step.output)).toEqual([
      expect.objectContaining({ name: 'memo.webm', transcript: '会议定在周三下午三点', duration_seconds: 2.5 }),
      expect.objectContaining({ transcript: '会议定在周三下午三点' }),
    ]);
    // One call to the service: the second read came from the file.
    expect(network.sent).toHaveLength(1);
    const [kept] = await getDb().select().from(files).where(eq(files.id, uploaded.id));
    expect(kept!.meta).toMatchObject({ transcript: { text: '会议定在周三下午三点', seconds: 2.5 } });
    expect(await usageOf(lin.id, 'stt')).toEqual([
      expect.objectContaining({ unit: 'second', quantity: 2.5, runId: sent.body.run_id, conversationId: main.id }),
    ]);
  });
});
