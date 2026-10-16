/**
 * POST /api/voice/transcriptions   multipart: `file` (a recording, at most 25 MB and 10 minutes), `language?`
 *                                  → { text, duration_seconds }; 503 stt_not_configured without a service
 * POST /api/voice/speech           { text (at most 4000 characters), format?, voice?, speed? } → the audio;
 *                                  503 tts_not_configured without a service
 *
 * The apps hide what has no service and use the device's own recognition and voice instead
 * (`me.capabilities.stt` / `.tts`). Failures of the service itself are 502 provider_failed.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { speechInputSchema, transcribeFieldsSchema, TRANSCRIBE_MAX_BYTES } from '@greenhouse/contract';
import { errorBody, invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson } from '../../http/validate.js';
import type { VoiceService } from './service.js';

/** A recording's body: the file plus form overhead, counted as it arrives when it says no length. */
const recordingLimit = bodyLimit({
  maxSize: TRANSCRIBE_MAX_BYTES + 64 * 1024,
  onError: (c) => c.json(errorBody('audio_too_large', 'A recording can be up to 25 MB.'), 413),
});

export function voiceRoutes(service: VoiceService) {
  return new Hono<AppEnv>()
    .post('/transcriptions', recordingLimit, async (c) => {
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Send the recording as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the recording in the `file` field.');
      const fields = transcribeFieldsSchema.safeParse({
        language: typeof form.language === 'string' && form.language ? form.language : undefined,
      });
      if (!fields.success) throw invalidInput('Some fields are invalid.');
      const transcription = await service.transcribe(c.get('member').id, {
        audio: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type || 'application/octet-stream',
        ...(fields.data.language ? { language: fields.data.language } : {}),
      });
      return c.json(transcription);
    })
    .post('/speech', async (c) => {
      const input = await readJson(c, speechInputSchema);
      const { audio, mimeType } = await service.speak(c.get('member').id, input);
      return c.body(audio as Uint8Array<ArrayBuffer>, 200, {
        'content-type': mimeType,
        'cache-control': 'no-store',
      });
    });
}
