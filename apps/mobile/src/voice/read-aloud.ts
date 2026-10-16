import { create } from 'zustand';
import * as Speech from 'expo-speech';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { File, Paths } from 'expo-file-system';
import { api, toResult } from '../api/client';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { alertError } from '../ui/dialogs';
import { t } from '../lib/i18n';
import { speechParts } from './model';
let pending: AbortController | null = null;
let settle: (() => void) | null = null;
let generation = 0;
let player: ReturnType<typeof createAudioPlayer> | null = null;
let file: File | null = null;
export const useSpeech = create<{ id: string | null }>(() => ({ id: null }));
export function stopReading() {
  generation++;
  pending?.abort();
  pending = null;
  settle?.();
  settle = null;
  useSpeech.setState({ id: null });
  void Speech.stop();
  player?.remove();
  player = null;
  if (file?.exists) file.delete();
  file = null;
}
export function reading(id: string) {
  return useSpeech.getState().id === id;
}
export async function readAloud(id: string, markdown: string) {
  if (reading(id)) {
    stopReading();
    return;
  }
  stopReading();
  useSpeech.setState({ id });
  const n = generation;
  const lang = usePrefs.getState().lang;
  const parts = speechParts(markdown);
  const service = !!useAuth.getState().user?.capabilities.tts;
  try {
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    for (const text of parts) {
      if (n !== generation) return;
      if (!service) {
        await new Promise<void>((resolve, reject) =>
          Speech.speak(text, {
            language: lang === 'zh' ? 'zh-CN' : 'en-US',
            onDone: resolve,
            onStopped: resolve,
            onError: reject,
          }),
        );
        continue;
      }
      const controller = new AbortController();
      pending = controller;
      const response = await api('/api/voice/speech', {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, format: 'mp3' }),
      });
      if (!response.ok) {
        const result = await toResult(response);
        throw new Error(result.ok ? '' : result.message);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (n !== generation) return;
      const extension = response.headers.get('content-type')?.includes('wav') ? 'wav' : 'mp3';
      file = new File(Paths.cache, `speech-${n}.${extension}`);
      file.create({ overwrite: true });
      file.write(bytes);
      player = createAudioPlayer(file.uri);
      const current = player;
      await new Promise<void>((resolve) => {
        settle = resolve;
        const sub = current.addListener('playbackStatusUpdate', (status) => {
          if (status.didJustFinish) {
            sub.remove();
            settle = null;
            resolve();
          }
        });
        current.play();
      });
      if (n !== generation) return;
      current.remove();
      player = null;
      if (file.exists) file.delete();
      file = null;
    }
  } catch (error) {
    if (n === generation)
      alertError(t('work.voiceFailed'), undefined, error instanceof Error ? error.message : undefined);
  } finally {
    if (n === generation) stopReading();
  }
}
