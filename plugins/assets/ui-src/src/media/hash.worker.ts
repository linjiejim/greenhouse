/// <reference lib="webworker" />
/**
 * sha256 of a File, off the main thread. Small files go through WebCrypto in one call;
 * large ones (videos up to 1 GB) stream through an incremental hash in 8 MB slices, so the
 * page never holds the whole file in memory.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const ONE_SHOT_MAX = 64 * 1024 * 1024;
const SLICE = 8 * 1024 * 1024;

self.onmessage = async (event: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = event.data;
  try {
    if (file.size <= ONE_SHOT_MAX && self.crypto?.subtle) {
      const digest = await self.crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      self.postMessage({ id, hex: bytesToHex(new Uint8Array(digest)) });
      return;
    }
    const hash = sha256.create();
    for (let offset = 0; offset < file.size; offset += SLICE) {
      hash.update(new Uint8Array(await file.slice(offset, offset + SLICE).arrayBuffer()));
      self.postMessage({ id, progress: Math.min(1, (offset + SLICE) / file.size) });
    }
    self.postMessage({ id, hex: bytesToHex(hash.digest()) });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
