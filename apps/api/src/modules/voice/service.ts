/**
 * 语音 (CONV-12, CONV-13, PRV-06, PRV-07): a recording to text and text to speech, through the
 * STT and TTS service that serves the member (docs/product/providers.md §4). Every call goes
 * through the providers service, so it is metered and refused once a budget covering it is used
 * up, and a key only ever reaches its own instance's address.
 *
 * What goes to a service is bounded: a recording by its size and, when its container says, its
 * length; speech by its characters. An audio attachment in a conversation is transcribed once and
 * the text kept with the file, so the Agent reading it again costs nothing.
 */

import { TRANSCRIBE_MAX_BYTES, TRANSCRIBE_MAX_SECONDS, type Transcription } from '@greenhouse/contract';
import type { FileRow } from '@greenhouse/db';
import { ProviderRequestError } from '@greenhouse/providers';
import { audioSeconds } from '@greenhouse/utils/audio';
import { ApiError, invalidInput } from '../../http/errors.js';
import type { ProvidersService } from '../../providers/service.js';
import type { UsageContext } from '../../providers/usage.js';
import type { FilesService } from '../files/service.js';

/** What a browser, a phone or a voice memo records in; the containers audioSeconds reads, and a few more. */
export function isAudio(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type.startsWith('audio/') || type === 'video/webm' || type === 'video/mp4' || type === 'application/ogg';
}

/** A provider's refusal or failure, as an answer the app can show; its text never holds a key. */
function failed(error: unknown): never {
  if (error instanceof ProviderRequestError) {
    throw new ApiError(502, 'provider_failed', error.message);
  }
  throw error;
}

/** What a transcribed attachment keeps in its file's meta. */
interface KeptTranscript {
  text: string;
  seconds: number | null;
}

export function createVoiceService(deps: { providers: ProvidersService; files: FilesService }) {
  /** Checks a recording against the bounds; its length when the container says. */
  function bounded(audio: Uint8Array, contentType: string): number | null {
    if (!isAudio(contentType)) throw invalidInput('Send a recording: an audio file.');
    if (!audio.byteLength) throw invalidInput('The recording is empty.');
    if (audio.byteLength > TRANSCRIBE_MAX_BYTES) {
      throw new ApiError(413, 'audio_too_large', `A recording can be up to ${TRANSCRIBE_MAX_BYTES / 1024 / 1024} MB.`);
    }
    const seconds = audioSeconds(audio);
    if (seconds !== null && seconds > TRANSCRIBE_MAX_SECONDS) {
      throw new ApiError(413, 'audio_too_long', `A recording can be up to ${TRANSCRIBE_MAX_SECONDS / 60} minutes.`);
    }
    return seconds;
  }

  async function transcribeWith(
    ctx: UsageContext,
    input: { audio: Uint8Array; contentType: string; language?: string },
  ): Promise<Transcription> {
    const seconds = bounded(input.audio, input.contentType);
    const stt = await deps.providers.resolve('stt', ctx);
    if (!stt) throw new ApiError(503, 'stt_not_configured', 'No speech-to-text service is set up.');
    const result = await stt.client
      .transcribe({
        audio: input.audio,
        mimeType: input.contentType,
        ...(input.language ? { language: input.language } : {}),
      })
      .catch(failed);
    return { text: result.text, duration_seconds: result.durationSeconds ?? seconds };
  }

  return {
    /** A recording from a member's microphone, to text for them to review. */
    transcribe(memberId: string, input: { audio: Uint8Array; contentType: string; language?: string }) {
      return transcribeWith({ memberId }, input);
    },

    /** Text read aloud: the audio and its type. */
    async speak(
      memberId: string,
      input: { text: string; format: 'mp3' | 'wav' | 'opus'; voice?: string; speed?: number },
    ): Promise<{ audio: Uint8Array; mimeType: string }> {
      const tts = await deps.providers.resolve('tts', { memberId });
      if (!tts) throw new ApiError(503, 'tts_not_configured', 'No text-to-speech service is set up.');
      return tts.client.synthesize(input).catch(failed);
    },

    /**
     * The words of an audio file attached in a conversation, for the Agent: transcribed once,
     * then read from the file. Null when no speech-to-text service serves this turn.
     */
    async transcribeFile(
      ctx: UsageContext & { memberId: string },
      row: FileRow,
      audio: Uint8Array,
    ): Promise<Transcription | null> {
      const kept = row.meta.transcript as KeptTranscript | undefined;
      if (kept && typeof kept.text === 'string') return { text: kept.text, duration_seconds: kept.seconds };
      if (!(await deps.providers.available('stt', ctx))) return null;
      const result = await transcribeWith(ctx, { audio, contentType: row.contentType });
      await deps.files.remember(row.id, {
        transcript: { text: result.text, seconds: result.duration_seconds } satisfies KeptTranscript,
      });
      return result;
    },
  };
}

export type VoiceService = ReturnType<typeof createVoiceService>;
