/**
 * 朗读 (CONV-13): one reply read aloud at a time, through the TTS service when one serves the
 * member, else the browser's own voice. The reply's prose only (lib/speech.ts), in parts: the
 * service takes up to SPEECH_TEXT_MAX characters a request and the next part is fetched while
 * this one plays; the browser's voice gets short parts, which it stops less often on.
 */

import { useSyncExternalStore } from 'react';
import { SPEECH_TEXT_MAX } from '@greenhouse/contract';
import { api } from '../lib/api';
import { speechChunks, speechText } from '../lib/speech';

export type ReadAloudMode = 'service' | 'browser';

/** How replies are read here, or null when they can't be (no service, no voice in the browser). */
export function readAloudMode(tts: boolean | undefined): ReadAloudMode | null {
  if (tts) return 'service';
  return typeof window !== 'undefined' && window.speechSynthesis ? 'browser' : null;
}

/** The browser's voice is cut off on long utterances in some browsers: short parts. */
const BROWSER_PART = 200;

interface Reading {
  id: string;
  stop(): void;
}

let reading: Reading | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether this reply is the one being read. */
export function useReading(id: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reading?.id === id,
    () => false,
  );
}

/** Stops whatever is being read. */
export function stopReading() {
  const current = reading;
  reading = null;
  current?.stop();
  changed();
}

/**
 * Reads a reply's Markdown aloud, stopping any other first. Resolves when it has finished or was
 * stopped; rejects when the service failed (the caller says so). Nothing to say resolves at once.
 */
export function readAloud(
  id: string,
  markdown: string,
  options: { mode: ReadAloudMode; locale: 'zh' | 'en' },
): Promise<void> {
  stopReading();
  const text = speechText(markdown);
  if (!text) return Promise.resolve();
  return options.mode === 'service' ? viaService(id, text) : viaBrowser(id, text, options.locale);
}

function viaService(id: string, text: string): Promise<void> {
  const parts = speechChunks(text, SPEECH_TEXT_MAX);
  return new Promise<void>((resolve, reject) => {
    let stopped = false;
    let audio: HTMLAudioElement | null = null;
    const urls: string[] = [];
    const finish = (error?: unknown) => {
      if (stopped) return;
      stopped = true;
      audio?.pause();
      urls.forEach((url) => URL.revokeObjectURL(url));
      if (reading?.id === id) {
        reading = null;
        changed();
      }
      if (error) reject(error);
      else resolve();
    };
    reading = { id, stop: () => finish() };
    changed();
    // The next part is asked for while this one plays, so the parts follow without a gap.
    const fetchPart = (index: number) => api.voice.speak({ text: parts[index]! });
    let next: Promise<Blob> | null = fetchPart(0);
    const play = async (index: number) => {
      const blob = await next!;
      if (stopped) return;
      next = index + 1 < parts.length ? fetchPart(index + 1) : null;
      // A failed prefetch is reported when its turn comes, not as an unhandled rejection now.
      next?.catch(() => undefined);
      const url = URL.createObjectURL(blob);
      urls.push(url);
      audio = new Audio(url);
      audio.onended = () => (index + 1 < parts.length ? void play(index + 1).catch(finish) : finish());
      audio.onerror = () => finish(new Error('The audio could not be played.'));
      await audio.play();
    };
    void play(0).catch(finish);
  });
}

function viaBrowser(id: string, text: string, locale: 'zh' | 'en'): Promise<void> {
  const synth = window.speechSynthesis;
  return new Promise<void>((resolve) => {
    let stopped = false;
    const finish = () => {
      if (stopped) return;
      stopped = true;
      synth.cancel();
      if (reading?.id === id) {
        reading = null;
        changed();
      }
      resolve();
    };
    reading = { id, stop: finish };
    changed();
    const parts = speechChunks(text, BROWSER_PART);
    parts.forEach((part, index) => {
      const utterance = new SpeechSynthesisUtterance(part);
      utterance.lang = locale === 'zh' ? 'zh-CN' : 'en-US';
      if (index === parts.length - 1) utterance.onend = finish;
      utterance.onerror = finish;
      synth.speak(utterance);
    });
  });
}
