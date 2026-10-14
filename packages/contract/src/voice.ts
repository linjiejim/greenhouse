import { z } from 'zod';

/**
 * 语音 (CONV-12, CONV-13): a recording to text and text to speech, through the STT and TTS
 * services that serve the member (their own key when allowed, else the workspace's). Without
 * one, the apps use the device's own recognition and voice; `me.capabilities` says which.
 */

/** A recording sent for transcription: at most this many bytes… */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;
/** …and this many seconds (when its length can be read from it). */
export const TRANSCRIBE_MAX_SECONDS = 10 * 60;
/** Characters per speech request: a longer reply is read in parts. */
export const SPEECH_TEXT_MAX = 4_000;
export const SPEECH_FORMATS = ['mp3', 'wav', 'opus'] as const;

/** The form fields that go with the recording (`file`). */
export const transcribeFieldsSchema = z.object({
  /** The spoken language (BCP 47 such as zh-CN, or ISO 639-1); unset lets the service detect it. */
  language: z.string().trim().min(2).max(16).optional(),
});
export type TranscribeFields = z.infer<typeof transcribeFieldsSchema>;

export const transcriptionSchema = z.object({
  text: z.string(),
  /** Seconds of audio: the service's own figure, else read from the recording; null when neither says. */
  duration_seconds: z.number().nullable(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

export const speechInputSchema = z.object({
  /** Plain text: the apps take Markdown, code and tables out before asking. */
  text: z.string().trim().min(1).max(SPEECH_TEXT_MAX),
  format: z.enum(SPEECH_FORMATS).default('mp3'),
  /** A voice the service knows; unset uses the one set for the service. */
  voice: z.string().trim().min(1).max(100).optional(),
  speed: z.number().min(0.25).max(4).optional(),
});
export type SpeechInput = z.input<typeof speechInputSchema>;
