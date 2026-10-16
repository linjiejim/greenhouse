import { describe, expect, it } from 'vitest';
import { isRetriable } from '../llm/models.js';
import { EndpointViolation, pinnedFetch } from '../pinned-fetch.js';
import {
  deepgramAdapter,
  elevenlabsAdapter,
  minimaxAdapter,
  openaiCompatibleSttAdapter,
  openaiCompatibleTtsAdapter,
} from '../speech/adapters.js';
import { KEY, connect, json, rejection, sent } from './fake-network.js';

const presetConfig = (adapter: { presets?: readonly { id: string; config: Record<string, unknown> }[] }, id: string) =>
  adapter.presets!.find((preset) => preset.id === id)!.config;

const audioResponse = (bytes: number[], contentType: string) =>
  new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } });

describe('speech-to-text adapters', () => {
  it('OpenAI-compatible transcription uploads multipart audio with a bearer key', async () => {
    const { client, fake } = connect(openaiCompatibleSttAdapter, presetConfig(openaiCompatibleSttAdapter, 'groq'), () =>
      json({ text: ' hello world ', usage: { type: 'duration', seconds: 3 } }),
    );
    const audio = new Uint8Array([1, 2, 3]);
    const result = await client.transcribe({
      audio,
      mimeType: 'audio/webm;codecs=opus',
      language: 'zh-CN',
      prompt: 'Greenhouse',
    });
    const { url, init, headers } = sent(fake);
    expect(url.href).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('language')).toBe('zh');
    expect(form.get('prompt')).toBe('Greenhouse');
    const file = form.get('file') as File;
    // Whisper-style servers choose the decoder by extension.
    expect(file.name).toBe('audio.webm');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
    expect(result).toEqual({ text: 'hello world', durationSeconds: 3 });
  });

  it('OpenAI-compatible transcription needs an explicit base URL and sends no key to a keyless server', async () => {
    expect(() => openaiCompatibleSttAdapter.configSchema.parse({ model: 'whisper-1' })).toThrow();
    const { client, config, fake } = connect(
      openaiCompatibleSttAdapter,
      { baseUrl: 'http://localhost:8000/v1', model: 'Systran/faster-whisper-small' },
      () => json({ text: '' }),
      {},
    );
    await openaiCompatibleSttAdapter.test!(client, config);
    const { headers, init } = sent(fake);
    expect(headers.get('authorization')).toBeNull();
    // The test call uploads one second of silence as a real WAV file.
    const file = (init.body as FormData).get('file') as File;
    expect(file.name).toBe('audio.wav');
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WAVE');
    expect(bytes.byteLength).toBe(44 + 32_000);
  });

  it('Deepgram posts raw audio with a Token key and detects the language unless one is given', async () => {
    const { client, fake } = connect(deepgramAdapter, {}, () =>
      json({
        metadata: { duration: 2.5 },
        results: { channels: [{ alternatives: [{ transcript: 'hi there', confidence: 0.9 }] }] },
      }),
    );
    const audio = new Uint8Array([9, 8, 7]);
    expect(await client.transcribe({ audio, mimeType: 'audio/wav' })).toEqual({
      text: 'hi there',
      durationSeconds: 2.5,
    });
    const first = sent(fake, 0);
    expect(`${first.url.origin}${first.url.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      model: 'nova-3',
      smart_format: 'true',
      detect_language: 'true',
    });
    expect(first.init.method).toBe('POST');
    expect(first.headers.get('authorization')).toBe(`Token ${KEY}`);
    expect(first.headers.get('content-type')).toBe('audio/wav');
    expect(first.init.body).toBe(audio);

    await client.transcribe({ audio, mimeType: 'audio/wav', language: 'zh-CN' });
    const second = sent(fake, 1);
    expect(second.url.searchParams.get('language')).toBe('zh-CN');
    expect(second.url.searchParams.has('detect_language')).toBe(false);
  });

  it('never sends audio or a key to another origin', async () => {
    const { client, fake } = connect(
      deepgramAdapter,
      {},
      () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example.com/v1/listen' } }),
    );
    const input = { audio: new Uint8Array([1]), mimeType: 'audio/wav' };
    await expect(client.transcribe(input)).rejects.toBeInstanceOf(EndpointViolation);
    expect(fake).toHaveBeenCalledOnce();

    // A client pinned to one endpoint cannot be pointed at another.
    const config = deepgramAdapter.configSchema.parse({ baseUrl: 'https://api.eu.deepgram.com' });
    const strayed = deepgramAdapter.create({
      config,
      secrets: { apiKey: KEY },
      fetch: pinnedFetch(['https://api.deepgram.com'], fake as unknown as typeof fetch),
    });
    await expect(strayed.transcribe(input)).rejects.toBeInstanceOf(EndpointViolation);
    expect(fake).toHaveBeenCalledOnce();
  });
});

describe('text-to-speech adapters', () => {
  it('OpenAI-compatible speech posts JSON and returns the audio bytes', async () => {
    const { client, fake } = connect(
      openaiCompatibleTtsAdapter,
      presetConfig(openaiCompatibleTtsAdapter, 'siliconflow'),
      () => audioResponse([0xff, 0xfb, 1], 'application/octet-stream'),
    );
    const result = await client.synthesize({ text: '你好', speed: 9 });
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.siliconflow.cn/v1/audio/speech');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: '你好',
      voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      response_format: 'mp3',
      speed: 4,
    });
    // No audio type in the response: the type of the format asked for.
    expect(result).toEqual({ audio: new Uint8Array([0xff, 0xfb, 1]), mimeType: 'audio/mpeg' });
  });

  it('OpenAI-compatible speech treats a JSON answer as an error, not as audio', async () => {
    const { client } = connect(
      openaiCompatibleTtsAdapter,
      { baseUrl: 'https://gateway.example.com/v1', model: 'tts-1', voice: 'alloy' },
      () => json({ error: { message: 'model not found' } }),
    );
    await expect(client.synthesize({ text: 'x', format: 'opus' })).rejects.toThrow(
      'gateway.example.com speech failed: model not found.',
    );
  });

  it('ElevenLabs sends xi-api-key, the voice in the path and the output format', async () => {
    const { client, config, fake } = connect(elevenlabsAdapter, {}, () => audioResponse([1, 2], 'audio/wav'));
    const result = await client.synthesize({ text: 'Hello', format: 'wav', speed: 0.5 });
    const { url, init, headers, body } = sent(fake);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb');
    expect(url.searchParams.get('output_format')).toBe('wav_24000');
    expect(init.method).toBe('POST');
    expect(headers.get('xi-api-key')).toBe(KEY);
    expect(headers.get('authorization')).toBeNull();
    expect(body).toEqual({ text: 'Hello', model_id: 'eleven_multilingual_v2', voice_settings: { speed: 0.7 } });
    expect(result).toEqual({ audio: new Uint8Array([1, 2]), mimeType: 'audio/wav' });

    await elevenlabsAdapter.test!(client, config);
    expect(sent(fake, 1).body).toEqual({ text: 'OK', model_id: 'eleven_multilingual_v2' });
    expect(sent(fake, 1).url.searchParams.get('output_format')).toBe('mp3_44100_128');
  });

  it('MiniMax posts t2a_v2 and decodes the hex audio', async () => {
    const { client, fake } = connect(minimaxAdapter, {}, () =>
      json({
        data: { audio: 'fffb9064', status: 2 },
        extra_info: { audio_format: 'mp3', usage_characters: 2 },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
    );
    const result = await client.synthesize({ text: '你好', voice: 'female-shaonv', speed: 1.2 });
    const { url, init, headers, body } = sent(fake);
    expect(url.href).toBe('https://api.minimaxi.com/v1/t2a_v2');
    expect(init.method).toBe('POST');
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(body).toEqual({
      model: 'speech-2.6-hd',
      text: '你好',
      stream: false,
      output_format: 'hex',
      voice_setting: { voice_id: 'female-shaonv', speed: 1.2 },
      audio_setting: { format: 'mp3', sample_rate: 32000, channel: 1, bitrate: 128000 },
    });
    expect(result).toEqual({ audio: new Uint8Array([0xff, 0xfb, 0x90, 0x64]), mimeType: 'audio/mpeg' });
  });

  it('MiniMax maps errors inside a 200 body to HTTP statuses and keeps the key out', async () => {
    const { client } = connect(minimaxAdapter, {}, () =>
      json({ base_resp: { status_code: 1004, status_msg: `login fail: unknown key ${KEY}` } }),
    );
    const error = await rejection(client.synthesize({ text: 'x' }));
    expect(error.message).toBe('MiniMax speech failed (code 1004): login fail: unknown key ***. Check the API key.');
    expect(error.statusCode).toBe(401);
    expect(isRetriable(error)).toBe(false);

    const { client: busy } = connect(minimaxAdapter, {}, () =>
      json({ base_resp: { status_code: 1002, status_msg: 'rate limit' } }),
    );
    expect(isRetriable(await rejection(busy.synthesize({ text: 'x' })))).toBe(true);
    await expect(busy.synthesize({ text: 'x', format: 'opus' })).rejects.toThrow('mp3 or wav');
  });
});
