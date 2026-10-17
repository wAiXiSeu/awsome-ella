import type { RemoteRow } from './types'

/** RLS rejected a write (403 / 42501). Spec §7: a program defect — stop retrying and surface it. */
export class PermissionDeniedError extends Error {}

/** Network / 5xx / anything transient: keep the entry queued and retry with backoff (spec §7). */
export class RetryableError extends Error {}

/**
 * The only remote surface the SyncEngine knows. SupabaseGateway implements it; FakeGateway backs
 * every local test, so the engine is verified without an instance.
 */
export interface RemoteGateway {
  upsertRows(table: string, rows: RemoteRow[]): Promise<void>
  fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]>
  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void
  uploadObject(path: string, blob: Blob): Promise<void>
}
