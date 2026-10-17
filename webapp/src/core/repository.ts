import type { LocalStore } from './localStore'
import { objectPathFor, type ImageStore } from './images'
import type { Row } from './types'

/**
 * The only door business modules touch (spec §3): they never import Dexie or Supabase, they get a
 * Repository built over LocalStore. Writes go to local storage first and are queued for sync by
 * LocalStore in the same transaction, so every method here behaves the same online and offline.
 */
export class Repository<T extends Record<string, unknown>> {
  constructor(private table: string, private store: LocalStore, private images: ImageStore) {}

  create(fields: T): Promise<Row> {
    return this.store.put(this.table, { ...fields, id: crypto.randomUUID() } as T & { id: string })
  }

  /** Patch semantics: LocalStore merges with the stored row, so partial updates are safe. */
  update(id: string, patch: Partial<T>): Promise<Row> {
    return this.store.put(this.table, { ...patch, id } as T & { id: string })
  }

  /** Soft delete only — the tombstone is what syncs (spec §4). */
  remove(id: string): Promise<void> {
    return this.store.softDelete(this.table, id)
  }

  get(id: string): Promise<Row | undefined> { return this.store.get(this.table, id) }

  /** Live rows (tombstones filtered out). UI reads only ever come from here. */
  list(): Promise<Row[]> { return this.store.live(this.table) }

  /**
   * Stores the bytes locally and writes only the object path onto the row. The blob's upload entry
   * takes its seq here, before the row update below, so the object is queued ahead of its reference.
   */
  async attachImage(recordId: string, field: string, blob: Blob): Promise<{ imageId: string; objectPath: string }> {
    const imageId = crypto.randomUUID()
    const objectPath = objectPathFor(imageId)
    await this.images.addLocal(imageId, blob)
    await this.update(recordId, { [field]: objectPath } as Partial<T>)
    return { imageId, objectPath }
  }
}
