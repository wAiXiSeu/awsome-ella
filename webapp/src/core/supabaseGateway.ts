import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemoteGateway } from './gateway'
import { PermissionDeniedError, RetryableError } from './gateway'
import type { RemoteRow } from './types'

/** The only module that touches supabase-js; everything else talks to `RemoteGateway` (spec §3). */

interface PostgrestLikeError { code?: string; status?: number; message?: string }

/** RLS rejection is a program defect (spec §7); anything else is transient and stays queued. */
function wrap(err: PostgrestLikeError | null, ctx: string): Error {
  if (!err) return new RetryableError(ctx)
  if (err.status === 403 || err.code === '42501') return new PermissionDeniedError(`${ctx}: RLS 拒绝 (${err.code ?? err.status})`)
  return new RetryableError(`${ctx}: ${err.message ?? JSON.stringify(err)}`)
}

export class SupabaseGateway implements RemoteGateway {
  constructor(private sb: SupabaseClient, private bucket: string) {}

  async upsertRows(table: string, rows: RemoteRow[]): Promise<void> {
    const { error } = await this.sb.from(table).upsert(rows, { onConflict: 'id' })
    if (error) throw wrap(error as PostgrestLikeError, `upsert ${table}`)
  }

  async fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]> {
    // `gte`, not `gt`: a batch written in one transaction shares the same now(), so an exclusive
    // bound would permanently skip rows that share the boundary stamp once limit(500) truncates.
    // Re-applying a known row is harmless — the conflict rule is idempotent (spec §5.4).
    const { data, error } = await this.sb.from(table).select('*').gte('updated_at', watermark).limit(500)
    if (error) throw wrap(error as PostgrestLikeError, `fetch ${table}`)
    return (data ?? []) as RemoteRow[]
  }

  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void {
    const ch = this.sb.channel('rt-' + table)
      .on('postgres_changes', { event: '*', schema: 'public', table }, (payload: { new?: unknown }) => {
        // DELETE events carry no `new`; tombstones arrive through the catch-up pull instead
        if (payload.new) onRow(payload.new as RemoteRow)
      })
      .subscribe()
    return () => { void this.sb.removeChannel(ch) }
  }

  async uploadObject(path: string, blob: Blob): Promise<void> {
    const { error } = await this.sb.storage.from(this.bucket).upload(path, blob, { upsert: true })
    if (error) throw wrap(error as PostgrestLikeError, `upload ${path}`)
  }
}
