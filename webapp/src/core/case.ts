import type { RemoteRow } from './types'

const c2s = new Map<string, string>()
const s2c = new Map<string, string>()

export function camelToSnake(k: string): string {
  let v = c2s.get(k)
  if (v !== undefined) return v
  v = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase())
  c2s.set(k, v)
  return v
}

export function snakeToCamel(k: string): string {
  let v = s2c.get(k)
  if (v !== undefined) return v
  v = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  s2c.set(k, v)
  return v
}

/** Push payload boundary: no client `updated_at` (the SQL trigger owns it), `owner_id` injected (spec §5.2/§5.4). */
export function toRemoteRow(row: Record<string, unknown>, ownerUid: string): RemoteRow {
  const out: RemoteRow = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'updatedAt' || k === 'updated_at') continue
    if (k === 'ownerId') { out.owner_id = ownerUid; continue }
    out[camelToSnake(k)] = v
  }
  out.owner_id = ownerUid
  return out
}

/** Pull boundary: server snake_case row back into the local camelCase shape. */
export function fromRemoteRow(r: RemoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) out[snakeToCamel(k)] = v
  return out
}
