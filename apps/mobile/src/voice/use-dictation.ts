/**
 * Speech recognition for hold-to-talk (expo-speech-recognition: SFSpeechRecognizer on iOS). It
 * runs on the phone when the device has the language's on-device model; when it does not, the
 * same press falls back once to Apple's server recognizer instead of failing. `begin()` asks for
 * the microphone and speech permissions the first time, then listens in the app's language with live partial
 * results; `finish()` stops and answers everything heard; `cancel()` throws it away. Leaving the
 * screen or the app cancels. Rules in ./dictation.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { t } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { alertError, confirmAction } from '../ui/dialogs';
import { dictationLocale } from './dictation';

export type DictationState = 'idle' | 'starting' | 'listening';

function listen(onDevice: boolean): void {
  ExpoSpeechRecognitionModule.start({
    lang: dictationLocale(usePrefs.getState().lang),
    interimResults: true,
    continuous: true,
    addsPunctuation: true,
    requiresOnDeviceRecognition: onDevice,
  });
}

export function useDictation() {
  const [state, setState] = useState<DictationState>('idle');
  const [heard, setHeard] = useState('');
  const latest = useRef('');
  const ended = useRef<(() => void) | null>(null);
  const active = useRef(false);
  const onDevice = useRef(false);
  /** The first session's own `end` follows its error after a fallback restart: not ours to act on. */
  const restarted = useRef(false);

  useSpeechRecognitionEvent('result', (event) => {
    if (!active.current) return;
    const text = event.results[0]?.transcript ?? '';
    latest.current = text;
    setHeard(text);
  });
  useSpeechRecognitionEvent('end', () => {
    if (restarted.current) {
      restarted.current = false;
      return;
    }
    active.current = false;
    setState('idle');
    ended.current?.();
    ended.current = null;
  });
  useSpeechRecognitionEvent('error', (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    if (event.error === 'not-allowed') return;
    // no on-device model for this language here: listen again through the server recognizer
    if (onDevice.current && active.current) {
      onDevice.current = false;
      restarted.current = true;
      listen(false);
      return;
    }
    active.current = false;
    setState('idle');
    alertError(t('voice.failed'), t('voice.failedHint'), event.message || undefined);
  });

  const cancel = useCallback(() => {
    if (!active.current) return;
    active.current = false;
    latest.current = '';
    setHeard('');
    setState('idle');
    ExpoSpeechRecognitionModule.abort();
  }, []);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') cancel();
    });
    return () => {
      sub.remove();
      cancel();
    };
  }, [cancel]);

  const begin = useCallback(async (): Promise<boolean> => {
    if (active.current) return true;
    setState('starting');
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setState('idle');
      const go = await confirmAction({
        title: t('voice.deniedTitle'),
        message: t('voice.deniedHint'),
        confirmLabel: t('composer.openSettings'),
      });
      if (go) void Linking.openSettings();
      return false;
    }
    latest.current = '';
    setHeard('');
    active.current = true;
    onDevice.current = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    listen(onDevice.current);
    setState('listening');
    return true;
  }, []);

  /** Stop listening and answer what was heard (the last results arrive before `end`). */
  const finish = useCallback(async (): Promise<string> => {
    if (!active.current) return latest.current;
    const done = new Promise<void>((resolve) => {
      ended.current = resolve;
      setTimeout(resolve, 1500);
    });
    ExpoSpeechRecognitionModule.stop();
    await done;
    active.current = false;
    setState('idle');
    const text = latest.current;
    latest.current = '';
    setHeard('');
    return text;
  }, []);

  return { state, heard, begin, finish, cancel };
}
