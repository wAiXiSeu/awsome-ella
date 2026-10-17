import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import type { Row, RowBase } from '../../src/core/types'

async function makeLocal(db: WbDb) {
  await db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: (n) => db.business.get(n) as Table<Row, string>,
  })
  return { meta, store }
}

describe('LocalStore write path (spec §5.1)', () => {
  let db: WbDb
  beforeEach(async () => { db = await openDb('lw-' + Math.random()) })

  it('put writes row + outbox entry atomically, seq monotonic', async () => {
    const { store } = await makeLocal(db)
    const r1 = await store.put('notes', { id: 'n1', title: 'a' })
    const r2 = await store.put('notes', { id: 'n2', title: 'b' })
    expect(r2.seq).toBeGreaterThan(r1.seq)
    expect(r1.deletedAt).toBeNull()
    const ob = await db.outbox.toArray()
    expect(ob.map(e => e.seq)).toEqual([r1.seq, r2.seq])          // ascending, one per write
    expect(ob[0].op).toBe('upsert')
    expect(ob[0].payload.title).toBe('a')
    expect(ob[0].payload.updatedAt).toBeUndefined()               // client never supplies it
    expect((ob[0].payload as Record<string, unknown>).ownerId).toBe('u-1')
  })

  it('put merges into existing row and keeps server updatedAt', async () => {
    const { store } = await makeLocal(db)
    await store.put('notes', { id: 'n1', title: 'a' })
    await store.applyRemote('notes', { id: 'n1', owner_id: 'u-1', seq: 7, updated_at: '2026-10-17T05:00:00Z', deleted_at: null, device_id: 'dev-A', title: 'a' })
    const r = await store.put('notes', { id: 'n1', title: 'a2' })
    expect(r.updatedAt).toBe('2026-10-17T05:00:00Z')
    expect((await db.outbox.toArray()).length).toBe(2)            // both writes queued
  })

  it('softDelete is a tombstone + queued delete, row hidden from live()', async () => {
    const { store } = await makeLocal(db)
    await store.put('notes', { id: 'n1', title: 'a' })
    await store.softDelete('notes', 'n1')
    expect(await store.live('notes')).toEqual([])
    const raw = await store.get('notes', 'n1')
    expect(raw!.deletedAt).not.toBeNull()
    const ob = await db.outbox.toArray()
    expect(ob[1].op).toBe('delete')
    expect((ob[1].payload as RowBase).deletedAt).not.toBeNull()
  })

  it('pendingCount mirrors outbox size', async () => {
    const { store } = await makeLocal(db)
    expect(await store.pendingCount()).toBe(0)
    await store.put('notes', { id: 'n1' })
    expect(await store.pendingCount()).toBe(1)
  })
})
