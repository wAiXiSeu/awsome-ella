import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { Outbox } from '../../src/core/outbox'
import { SyncEngine } from '../../src/core/syncEngine'
import { addTableDef, tableDef, type TableDef } from '../../src/core/schema'
import { FakeGateway } from '../fakeGateway'
import type { Row } from '../../src/core/types'

// Pull/subscribe iterate the schema registry (that is the architecture), so the scratch table has
// to be a registered def — exactly the path acceptance criterion 6 requires. The registry is
// module-global, so only the first device in this file adds the def; later dbs just wire up.
const NOTES: TableDef = { name: 'notes', columns: ['title'] }

/** The realtime handler is fire-and-forget, so poll until its Dexie transaction lands. */
async function untilApplied<T>(read: () => Promise<T>, timeoutMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for realtime apply')
    await new Promise(r => setTimeout(r, 5))
  }
}

async function mk() {
  const db: WbDb = await openDb('spl-' + Math.random())
  if (tableDef('notes')) await db.registerTable('notes')
  else await addTableDef(db, NOTES)
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  const gateway = new FakeGateway()
  const engine = new SyncEngine({
    store, outbox: new Outbox(db), meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
  })
  return { db, meta, store, gateway, engine }
}

describe('SyncEngine pull (spec §5.3)', () => {
  it('catch-up pull applies remote rows and advances watermark', async () => {
    const { store, meta, gateway, engine } = await mk()
    await gateway.upsertRows('notes', [{ id: 'n1', owner_id: 'u-1', seq: 1, device_id: 'dev-B' }])
    await engine.syncOnce()
    expect(await store.get('notes', 'n1')).toBeTruthy()
    const wm = await meta.getWatermark()
    expect(wm).toBe(await gateway.fetchUpdatedSince('notes', '1970-01-01T00:00:00.000Z').then(r => r[0].updated_at))
    await engine.syncOnce()                              // idempotent second pass
    expect(await store.get('notes', 'n1')).toBeTruthy()
  })

  it('realtime event lands in LocalStore without manual sync', async () => {
    const { store, gateway, engine } = await mk()
    engine.start()
    await gateway.upsertRows('notes', [{ id: 'rt1', owner_id: 'u-1', seq: 1, device_id: 'dev-B', title: 'live' }])
    const got = await untilApplied(() => store.get('notes', 'rt1'))
    expect(got!.title).toBe('live')
    engine.stop()
  })

  it('watermark makes a second fetch return nothing new', async () => {
    const { meta, gateway, engine } = await mk()
    await gateway.upsertRows('notes', [{ id: 'n1', owner_id: 'u-1', seq: 1, device_id: 'dev-B' }])
    await engine.syncOnce()
    const wm = await meta.getWatermark()
    expect(await gateway.fetchUpdatedSince('notes', wm)).toEqual([])
  })
})
