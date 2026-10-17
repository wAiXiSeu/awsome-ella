import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseGateway } from '../../src/core/supabaseGateway'
import { PermissionDeniedError, RetryableError } from '../../src/core/gateway'

/**
 * Only the error mapping and the call shape are pinned here — real network behaviour is
 * Task 11 Step 5 (🚫CRED). A stub client is enough because SupabaseGateway is pure translation.
 */
function stubClient(result: { error?: unknown; data?: unknown }) {
  const calls: string[] = []
  const sb = {
    from: (table: string) => ({
      upsert: async (rows: unknown[]) => { calls.push(`upsert:${table}:${rows.length}`); return result },
      select: () => ({
        gte: (column: string, watermark: string) => ({
          limit: (n: number) => { calls.push(`select:${table}:${column}>=${watermark}:limit${n}`); return Promise.resolve(result) },
        }),
      }),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => { calls.push(`upload:${bucket}:${path}`); return result },
      }),
    },
  }
  return { sb: sb as unknown as SupabaseClient, calls }
}

describe('SupabaseGateway error mapping (spec §7)', () => {
  it('maps RLS rejection (42501) to PermissionDeniedError', async () => {
    const { sb, calls } = stubClient({ error: { code: '42501', message: 'row-level security' } })
    const gw = new SupabaseGateway(sb, 'album')
    await expect(gw.upsertRows('students', [{ id: 'a' }])).rejects.toBeInstanceOf(PermissionDeniedError)
    expect(calls).toEqual(['upsert:students:1'])
  })

  it('maps a 403 status to PermissionDeniedError too', async () => {
    const { sb } = stubClient({ error: { status: 403, message: 'forbidden' } })
    const gw = new SupabaseGateway(sb, 'album')
    await expect(gw.fetchUpdatedSince('students', '2026-01-01T00:00:00Z')).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  it('maps any other failure to RetryableError, never dropping it', async () => {
    const { sb } = stubClient({ error: { code: 'PGRST116', message: 'connection timeout' } })
    const gw = new SupabaseGateway(sb, 'album')
    await expect(gw.upsertRows('students', [{ id: 'a' }])).rejects.toBeInstanceOf(RetryableError)
  })

  it('returns fetched rows and uploads to the configured bucket', async () => {
    const { sb, calls } = stubClient({ data: [{ id: 'a', updated_at: '2026-10-17T00:00:00Z' }] })
    const gw = new SupabaseGateway(sb, 'album')
    expect(await gw.fetchUpdatedSince('students', '2026-01-01T00:00:00Z')).toEqual([{ id: 'a', updated_at: '2026-10-17T00:00:00Z' }])
    await gw.uploadObject('albums/img-1', new Blob(['x']))
    expect(calls).toEqual([
      'select:students:updated_at>=2026-01-01T00:00:00Z:limit500',
      'upload:album:albums/img-1',
    ])
  })
})
