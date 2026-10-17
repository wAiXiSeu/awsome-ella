export interface RowBase {
  id: string
  ownerId: string | null   // server-side authoritative; local copy may be null pre-auth
  seq: number              // local monotonic, clock-independent tiebreaker
  updatedAt: string | null // SERVER timestamp only; null = never confirmed by server
  deletedAt: string | null // soft-delete tombstone
  deviceId: string
}

export type Row = RowBase & Record<string, unknown>

export interface OutboxEntry {
  seq: number
  table: string
  recordId: string
  op: 'upsert' | 'delete' | 'upload_image'
  payload: Record<string, unknown>
  attempts: number
  nextAttemptAt: number    // epoch ms
  blocked: boolean         // RLS 403: stop retrying, surface error (spec §7)
  lastError?: string
}

export type RemoteRow = Record<string, unknown>
