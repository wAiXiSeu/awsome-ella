import type { RowBase } from './types'

/**
 * Spec §5.4 — server `updated_at` LWW, then bigger `seq`, then bigger `device_id`.
 * Never uses client wall clocks; only server stamps are compared as time.
 */
export function incomingWins(local: RowBase | null, incoming: RowBase): boolean {
  if (!local) return true
  const lu = local.updatedAt, iu = incoming.updatedAt
  if (lu === null && iu === null) return tieBreak(local, incoming)
  if (lu === null) return true    // local never confirmed by the server: server-stamped data wins (spec §5.4)
  if (iu === null) return false   // unstamped incoming never overwrites a stamped local
  if (lu !== iu) return iu > lu
  return tieBreak(local, incoming)
}

function tieBreak(local: RowBase, incoming: RowBase): boolean {
  if (local.seq !== incoming.seq) return incoming.seq > local.seq
  return incoming.deviceId >= local.deviceId
}

/** ISO strings compare lexicographically: all server stamps are UTC `timestamptz` rendered with `Z`. */
export function isoMax(a: string, b: string): string { return a >= b ? a : b }
