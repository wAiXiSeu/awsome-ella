import type { WbDb, ImageRecord } from './db'
import type { MetaStore } from './meta'

/** Bucket name lives in the gateway/env, never in a row (spec §2.1). */
export function objectPathFor(imageId: string): string { return `albums/${imageId}` }

/** Pure string decode — no canvas, works in both browser and node tests. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * Blob-first image store (spec §5.5): bytes live in IndexedDB, rows keep only the object path.
 * The upload entry takes a `seq` at add time, so any business row written afterwards has a higher
 * `seq` and therefore pushes later — the object exists before the row that points at it.
 */
export class ImageStore {
  constructor(private db: WbDb, private meta: MetaStore, private deviceId: string, private ownerUid: () => string | null) {}

  async addLocal(imageId: string, blob: Blob): Promise<void> {
    const objectPath = objectPathFor(imageId)
    await this.db.transaction('rw', this.db.images, this.db.outbox, this.db.syncMeta, async () => {
      const seq = await this.meta.nextSeq()
      const rec: ImageRecord = { id: imageId, blob, ownerId: this.ownerUid(), objectPath, uploaded: false }
      await this.db.images.put(rec)
      await this.db.outbox.put({
        seq, table: '__image__', recordId: imageId, op: 'upload_image',
        payload: { imageId, objectPath, seq, deviceId: this.deviceId },
        attempts: 0, nextAttemptAt: 0, blocked: false,
      })
    })
  }

  /** Viewing always reads local (spec §5.5) — offline photos are visible immediately. */
  async getBlob(imageId: string): Promise<Blob | undefined> { return (await this.db.images.get(imageId))?.blob }
  async isUploaded(imageId: string): Promise<boolean> { return !!(await this.db.images.get(imageId))?.uploaded }

  /** Called by SyncEngine once the object exists remotely; the blob stays local (spec §5.5). */
  async markUploaded(imageId: string): Promise<void> { await this.db.images.update(imageId, { uploaded: true }) }
}

/**
 * Spec §7 last row: nag about quota BEFORE a write fails. Returns null where the API is absent
 * (node/vitest), a message when usage crosses 80% of quota or the absolute threshold.
 */
export async function quotaNag(thresholdBytes = 256 * 1024 * 1024): Promise<string | null> {
  const storage = (globalThis.navigator as { storage?: { estimate?(): Promise<{ usage?: number; quota?: number }> } } | undefined)?.storage
  if (!storage?.estimate) return null                      // absent in node/vitest, present in Chromium browsers
  const { usage = 0, quota = Number.POSITIVE_INFINITY } = await storage.estimate()
  return usage > Math.min(quota * 0.8, thresholdBytes) ? '存储空间接近上限，建议清理相册原图' : null
}
