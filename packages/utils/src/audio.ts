/**
 * How long a piece of audio lasts, read from its container, without decoding it. The API bounds
 * what it sends to a transcription service with it, and records the seconds a transcription used
 * when the service does not say (docs/product/providers.md §8).
 *
 * Knows WAV, FLAC, Ogg (Opus, Vorbis), WebM / Matroska (with or without a duration: a browser's
 * MediaRecorder writes none, so the blocks are read), MP4 / M4A (plain and fragmented, as Safari
 * records), MP3 (from its Xing / VBRI header, else frame by frame) and AAC in ADTS. Anything else,
 * or a file too broken to read, is null: unknown, never a guess.
 */

const ascii = (bytes: Uint8Array, at: number, length: number) =>
  at + length <= bytes.length ? String.fromCharCode(...bytes.subarray(at, at + length)) : '';

const round = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Seconds of audio in `bytes`, or null when the format is unknown or the file says nothing usable. */
export function audioSeconds(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let seconds: number | null;
  try {
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') seconds = wav(bytes, view);
    else if (ascii(bytes, 0, 4) === 'fLaC') seconds = flac(bytes);
    else if (ascii(bytes, 0, 4) === 'OggS') seconds = ogg(bytes, view);
    else if (view.getUint32(0) === 0x1a45dfa3) seconds = matroska(bytes, view);
    else if (ascii(bytes, 4, 4) === 'ftyp') seconds = mp4(bytes, view);
    else seconds = mpegOrAdts(bytes, view);
  } catch {
    // A file cut short or lying about its sizes: unknown, not an error.
    return null;
  }
  return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? round(seconds) : null;
}

// ─── WAV ──────────────────────────────────────────────────

function wav(bytes: Uint8Array, view: DataView): number | null {
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = view.getUint32(at + 16, true);
    if (id === 'data') {
      const available = bytes.length - (at + 8);
      // A recorder that never went back to write the size leaves it at its maximum.
      const data = size === 0xffffffff || size > available ? available : size;
      return byteRate ? data / byteRate : null;
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

// ─── FLAC ─────────────────────────────────────────────────

function flac(bytes: Uint8Array): number | null {
  // STREAMINFO is always the first metadata block, right after "fLaC" and its 4-byte header.
  const s = 8;
  if (s + 18 > bytes.length || (bytes[4]! & 0x7f) !== 0) return null;
  const rate = (bytes[s + 10]! << 12) | (bytes[s + 11]! << 4) | (bytes[s + 12]! >> 4);
  const high = bytes[s + 13]! & 0x0f;
  const low = ((bytes[s + 14]! << 24) | (bytes[s + 15]! << 16) | (bytes[s + 16]! << 8) | bytes[s + 17]!) >>> 0;
  const samples = high * 2 ** 32 + low;
  return rate && samples ? samples / rate : null;
}

// ─── Ogg ──────────────────────────────────────────────────

function ogg(bytes: Uint8Array, view: DataView): number | null {
  let at = 0;
  let serial: number | null = null;
  let rate = 0;
  let skip = 0;
  let last = -1;
  while (at + 27 <= bytes.length && ascii(bytes, at, 4) === 'OggS') {
    const granule = view.getBigInt64(at + 6, true);
    const pageSerial = view.getUint32(at + 14, true);
    const segments = bytes[at + 26]!;
    let body = 0;
    for (let index = 0; index < segments; index++) body += bytes[at + 27 + index] ?? 0;
    const start = at + 27 + segments;
    if (serial === null) {
      serial = pageSerial;
      if (ascii(bytes, start, 8) === 'OpusHead') {
        // Opus counts in 48 kHz whatever was recorded; the first samples are padding.
        rate = 48_000;
        skip = view.getUint16(start + 10, true);
      } else if (bytes[start] === 1 && ascii(bytes, start + 1, 6) === 'vorbis') {
        rate = view.getUint32(start + 12, true);
      } else {
        return null;
      }
    }
    if (pageSerial === serial && granule >= 0n) last = Number(granule);
    at = start + body;
  }
  return rate && last >= 0 ? (last - skip) / rate : null;
}

// ─── WebM / Matroska ──────────────────────────────────────

/** An EBML variable-length integer: an element id keeps its marker bits, a size loses them. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (length > 8 || at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[at + index]!;
    if (bytes[at + index] !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const CLUSTER = 0x1f43b675;
const BLOCK_GROUP = 0xa0;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CLUSTER_TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK = 0xa1;

function matroska(bytes: Uint8Array, view: DataView): number | null {
  let scale = 1_000_000;
  let duration = 0;
  let clusterTime = 0;
  let lastBlock = -1;
  let at = 0;
  // A flat walk: containers are entered (their size may be unknown, as a live recorder writes
  // them), everything else is stepped over by its size.
  while (at < bytes.length) {
    const id = vint(bytes, at, true);
    if (!id) break;
    const size = vint(bytes, at + id.length, false);
    if (!size) break;
    at += id.length + size.length;
    if (id.value === SEGMENT || id.value === INFO || id.value === CLUSTER || id.value === BLOCK_GROUP) continue;
    if (size.unknown) break;
    const end = at + size.value;
    if (end > bytes.length) break;
    if (id.value === TIMECODE_SCALE) scale = uintAt(bytes, at, size.value);
    else if (id.value === DURATION) {
      duration = size.value === 4 ? view.getFloat32(at) : size.value === 8 ? view.getFloat64(at) : 0;
    } else if (id.value === CLUSTER_TIMECODE) clusterTime = uintAt(bytes, at, size.value);
    else if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
      const track = vint(bytes, at, false);
      if (track && at + track.length + 2 <= end) {
        lastBlock = Math.max(lastBlock, clusterTime + view.getInt16(at + track.length));
      }
    }
    at = end;
  }
  if (duration > 0) return (duration * scale) / 1e9;
  // No duration written: the last block's start, which is within one frame of the end.
  return lastBlock >= 0 ? (lastBlock * scale) / 1e9 : null;
}

function uintAt(bytes: Uint8Array, at: number, length: number): number {
  let value = 0;
  for (let index = 0; index < length; index++) value = value * 256 + bytes[at + index]!;
  return value;
}

// ─── MP4 / M4A ────────────────────────────────────────────

interface Box {
  type: string;
  start: number;
  end: number;
}

function* boxes(bytes: Uint8Array, view: DataView, from: number, to: number): Generator<Box> {
  let at = from;
  while (at + 8 <= to) {
    let size = view.getUint32(at);
    const type = ascii(bytes, at + 4, 4);
    let header = 8;
    if (size === 1) {
      if (at + 16 > to) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) return;
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}

const child = (bytes: Uint8Array, view: DataView, parent: Box, type: string) => {
  for (const box of boxes(bytes, view, parent.start, parent.end)) if (box.type === type) return box;
  return undefined;
};

/** A full box's version, then a duration and its timescale (mvhd and mdhd share this layout). */
function timed(view: DataView, box: Box): { scale: number; duration: number } {
  const version = view.getUint8(box.start);
  return version === 1
    ? { scale: view.getUint32(box.start + 20), duration: Number(view.getBigUint64(box.start + 24)) }
    : { scale: view.getUint32(box.start + 12), duration: view.getUint32(box.start + 16) };
}

function mp4(bytes: Uint8Array, view: DataView): number | null {
  let movie: { scale: number; duration: number } | null = null;
  let media: { scale: number; duration: number } | null = null;
  let fragmentDuration = 0;
  let trexDefault = 0;
  let fragmented = 0;
  for (const top of boxes(bytes, view, 0, bytes.length)) {
    if (top.type === 'moov') {
      const mvhd = child(bytes, view, top, 'mvhd');
      if (mvhd) movie = timed(view, mvhd);
      const mvex = child(bytes, view, top, 'mvex');
      const mehd = mvex && child(bytes, view, mvex, 'mehd');
      if (mehd) {
        fragmentDuration =
          view.getUint8(mehd.start) === 1 ? Number(view.getBigUint64(mehd.start + 4)) : view.getUint32(mehd.start + 4);
      }
      const trex = mvex && child(bytes, view, mvex, 'trex');
      if (trex) trexDefault = view.getUint32(trex.start + 12);
      // The first track with a media header: a recording has one.
      for (const trak of boxes(bytes, view, top.start, top.end)) {
        if (trak.type !== 'trak') continue;
        const mdia = child(bytes, view, trak, 'mdia');
        const mdhd = mdia && child(bytes, view, mdia, 'mdhd');
        if (mdhd) {
          media = timed(view, mdhd);
          break;
        }
      }
    } else if (top.type === 'moof') {
      for (const traf of boxes(bytes, view, top.start, top.end)) {
        if (traf.type !== 'traf') continue;
        let defaultDuration = trexDefault;
        const tfhd = child(bytes, view, traf, 'tfhd');
        if (tfhd) {
          const flags = view.getUint32(tfhd.start) & 0xffffff;
          // track id, then the optional fields in flag order: base offset (8), description index (4), duration.
          let at = tfhd.start + 8;
          if (flags & 0x1) at += 8;
          if (flags & 0x2) at += 4;
          if (flags & 0x8) defaultDuration = view.getUint32(at);
        }
        for (const trun of boxes(bytes, view, traf.start, traf.end)) {
          if (trun.type !== 'trun') continue;
          const flags = view.getUint32(trun.start) & 0xffffff;
          const count = view.getUint32(trun.start + 4);
          let at = trun.start + 8;
          if (flags & 0x1) at += 4; // data offset
          if (flags & 0x4) at += 4; // first sample flags
          if (!(flags & 0x100)) {
            fragmented += count * defaultDuration;
            continue;
          }
          const stride = 4 + (flags & 0x200 ? 4 : 0) + (flags & 0x400 ? 4 : 0) + (flags & 0x800 ? 4 : 0);
          for (let index = 0; index < count && at + 4 <= trun.end; index++, at += stride) {
            fragmented += view.getUint32(at);
          }
        }
      }
    }
  }
  if (movie && movie.scale && movie.duration) return movie.duration / movie.scale;
  if (movie && movie.scale && fragmentDuration) return fragmentDuration / movie.scale;
  if (media && media.scale && media.duration) return media.duration / media.scale;
  if (media && media.scale && fragmented) return fragmented / media.scale;
  return null;
}

// ─── MP3 and AAC (ADTS) ───────────────────────────────────

const MP3_RATES = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] } as const;
const MP3_BITRATES = {
  v1l1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  v1l2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  v1l3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2l1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  v2l23: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
} as const;
const ADTS_RATES = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000, 7_350,
];

interface Mp3Frame {
  length: number;
  samples: number;
  rate: number;
  mpeg1: boolean;
  mono: boolean;
}

function mp3Frame(bytes: Uint8Array, at: number): Mp3Frame | null {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1]! & 0xe0) !== 0xe0) return null;
  const version = (bytes[at + 1]! >> 3) & 3;
  const layer = (bytes[at + 1]! >> 1) & 3;
  const bitrateIndex = bytes[at + 2]! >> 4;
  const rateIndex = (bytes[at + 2]! >> 2) & 3;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const mpeg1 = version === 3;
  const rate = MP3_RATES[version as 0 | 2 | 3][rateIndex]!;
  const table = layer === 3 ? (mpeg1 ? 'v1l1' : 'v2l1') : mpeg1 ? (layer === 2 ? 'v1l2' : 'v1l3') : 'v2l23';
  const bitrate = MP3_BITRATES[table][bitrateIndex]! * 1000;
  const padding = (bytes[at + 2]! >> 1) & 1;
  const samples = layer === 3 ? 384 : layer === 2 || mpeg1 ? 1152 : 576;
  const length =
    layer === 3
      ? Math.floor((12 * bitrate) / rate + padding) * 4
      : Math.floor(((samples / 8) * bitrate) / rate) + padding;
  return { length, samples, rate, mpeg1, mono: bytes[at + 3]! >> 6 === 3 };
}

function mpegOrAdts(bytes: Uint8Array, view: DataView): number | null {
  let at = 0;
  // An ID3v2 tag first: its size is syncsafe (7 bits a byte), plus a footer when flagged.
  if (ascii(bytes, 0, 3) === 'ID3') {
    const size =
      ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    at = 10 + size + (bytes[5]! & 0x10 ? 10 : 0);
  }
  if (bytes[at] !== 0xff) return null;
  // The layer bits are 00 in AAC's ADTS header and never in MPEG audio.
  if (((bytes[at + 1]! >> 1) & 3) === 0 && (bytes[at + 1]! & 0xf0) === 0xf0) return adts(bytes, at);
  const first = mp3Frame(bytes, at);
  if (!first) return null;
  // A VBR file says how many frames it has in its first frame: Xing / Info after the side information…
  const side = first.mpeg1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  const tag = ascii(bytes, at + 4 + side, 4);
  if ((tag === 'Xing' || tag === 'Info') && view.getUint32(at + 8 + side) & 0x1) {
    const frames = view.getUint32(at + 12 + side);
    if (frames) return (frames * first.samples) / first.rate;
  }
  // …or VBRI at a fixed place.
  if (ascii(bytes, at + 36, 4) === 'VBRI') {
    const frames = view.getUint32(at + 36 + 14);
    if (frames) return (frames * first.samples) / first.rate;
  }
  // Otherwise count the frames.
  let samples = 0;
  for (let frame: Mp3Frame | null = first; frame && frame.length > 0; frame = mp3Frame(bytes, at)) {
    if (at + frame.length > bytes.length) break;
    samples += frame.samples;
    at += frame.length;
  }
  return samples ? samples / first.rate : null;
}

function adts(bytes: Uint8Array, from: number): number | null {
  let at = from;
  let samples = 0;
  let rate = 0;
  while (at + 7 <= bytes.length && bytes[at] === 0xff && (bytes[at + 1]! & 0xf6) === 0xf0) {
    rate = ADTS_RATES[(bytes[at + 2]! >> 2) & 0xf] ?? 0;
    const length = ((bytes[at + 3]! & 0x3) << 11) | (bytes[at + 4]! << 3) | (bytes[at + 5]! >> 5);
    if (!rate || length < 7) break;
    samples += 1024 * ((bytes[at + 6]! & 0x3) + 1);
    at += length;
  }
  return rate && samples ? samples / rate : null;
}
