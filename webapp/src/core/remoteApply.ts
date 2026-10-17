import type { LocalStore } from './localStore'
import type { MetaStore } from './meta'
import { isoMax } from './conflict'
import type { RemoteRow } from './types'

/**
 * Apply a fetched batch through the conflict rule, then advance the watermark
 * (spec §5.3 「补拉后推进水位线»).
 *
 * The watermark advances from the stamps of ALL fetched rows, even ones that lost the conflict:
 * the server timestamp is real regardless, so skipping it would stall the watermark forever.
 */
export async function applyRemoteRows(
  store: LocalStore, meta: MetaStore, table: string, rows: RemoteRow[],
): Promise<{ applied: number; newWatermark: string }> {
  let max = await meta.getWatermark()
  for (const raw of rows) {
    const ua = raw.updated_at
    if (typeof ua === 'string') max = isoMax(max, ua)
  }
  await store.applyRemoteBulk(table, rows)
  await meta.setWatermark(max)
  return { applied: rows.length, newWatermark: max }
}
