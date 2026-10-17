import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { applyRemoteRows } from '../../src/core/remoteApply'
import type { Row } from '../../src/core/types'

async function mk(seed = 'ra') {
  const db = await openDb(seed + '-' + Math.random())
  await db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  return { db, meta, store }
}

const rem = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'n1', owner_id: 'u-1', seq: 1, updated_at: '2026-10-17T00:00:00Z', deleted_at: null, device_id: 'dev-A', ...over })

describe('applyRemoteRows + watermark', () => {
  let bundle: { db: WbDb; meta: MetaStore; store: LocalStore }
  beforeEach(async () => { bundle = await mk() })

  it('applies newer incoming, keeps newer local edit, advances watermark to max seen', async () => {
    const { store, meta } = bundle
    await store.put('notes', { id: 'n1', title: 'local-edit' })
    await store.applyRemote('notes', { ...rem({ updated_at: '2026-10-17T00:00:05Z' }), id: 'n2' })
    const r = await applyRemoteRows(store, meta, 'notes', [
      rem({ title: 'server-wins', updated_at: '2026-10-17T00:00:10Z' }),
      rem({ id: 'n3', updated_at: '2026-10-17T00:00:02Z' }),
    ])
    expect((await store.get('notes', 'n1'))!.title).toBe('server-wins')   // stamped-newer wins over unpushed local edit
    expect(await store.get('notes', 'n3')).toBeDefined()                   // fresh server row applied
    expect(r.newWatermark).toBe('2026-10-17T00:00:10Z')
    expect(await meta.getWatermark()).toBe('2026-10-17T00:00:10Z')
  })

  it('older incoming cannot overwrite stamped local (server-side newer edit already applied)', async () => {
    const { store, meta } = bundle
    await store.applyRemote('notes', rem({ title: 'v2', updated_at: '2026-10-17T00:00:05Z' }))
    await applyRemoteRows(store, meta, 'notes', [rem({ title: 'v1-old', updated_at: '2026-10-17T00:00:01Z' })])
    expect((await store.get('notes', 'n1'))!.title).toBe('v2')
  })

  it('empty fetch does not move the watermark', async () => {
    const { store, meta } = bundle
    await meta.setWatermark('2026-10-17T00:00:00Z')
    const r = await applyRemoteRows(store, meta, 'notes', [])
    expect(r.newWatermark).toBe('2026-10-17T00:00:00Z')
  })
})
