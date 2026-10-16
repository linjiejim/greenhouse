/**
 * 语音输入 (CONV-12): the composer's microphone. With an STT service serving the member the
 * recording goes to it (api.voice.transcribe); without one the browser's own recognition listens
 * (Web Speech); with neither there is no microphone. While listening the composer shows the
 * levels and a timer; the microphone again finishes, Esc cancels. The words land in the composer
 * for review: nothing is ever sent by itself.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { TRANSCRIBE_MAX_SECONDS } from '@greenhouse/contract';
import { api } from '../lib/api';

export type VoiceMode = 'service' | 'browser';
export type VoicePhase = 'idle' | 'starting' | 'listening' | 'transcribing';
/** Why listening stopped short, for the dictionary's words. */
export type VoiceFailure = 'denied' | 'no-mic' | 'nothing-heard' | 'failed';

/** The part of Web Speech's SpeechRecognition used here (not in TypeScript's DOM types). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionClass(): (new () => Recognition) | null {
  const scope = window as unknown as {
    SpeechRecognition?: new () => Recognition;
    webkitSpeechRecognition?: new () => Recognition;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** How the microphone works here, or null when it can't (no service and no recognition in the browser). */
export function voiceMode(stt: boolean | undefined): VoiceMode | null {
  if (typeof window === 'undefined') return null;
  const canRecord = !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  if (stt && canRecord) return 'service';
  return recognitionClass() ? 'browser' : null;
}

/** Bars of the level meter. */
export const VOICE_BARS = 18;
/** What browsers record in, best first: WebM Opus (Chrome, Firefox), MP4 (Safari). */
const RECORDING_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
const EXTENSIONS: Record<string, string> = { webm: 'webm', mp4: 'm4a', ogg: 'ogg' };

const failureOf = (error: unknown): VoiceFailure => {
  const name = (error as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') return 'no-mic';
  return 'failed';
};

/** Everything one listening session holds, let go of by `release`. */
interface Session {
  stream?: MediaStream;
  recorder?: MediaRecorder;
  recognition?: Recognition;
  context?: AudioContext;
  frame?: number;
  timer?: ReturnType<typeof setInterval>;
  cancelled?: boolean;
  finishing?: boolean;
}

export interface VoiceInput {
  phase: VoicePhase;
  /** Seconds listened so far. */
  seconds: number;
  /** The level meter, 0 to 1 a bar, newest last. */
  levels: number[];
  /** Words the browser has heard so far (Web Speech only). */
  heard: string;
  start(): void;
  finish(): void;
  cancel(): void;
}

export function useVoiceInput(options: {
  mode: VoiceMode | null;
  locale: 'zh' | 'en';
  onText: (text: string) => void;
  /** Listening stopped short (a VoiceFailure), or the service refused (the error). */
  onError: (failure: VoiceFailure | Error) => void;
}): VoiceInput {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array<number>(VOICE_BARS).fill(0));
  const [heard, setHeard] = useState('');
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null);

  const release = useCallback(() => {
    const current = session.current;
    if (!current) return;
    if (current.frame) cancelAnimationFrame(current.frame);
    if (current.timer) clearInterval(current.timer);
    current.stream?.getTracks().forEach((track) => track.stop());
    void current.context?.close().catch(() => undefined);
    setLevels(Array<number>(VOICE_BARS).fill(0));
  }, []);

  const end = useCallback(() => {
    release();
    session.current = null;
    setPhase('idle');
    setSeconds(0);
    setHeard('');
  }, [release]);

  /** Levels from the microphone: one bar about every 80 ms, the newest on the right. */
  const meter = useCallback((stream: MediaStream) => {
    const current = session.current;
    if (!current || typeof AudioContext === 'undefined') return;
    const context = new AudioContext();
    current.context = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let last = 0;
    const tick = (now: number) => {
      if (session.current !== current) return;
      if (now - last > 80) {
        last = now;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
        setLevels((bars) => [...bars.slice(1), level]);
      }
      current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);
  }, []);

  const deliver = useCallback(
    (text: string) => {
      end();
      if (text.trim()) latest.current.onText(text.trim());
      else latest.current.onError('nothing-heard');
    },
    [end],
  );

  /** Finishes from inside a session (the length limit), whatever render it started in. */
  const finishRef = useRef<() => void>(() => undefined);

  const start = useCallback(() => {
    const mode = latest.current.mode;
    if (!mode || session.current) return;
    const current: Session = {};
    session.current = current;
    setPhase('starting');
    setSeconds(0);
    setHeard('');
    const startedAt = Date.now();
    const listening = () => {
      setPhase('listening');
      current.timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        setSeconds(elapsed);
        // The service takes up to TRANSCRIBE_MAX_SECONDS: stop there and transcribe what there is.
        if (elapsed >= TRANSCRIBE_MAX_SECONDS) finishRef.current();
      }, 250);
    };

    // The browser's recognition opens the microphone itself; the stream here is for the levels,
    // and a browser that can't give one still recognizes.
    const opened = navigator.mediaDevices?.getUserMedia
      ? navigator.mediaDevices.getUserMedia({ audio: true })
      : Promise.resolve(null);
    void opened
      .then((stream) => {
        if (session.current !== current) {
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }
        if (stream) {
          current.stream = stream;
          meter(stream);
        }
        if (mode === 'service') {
          if (!stream) throw Object.assign(new Error('No microphone.'), { name: 'NotFoundError' });
          const type = RECORDING_TYPES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
          const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
          const chunks: Blob[] = [];
          recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
          recorder.onstop = () => {
            if (current.cancelled) return;
            const recorded = recorder.mimeType || type || 'audio/webm';
            const extension = EXTENSIONS[recorded.split('/')[1]?.split(';')[0] ?? ''] ?? 'webm';
            const file = new File(chunks, `recording.${extension}`, { type: recorded });
            // Stopped before anything was recorded: nothing to send.
            if (!file.size) return deliver('');
            release();
            setPhase('transcribing');
            const language = latest.current.locale === 'zh' ? 'zh-CN' : 'en-US';
            api.voice
              .transcribe(file, { language })
              .then((result) => {
                if (session.current === current) deliver(result.text);
              })
              .catch((error: unknown) => {
                if (session.current !== current) return;
                end();
                latest.current.onError(error instanceof Error ? error : new Error(String(error)));
              });
          };
          current.recorder = recorder;
          recorder.start(250);
          listening();
          return;
        }
        const Recognizer = recognitionClass();
        if (!Recognizer) throw new Error('No speech recognition here.');
        const recognition = new Recognizer();
        recognition.lang = latest.current.locale === 'zh' ? 'zh-CN' : 'en-US';
        recognition.continuous = true;
        recognition.interimResults = true;
        let final = '';
        let interim = '';
        recognition.onresult = (event) => {
          interim = '';
          for (let index = event.resultIndex; index < event.results.length; index++) {
            const result = event.results[index]!;
            if (result.isFinal) final += result[0]!.transcript;
            else interim += result[0]!.transcript;
          }
          setHeard(final + interim);
        };
        recognition.onerror = (event) => {
          if (current.cancelled || event.error === 'aborted') return;
          current.cancelled = true;
          end();
          latest.current.onError(
            event.error === 'not-allowed' || event.error === 'service-not-allowed'
              ? 'denied'
              : event.error === 'audio-capture'
                ? 'no-mic'
                : event.error === 'no-speech'
                  ? 'nothing-heard'
                  : 'failed',
          );
        };
        // Recognition ends when asked to and on long silence: either way, what was heard lands.
        recognition.onend = () => {
          if (!current.cancelled && session.current === current) deliver(final + interim);
        };
        current.recognition = recognition;
        recognition.start();
        listening();
      })
      .catch((error: unknown) => {
        if (session.current !== current) return;
        end();
        latest.current.onError(failureOf(error));
      });
  }, [deliver, end, meter, release]);

  const finish = useCallback(() => {
    const current = session.current;
    if (!current || current.finishing) return;
    if (!current.recorder && !current.recognition) return;
    current.finishing = true;
    if (current.recorder?.state === 'recording') current.recorder.stop();
    current.recognition?.stop();
  }, []);
  finishRef.current = finish;

  const cancel = useCallback(() => {
    const current = session.current;
    if (!current) return;
    current.cancelled = true;
    if (current.recorder?.state === 'recording') current.recorder.stop();
    current.recognition?.abort();
    end();
  }, [end]);

  // Leaving the page while listening lets go of the microphone.
  useEffect(
    () => () => {
      if (session.current) session.current.cancelled = true;
      session.current?.recognition?.abort();
      if (session.current?.recorder?.state === 'recording') session.current.recorder.stop();
      release();
      session.current = null;
    },
    [release],
  );

  return { phase, seconds, levels, heard, start, finish, cancel };
}
