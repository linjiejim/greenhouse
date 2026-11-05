/**
 * Background work, run by host job claims so a second replica never doubles it:
 *   - every minute: re-hash a few new originals (the browser's sha256 is only a claim)
 *     and catalogue a few assets with AI;
 *   - nightly: remove unfinished uploads and empty the bin.
 * Each step is bounded and safe to repeat after a crash.
 */
import { createHash } from 'node:crypto';
import { findBudgetRefusal, logger, notify, toErrorMessage } from '@greenhouse/api/extension-kit';
import { aiEnabled, extractAsset, objects } from './ai.js';
import { BIN_DAYS, MAX_FRAMES, objectKeys, STALE_UPLOAD_HOURS } from './model.js';
import type { AssetRow } from './schema.js';
import { assetStore } from './services.js';

const VERIFY_PER_RUN = 4;
const AI_PER_RUN = 4;
/** A `running` claim older than this is a crashed worker's; take it over. */
const AI_STALE_MINUTES = 10;

/** Every object an asset may have, for deletion. */
export function assetObjectKeys(asset: Pick<AssetRow, 'sha256' | 'ext'>): string[] {
  return [
    objectKeys.original(asset.sha256, asset.ext),
    objectKeys.thumb(asset.sha256),
    objectKeys.preview(asset.sha256),
    ...Array.from({ length: MAX_FRAMES }, (_, i) => objectKeys.frame(asset.sha256, i)),
  ];
}

/** Deleting a missing object succeeds on every backend; any other failure propagates so the row is kept for a retry. */
export async function deleteAssetObjects(asset: Pick<AssetRow, 'sha256' | 'ext'>): Promise<void> {
  for (const key of assetObjectKeys(asset)) await objects.delete(key);
}

/** Stream the stored original and compare its sha256 with the one the browser claimed. */
export async function verifyAsset(asset: AssetRow): Promise<'ok' | 'mismatch' | 'missing'> {
  const opened = await objects.open(objectKeys.original(asset.sha256, asset.ext));
  if (!opened || opened === 'unsatisfiable') return 'missing';
  const hash = createHash('sha256');
  const reader = opened.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex') === asset.sha256 ? 'ok' : 'mismatch';
}

export async function runVerification(limit = VERIFY_PER_RUN): Promise<number> {
  const store = assetStore();
  let done = 0;
  for (const asset of await store.unverified(limit)) {
    const outcome = await verifyAsset(asset).catch((err) => {
      logger.warn('[assets] verification failed', { asset: asset.id, error: toErrorMessage(err) });
      return null;
    });
    if (outcome === 'ok') await store.markVerified(asset.id);
    if (outcome === 'mismatch' || outcome === 'missing') {
      // The bytes are not what the row says: nobody can rely on this asset. Claim it first so
      // no re-upload of the same content reuses the keys while they are being deleted.
      const claimed = await store.claimPurge(asset.id, ['active']);
      if (!claimed) continue;
      await deleteAssetObjects(asset);
      await store.finishInvalid(asset.id);
      await notify({
        user_id: asset.uploaded_by,
        kind: 'ext:assets:rejected',
        title: 'An upload could not be verified',
        body: `“${asset.display_title}” did not match its fingerprint and was removed. Please upload it again.`,
        payload: { asset_id: asset.id },
        dedupe_key: `assets-rejected-${asset.id}`,
      }).catch(() => {});
    }
    done += 1;
  }
  return done;
}

export async function runAiQueue(limit = AI_PER_RUN): Promise<number> {
  if (!(await aiEnabled())) return 0;
  const store = assetStore();
  const staleBefore = new Date(Date.now() - AI_STALE_MINUTES * 60_000).toISOString();
  const claimed = await store.claimAi(limit, staleBefore);
  if (!claimed.length) return 0;
  const defs = await store.facetDefs();
  for (const asset of claimed) {
    try {
      await store.saveAi(asset.id, await extractAsset(asset, defs, asset.uploaded_by));
    } catch (err) {
      const refusal = findBudgetRefusal(err);
      await store.failAi(asset.id, refusal ? `Over budget: ${refusal.message}` : toErrorMessage(err));
    }
  }
  return claimed.length;
}

export async function runCleanup(now = Date.now()): Promise<{ stale: number; purged: number }> {
  const store = assetStore();
  const staleBefore = new Date(now - STALE_UPLOAD_HOURS * 3_600_000).toISOString();
  const binBefore = new Date(now - BIN_DAYS * 86_400_000).toISOString();
  let stale = 0;
  let purged = 0;
  // Claim, delete objects, then drop the row: a failure leaves a `purging` row the next run retries.
  for (const asset of await store.staleUploads(staleBefore)) {
    if (!(await store.claimPurge(asset.id, ['uploading'], { uploadsExpired: true }))) continue;
    try {
      await deleteAssetObjects(asset);
      if (await store.removeRow(asset.id, 'purging')) stale += 1;
    } catch (err) {
      logger.warn('[assets] cleanup of an unfinished upload failed', { asset: asset.id, error: toErrorMessage(err) });
    }
  }
  for (const asset of await store.binnedBefore(binBefore)) {
    if (!(await store.claimPurge(asset.id, ['deleted', 'invalid', 'purging']))) continue;
    try {
      await deleteAssetObjects(asset);
      if (await store.removeRow(asset.id, 'purging')) purged += 1;
    } catch (err) {
      logger.warn('[assets] emptying the bin failed', { asset: asset.id, error: toErrorMessage(err) });
    }
  }
  return { stale, purged };
}
