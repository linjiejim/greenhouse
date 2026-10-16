/**
 * Speech adapters (docs/product/providers.md §6): transcription (stt) and synthesis (tts).
 * The OpenAI-compatible pair covers OpenAI, Groq, SiliconFlow and local servers through
 * presets; Deepgram, ElevenLabs and MiniMax speak their own APIs.
 */

import { z } from 'zod';
import type { ProviderAdapter, SttClient, TtsClient } from '../types.js';
import {
  ProviderRequestError,
  bearer,
  detailOf,
  hostOf,
  postJson,
  providerError,
  readJson,
  send,
  withoutTrailingSlash,
  type CallContext,
} from '../http.js';

const STT_TIMEOUT_MS = 120_000;
const TTS_TIMEOUT_MS = 60_000;

type AudioFormat = NonNullable<Parameters<TtsClient['synthesize']>[0]['format']>;

const AUDIO_TYPES: Record<AudioFormat, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', opus: 'audio/ogg' };

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

/** Whisper-style servers pick the decoder from the file name, so the extension must be right. */
function audioFileName(mimeType: string) {
  const type = mimeType.split(';')[0]!.trim().toLowerCase();
  return `audio.${AUDIO_EXTENSIONS[type] ?? type.split('/')[1]?.replace(/^x-/, '') ?? 'bin'}`;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** One second of 16 kHz mono silence: the smallest real upload every transcription API accepts. */
function silentWav(seconds = 1, sampleRate = 16_000): Uint8Array {
  const dataBytes = seconds * sampleRate * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const ascii = (offset: number, value: string) =>
    [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return wav;
}

async function probeStt(client: SttClient) {
  await client.transcribe({ audio: silentWav(), mimeType: 'audio/wav' });
}

/** A two-letter phrase: the cheapest synthesis that proves the key, model and voice. */
async function probeTts(client: TtsClient) {
  await client.synthesize({ text: 'OK' });
}

/** The response's own audio type when it names one, else the type of the format asked for. */
async function readAudio(response: Response, format: AudioFormat, call: CallContext) {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
  // Some gateways answer an error with 200 and a JSON body; that is not audio.
  if (type.includes('json')) throw providerError(call, { detail: detailOf(await response.text()) });
  const audio = new Uint8Array(await response.arrayBuffer());
  if (!audio.byteLength) throw new ProviderRequestError(`${call.label} returned no audio.`);
  return { audio, mimeType: type.startsWith('audio/') ? type : AUDIO_TYPES[format] };
}

const openaiSttConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  /** Spoken language when a request names none (ISO 639-1, e.g. zh); unset lets the model detect it. */
  language: z.string().min(2).optional(),
});
type OpenAiSttConfig = z.infer<typeof openaiSttConfigSchema>;

interface OpenAiTranscription {
  text?: string;
  /** verbose_json only. */
  duration?: number;
  /** Duration-billed models (whisper-1) report the audio length here. */
  usage?: { type?: string; seconds?: number };
}

export const openaiCompatibleSttAdapter: ProviderAdapter<'stt', OpenAiSttConfig> = {
  capability: 'stt',
  kind: 'openai-compatible',
  label: 'OpenAI 兼容',
  configSchema: openaiSttConfigSchema as z.ZodType<OpenAiSttConfig>,
  secretKeys: ['apiKey'],
  // Local faster-whisper and speaches servers take no key.
  requiredSecrets: [],
  presets: [
    {
      id: 'openai',
      label: 'OpenAI',
      config: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe' },
    },
    {
      id: 'groq',
      label: 'Groq',
      config: { baseUrl: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo' },
    },
    {
      id: 'siliconflow',
      label: '硅基流动',
      config: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'FunAudioLLM/SenseVoiceSmall' },
    },
  ],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = {
      label: `${hostOf(config.baseUrl)} transcription`,
      secrets: [secrets.apiKey],
      timeoutMs: STT_TIMEOUT_MS,
    };
    return {
      async transcribe(input) {
        const form = new FormData();
        form.append('model', config.model);
        const audio = new Blob([input.audio as Uint8Array<ArrayBuffer>], { type: input.mimeType });
        form.append('file', audio, audioFileName(input.mimeType));
        const language = input.language ?? config.language;
        // The protocol takes ISO 639-1: "zh-CN" from a browser becomes "zh".
        if (language) form.append('language', language.split(/[-_]/)[0]!.toLowerCase());
        if (input.prompt) form.append('prompt', input.prompt);
        const response = await send(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/audio/transcriptions`,
          { method: 'POST', headers: { Accept: 'application/json', ...bearer(secrets.apiKey) }, body: form },
          call,
        );
        const body = await readJson<OpenAiTranscription>(response, call);
        if (typeof body.text !== 'string') throw new ProviderRequestError(`${call.label} returned no text.`);
        const durationSeconds =
          typeof body.duration === 'number'
            ? body.duration
            : body.usage?.type === 'duration' && typeof body.usage.seconds === 'number'
              ? body.usage.seconds
              : undefined;
        return { text: body.text.trim(), ...(durationSeconds === undefined ? {} : { durationSeconds }) };
      },
    };
  },
  test: probeStt,
};

const deepgramConfigSchema = z.object({
  baseUrl: z.string().url().default('https://api.deepgram.com'),
  model: z.string().min(1).default('nova-3'),
  /** Spoken language when a request names none (BCP-47, e.g. zh-CN); unset detects it per request. */
  language: z.string().min(2).optional(),
});
type DeepgramConfig = z.infer<typeof deepgramConfigSchema>;

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: { channels?: { alternatives?: { transcript?: string }[] }[] };
}

export const deepgramAdapter: ProviderAdapter<'stt', DeepgramConfig> = {
  capability: 'stt',
  kind: 'deepgram',
  label: 'Deepgram',
  configSchema: deepgramConfigSchema as z.ZodType<DeepgramConfig>,
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = { label: 'Deepgram transcription', secrets: [secrets.apiKey], timeoutMs: STT_TIMEOUT_MS };
    return {
      // Deepgram takes key terms rather than a free-form prompt, so input.prompt is not sent.
      async transcribe(input) {
        const params = new URLSearchParams({ model: config.model, smart_format: 'true' });
        const language = input.language ?? config.language;
        if (language) params.set('language', language);
        else params.set('detect_language', 'true');
        const response = await send(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/v1/listen?${params}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Token ${secrets.apiKey ?? ''}`,
              'Content-Type': input.mimeType,
              Accept: 'application/json',
            },
            body: input.audio as Uint8Array<ArrayBuffer>,
          },
          call,
        );
        const body = await readJson<DeepgramResponse>(response, call);
        const transcript = body.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (typeof transcript !== 'string') throw new ProviderRequestError(`${call.label} returned no transcript.`);
        const duration = body.metadata?.duration;
        return { text: transcript.trim(), ...(typeof duration === 'number' ? { durationSeconds: duration } : {}) };
      },
    };
  },
  test: probeStt,
};

const openaiTtsConfigSchema = z.object({
  baseUrl: z.string().url(),
  model: z.string().min(1),
  /** Used when a request names no voice. */
  voice: z.string().min(1),
});
type OpenAiTtsConfig = z.infer<typeof openaiTtsConfigSchema>;

export const openaiCompatibleTtsAdapter: ProviderAdapter<'tts', OpenAiTtsConfig> = {
  capability: 'tts',
  kind: 'openai-compatible',
  label: 'OpenAI 兼容',
  configSchema: openaiTtsConfigSchema as z.ZodType<OpenAiTtsConfig>,
  secretKeys: ['apiKey'],
  // Local servers such as Kokoro take no key.
  requiredSecrets: [],
  presets: [
    {
      id: 'openai',
      label: 'OpenAI',
      config: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy' },
    },
    {
      id: 'siliconflow',
      label: '硅基流动',
      config: {
        baseUrl: 'https://api.siliconflow.cn/v1',
        model: 'FunAudioLLM/CosyVoice2-0.5B',
        voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      },
    },
  ],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = {
      label: `${hostOf(config.baseUrl)} speech`,
      secrets: [secrets.apiKey],
      timeoutMs: TTS_TIMEOUT_MS,
    };
    return {
      async synthesize(input) {
        const format = input.format ?? 'mp3';
        const payload = {
          model: config.model,
          input: input.text,
          voice: input.voice ?? config.voice,
          response_format: format,
          ...(input.speed === undefined ? {} : { speed: clamp(input.speed, 0.25, 4) }),
        };
        const response = await send(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/audio/speech`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...bearer(secrets.apiKey) },
            body: JSON.stringify(payload),
          },
          call,
        );
        return readAudio(response, format, call);
      },
    };
  },
  test: probeTts,
};

const elevenlabsConfigSchema = z.object({
  baseUrl: z.string().url().default('https://api.elevenlabs.io'),
  model: z.string().min(1).default('eleven_multilingual_v2'),
  /** A voice id; the default is a premade voice every account has. */
  voice: z.string().min(1).default('JBFqnCBsd6RMkjVDRZzb'),
});
type ElevenLabsConfig = z.infer<typeof elevenlabsConfigSchema>;

/** Tiers below Pro cannot get 44.1 kHz PCM or WAV, so wav asks for 24 kHz. */
const ELEVENLABS_FORMATS: Record<AudioFormat, string> = {
  mp3: 'mp3_44100_128',
  wav: 'wav_24000',
  opus: 'opus_48000_64',
};

export const elevenlabsAdapter: ProviderAdapter<'tts', ElevenLabsConfig> = {
  capability: 'tts',
  kind: 'elevenlabs',
  label: 'ElevenLabs',
  configSchema: elevenlabsConfigSchema as z.ZodType<ElevenLabsConfig>,
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = { label: 'ElevenLabs speech', secrets: [secrets.apiKey], timeoutMs: TTS_TIMEOUT_MS };
    return {
      async synthesize(input) {
        const format = input.format ?? 'mp3';
        const voice = encodeURIComponent(input.voice ?? config.voice);
        const payload = {
          text: input.text,
          model_id: config.model,
          // ElevenLabs documents 0.7–1.2.
          ...(input.speed === undefined ? {} : { voice_settings: { speed: clamp(input.speed, 0.7, 1.2) } }),
        };
        const response = await send(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/v1/text-to-speech/${voice}?output_format=${ELEVENLABS_FORMATS[format]}`,
          {
            method: 'POST',
            headers: { 'xi-api-key': secrets.apiKey ?? '', 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
          call,
        );
        return readAudio(response, format, call);
      },
    };
  },
  test: probeTts,
};

const minimaxConfigSchema = z.object({
  baseUrl: z.string().url().default('https://api.minimaxi.com'),
  model: z.string().min(1).default('speech-2.6-hd'),
  /** A system or cloned voice id. */
  voice: z.string().min(1).default('male-qn-qingse'),
});
type MinimaxConfig = z.infer<typeof minimaxConfigSchema>;

interface MinimaxResponse {
  data?: { audio?: string } | null;
  base_resp?: { status_code?: number; status_msg?: string };
}

/** MiniMax reports failures as 200 with base_resp; these codes map to the HTTP status they mean. */
const MINIMAX_STATUS: Record<number, number> = {
  1000: 500,
  1001: 408,
  1002: 429,
  1004: 401,
  1008: 402,
  1024: 500,
  1033: 503,
  1039: 429,
  1041: 429,
  2042: 403,
  2045: 429,
  2049: 401,
};

export const minimaxAdapter: ProviderAdapter<'tts', MinimaxConfig> = {
  capability: 'tts',
  kind: 'minimax',
  label: 'MiniMax',
  configSchema: minimaxConfigSchema as z.ZodType<MinimaxConfig>,
  secretKeys: ['apiKey'],
  requiredSecrets: ['apiKey'],
  presets: [
    { id: 'minimax', label: 'MiniMax', config: { baseUrl: 'https://api.minimaxi.com' } },
    { id: 'minimax-global', label: 'MiniMax（海外）', config: { baseUrl: 'https://api.minimax.io' } },
  ],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const call: CallContext = { label: 'MiniMax speech', secrets: [secrets.apiKey], timeoutMs: TTS_TIMEOUT_MS };
    return {
      async synthesize(input) {
        const format = input.format ?? 'mp3';
        // MiniMax documents opus too, but not its container, so this adapter does not claim it.
        if (format === 'opus') {
          throw new ProviderRequestError('MiniMax speech here returns mp3 or wav; ask for one of those.');
        }
        const payload = {
          model: config.model,
          text: input.text,
          stream: false,
          output_format: 'hex',
          voice_setting: {
            voice_id: input.voice ?? config.voice,
            ...(input.speed === undefined ? {} : { speed: clamp(input.speed, 0.5, 2) }),
          },
          audio_setting: { format, sample_rate: 32_000, channel: 1, ...(format === 'mp3' ? { bitrate: 128_000 } : {}) },
        };
        const body = await postJson<MinimaxResponse>(
          fetch,
          `${withoutTrailingSlash(config.baseUrl)}/v1/t2a_v2`,
          payload,
          bearer(secrets.apiKey),
          call,
        );
        const code = body.base_resp?.status_code ?? 0;
        if (code !== 0) {
          throw providerError(call, {
            reason: `code ${code}`,
            detail: body.base_resp?.status_msg,
            statusCode: MINIMAX_STATUS[code] ?? 400,
          });
        }
        const bytes = Buffer.from(body.data?.audio ?? '', 'hex');
        if (!bytes.byteLength) throw new ProviderRequestError(`${call.label} returned no audio.`);
        return {
          audio: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          mimeType: AUDIO_TYPES[format],
        };
      },
    };
  },
  test: probeTts,
};

export const SPEECH_ADAPTERS = [
  openaiCompatibleSttAdapter,
  deepgramAdapter,
  openaiCompatibleTtsAdapter,
  elevenlabsAdapter,
  minimaxAdapter,
];
