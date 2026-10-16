import { stopReading } from './read-aloud';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { File } from 'expo-file-system';
import { request } from '../api/client';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { alertError } from '../ui/dialogs';
import { insertTranscript } from './model';
export function useVoice(value: string, change: (value: string) => void, selection: { start: number; end: number }) {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const supported = useAuth((s) => !!s.user?.capabilities.stt);
  const focused = useIsFocused();
  const t = useT();
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const active = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const askingPermission = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value, change, selection });
  latest.current = { value, change, selection };
  const clean = useCallback(async () => {
    const generation = ++active.current;
    pending.current?.abort();
    pending.current = null;
    busy.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    try {
      if (recorder.isRecording) await recorder.stop();
      const uri = recorder.uri;
      if (uri) {
        const file = new File(uri);
        if (file.exists) file.delete();
      }
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      /* recorder can already be disposed */
    } finally {
      if (active.current === generation) busy.current = false;
    }
  }, [recorder]);
  useEffect(() => {
    if (!focused) {
      void clean();
      setState('idle');
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && !askingPermission.current) {
        void clean();
        setState('idle');
      }
    });
    return () => {
      sub.remove();
      void clean();
    };
  }, [focused, clean]);
  const cancel = () => {
    void clean();
    setState('idle');
  };
  const toggle = async () => {
    if (!supported || busy.current) return;
    busy.current = true;
    const generation = active.current;
    try {
      if (state === 'idle') {
        stopReading();
        askingPermission.current = true;
        let permission;
        try {
          permission = await AudioModule.getRecordingPermissionsAsync();
          if (!permission.granted) permission = await AudioModule.requestRecordingPermissionsAsync();
          // Android's permission activity backgrounds the app, then reports foreground asynchronously.
          for (let n = 0; permission.granted && AppState.currentState !== 'active' && n < 20; n++)
            await new Promise((resolve) => setTimeout(resolve, 100));
        } finally {
          askingPermission.current = false;
        }
        if (!permission.granted) {
          alertError(t('work.permission'));
          return;
        }
        if (active.current !== generation || AppState.currentState !== 'active') return;
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await recorder.prepareToRecordAsync();
        if (active.current !== generation) return;
        recorder.record();
        setState('recording');
        timer.current = setTimeout(cancel, 600000);
      } else if (state === 'recording') {
        if (timer.current) clearTimeout(timer.current);
        await recorder.stop();
        await setAudioModeAsync({ allowsRecording: false });
        if (active.current !== generation) return;
        setState('transcribing');
        const uri = recorder.uri;
        if (!uri) throw new Error('Recording unavailable');
        const file = new File(uri);
        if (file.size > 25 * 1024 * 1024) throw new Error('Recording too large');
        const form = new FormData();
        form.append('file', file);
        const controller = new AbortController();
        pending.current = controller;
        const result = await request<{ text: string }>('POST', '/api/voice/transcriptions', {
          body: form,
          signal: controller.signal,
        });
        if (pending.current === controller) pending.current = null;
        if (file.exists) file.delete();
        if (active.current !== generation) return;
        if (!result.ok) {
          alertError(t('work.voiceFailed'), undefined, result.message);
          return;
        }
        const current = latest.current;
        current.change(insertTranscript(current.value, result.data.text, current.selection));
      }
    } catch (error) {
      if (active.current === generation)
        alertError(t('work.voiceFailed'), undefined, error instanceof Error ? error.message : undefined);
    } finally {
      if (active.current === generation) busy.current = false;
      if (state !== 'idle' && active.current === generation) {
        const uri = recorder.uri;
        if (uri) {
          try {
            const file = new File(uri);
            if (file.exists) file.delete();
          } catch {
            /* already removed */
          }
        }
        setState('idle');
      }
    }
  };
  return { supported, state, toggle, cancel };
}
