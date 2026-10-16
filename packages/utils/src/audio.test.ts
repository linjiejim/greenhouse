import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audioSeconds } from './audio.js';

/** 2.5 s of a 440 Hz tone, made with ffmpeg in each container (see __fixtures__/audio). */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/audio/${name}`, import.meta.url)));

/** A PCM WAV of `seconds` at `rate`, 16-bit mono; `size` overrides the data size written. */
function wav(seconds: number, rate = 16_000, size?: number): Uint8Array {
  const data = Math.round(seconds * rate) * 2;
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  const text = (at: number, value: string) =>
    [...value].forEach((char, index) => (bytes[at + index] = char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, size ?? data, true);
  return bytes;
}

describe('audioSeconds', () => {
  it('reads WAV, also when the recorder never wrote the data size', () => {
    expect(audioSeconds(wav(3))).toBe(3);
    expect(audioSeconds(wav(1.5, 8_000, 0xffffffff))).toBe(1.5);
  });

  it.each([
    ['tone.ogg', 'Ogg Opus'],
    ['tone.webm', 'WebM with a duration'],
    ['tone-live.webm', 'WebM as MediaRecorder writes it, without a duration'],
    ['tone.m4a', 'M4A'],
    ['tone-fragmented.mp4', 'fragmented MP4, as Safari records'],
    ['tone-cbr.mp3', 'MP3 without a Xing header, frame by frame'],
    ['tone-vbr.mp3', 'MP3 with a Xing header'],
    ['tone.flac', 'FLAC'],
    ['tone.aac', 'AAC in ADTS'],
  ])('reads %s (%s)', (name) => {
    const seconds = audioSeconds(fixture(name));
    expect(seconds).not.toBeNull();
    // The encoders pad a frame or two: within a tenth of a second of 2.5 s.
    expect(Math.abs(seconds! - 2.5)).toBeLessThan(0.15);
  });

  it('says nothing for what it does not know or cannot read', () => {
    expect(audioSeconds(new TextEncoder().encode('hello, this is not audio at all'))).toBeNull();
    expect(audioSeconds(new Uint8Array(0))).toBeNull();
    // Cut short: the header promises more than there is, and nothing usable comes before the cut.
    expect(audioSeconds(fixture('tone.m4a').subarray(0, 40))).toBeNull();
    expect(audioSeconds(fixture('tone.flac').subarray(0, 20))).toBeNull();
  });

  it('never fails on noise', () => {
    let seed = 7;
    const noise = new Uint8Array(4096).map(() => (seed = (seed * 1103515245 + 12345) & 0xff));
    for (const head of [
      [0x1a, 0x45, 0xdf, 0xa3],
      [0x4f, 0x67, 0x67, 0x53],
      [0xff, 0xfb],
      [0x49, 0x44, 0x33],
    ]) {
      const bytes = new Uint8Array([...head, ...noise]);
      expect(() => audioSeconds(bytes)).not.toThrow();
    }
  });
});
