import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../src/core/db'
import { MetaStore } from '../src/core/meta'
import { LocalStore } from '../src/core/localStore'
import { Outbox } from '../src/core/outbox'
import { ImageStore } from '../src/core/images'
import { SyncEngine } from '../src/core/syncEngine'
import { Repository } from '../src/core/repository'
import { registerAllTables, addTableDef, tableNames } from '../src/core/schema'
import { runMigration } from '../src/core/migration'
import { FakeGateway } from './fakeGateway'
import sample from './fixtures/wb_tw_data.sample.json'
import type { Row } from '../src/core/types'

/**
 * The integration harness for spec §9: two "devices" over one FakeGateway (which stamps
 * `updated_at` like the SQL trigger and shares one server clock). Local stand-ins only — the live
 * reruns are the 🚫CRED checklist (plan Task 18 Step 5).
 */
interface Device {
  db: WbDb
  meta: MetaStore
  store: LocalStore
  outbox: Outbox
  images: ImageStore
  engine: SyncEngine
  repoOf: <T extends Record<string, unknown>>(t: string) => Repository<T>
}

async function makeDevice(name: string, deviceId: string, gateway: FakeGateway | null): Promise<Device> {
  const db = await openDb(name)
  await registerAllTables(db)                          // registry-driven: pull/subscribe iterate TABLE_DEFS,
  const meta = new MetaStore(db)                       // so every table used below must come from the registry
  const store = new LocalStore({
    db, meta, deviceId, ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  const outbox = new Outbox(db)
  const images = new ImageStore(db, meta, deviceId, () => 'u-1')
  const engine = new SyncEngine({
    store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {}, images,
  })
  return { db, meta, store, outbox, images, engine, repoOf: <T extends Record<string, unknown>>(t: string) => new Repository<T>(t, store, images) }
}

describe('spec §9 acceptance, local stand-in (criteria 1-6)', () => {
  it('A1: 30 offline writes → after reconnect the gateway holds exactly 30 rows in seq order', async () => {
    const gw = new FakeGateway()
    const dev = await makeDevice('a1', 'dev-A', null)
    for (let i = 0; i < 30; i++) await dev.store.put('todos', { id: `t${i}`, title: 'T' + i })
    expect(await dev.outbox.count()).toBe(30)
    expect(await dev.engine.pushOnce()).toBe(0)                   // offline: not one byte attempted

    // "reconnect" == page reload: a second connection to the same database, queue still there.
    const back = await makeDevice('a1', 'dev-A', gw)
    expect(await back.outbox.count()).toBe(30)                    // persisted through IndexedDB
    expect(await back.engine.pushOnce()).toBe(30)                 // BATCH=50 → one pass

    const remote = [...gw.server.get('todos')!.values()]
    expect(remote.length).toBe(30)
    expect(remote.map(r => r.seq)).toEqual([...remote.map(r => r.seq)].sort((a, b) => (a as number) - (b as number)))
    expect(new Set(remote.map(r => r.id)).size).toBe(30)          // no duplicates
    expect(await back.outbox.count()).toBe(0)
    expect(await back.engine.pushOnce()).toBe(0)                  // drained, and a re-push sends nothing
    await back.db.close(); await dev.db.close()
  })

  it('A2: two devices edit the same row → converge to one explainable state (spec §5.4)', async () => {
    const gw = new FakeGateway()
    const A = await makeDevice('a2a', 'dev-A', gw)
    const B = await makeDevice('a2b', 'dev-B', gw)
    await A.store.put('todos', { id: 'x', title: 'base' })
    await A.engine.syncOnce()                                     // base lands and is trigger-stamped
    await B.engine.syncOnce()                                     // B learns the stamped base
    await A.store.put('todos', { id: 'x', title: 'from-A' })
    await B.store.put('todos', { id: 'x', title: 'from-B' })
    await A.engine.pushOnce()
    await B.engine.pushOnce()                                     // B's write is stamped later by the server clock
    await A.engine.pullOnce()
    await B.engine.pullOnce()
    const a = (await A.store.get('todos', 'x'))!.title
    const b = (await B.store.get('todos', 'x'))!.title
    expect(a).toBe(b)                                             // convergence
    expect(a).toBe('from-B')                                      // explainable: server-stamped LWW wins
    expect((await A.store.get('todos', 'x'))!.updatedAt).toBe((await B.store.get('todos', 'x'))!.updatedAt)
    await A.db.close(); await B.db.close()
  })

  it('A3: delete on A → B refreshes → tombstone, no resurrection (spec §4)', async () => {
    const gw = new FakeGateway()
    const A = await makeDevice('a3a', 'dev-A', gw)
    const B = await makeDevice('a3b', 'dev-B', gw)
    await A.store.put('todos', { id: 'd', title: 'x' })
    await A.engine.syncOnce(); await B.engine.syncOnce()
    await A.store.softDelete('todos', 'd')
    await A.engine.syncOnce(); await B.engine.syncOnce()
    // LocalStore.get() returns the raw row (tombstone included) — `live()` is the UI-facing filter.
    expect((await B.store.get('todos', 'd'))!.deletedAt).not.toBeNull()
    expect(await B.store.live('todos')).toEqual([])                // hidden from the app
    expect(await B.db.business.get('todos')!.count()).toBe(1)      // not physically dropped

    // "刷新" == reopen B and pull again: a tombstone must survive any number of pulls (spec §4).
    const B2 = await makeDevice('a3b', 'dev-B', gw)
    await B2.engine.syncOnce(); await B2.engine.pullOnce()
    expect((await B2.store.get('todos', 'd'))!.deletedAt).not.toBeNull()
    expect(await B2.store.live('todos')).toEqual([])
    expect((await gw.server.get('todos')!.get('d')!.deleted_at as string)).not.toBeNull()
    await B2.db.close()
    await A.db.close(); await B.db.close()
  })
  it('A4: album offline add + view works with no gateway at all (spec §5.5)', async () => {
    const dev = await makeDevice('a4', 'dev-A', null)
    const blob = new Blob(['fake-photo'], { type: 'image/png' })
    await dev.images.addLocal('cap1', blob)
    await dev.store.put('activities', { id: 'act1', title: '运动会', imagePaths: ['albums/cap1'] })
    const back = await dev.images.getBlob('cap1')
    expect(back).toBeInstanceOf(Blob)
    expect(back!.size).toBe(10)
    expect(await dev.images.isUploaded('cap1')).toBe(false)        // offline: queued, viewable from local
    expect(await dev.outbox.count()).toBe(2)                        // upload + row entry waiting for reconnect
    const ready = await dev.outbox.listReady(0, 10)
    expect(ready[0].op).toBe('upload_image')                        // object queued before its reference
    expect(ready[1].op).toBe('upsert')

    // The Repository door keeps that ordering too, without the caller thinking about it.
    const repo = dev.repoOf<{ id: string; name: string; photoPath?: string }>('students')
    const created = await repo.create({ id: 's9', name: '王五' })
    const attached = await repo.attachImage(created.id, 'photoPath', blob)
    expect(attached.objectPath).toBe(`albums/${attached.imageId}`)
    expect((await repo.get(created.id))!.photoPath).toBe(attached.objectPath)
    expect(await repo.list()).toHaveLength(1)
    await dev.db.close()
  })

  it('A5: legacy import — per-table counts and field-level equality incl. exams (spec §6)', async () => {
    const dev = await makeDevice('a5', 'dev-A', null)
    const report = await runMigration({
      db: dev.db, store: dev.store, meta: dev.meta, images: dev.images,
      ownerUid: () => 'u-1', json: sample as unknown as Record<string, unknown>,
    })
    const expected: Record<string, number> = {
      students: sample.students.length, todos: sample.todos.length, schedule: sample.schedule.length,
      duty: sample.duty.length, violations: sample.violations.length, communications: sample.communications.length,
      grades: sample.grades.length, exams: sample.exams.length, homework: sample.homework.length,
      points: sample.points.length, notices: sample.drafts.notices.length, comments: sample.drafts.comments.length,
      activities: sample.activities.length, behaviors: sample.behaviors.length, committee: sample.committee.length,
      seating: 1, settings: 1,                                     // singletons: one row each
    }
    expect(report.perTable).toEqual(expected)                       // every legacy key accounted for
    expect(report.perTable.exams).toBe(2)                           // the table earlier drafts dropped
    expect(report.unmappedFields).toEqual([])                       // nothing silently lost
    expect(report.backupSaved).toBe(true)
    const ex = await dev.store.live('exams')
    expect(ex.map(e => e.name).sort()).toEqual(['月考', '期中考试'])
    await dev.db.close()
  })

  it('A6: a new business table needs only schema + registration — zero sync code (spec §9.6)', async () => {
    const gw = new FakeGateway()
    const dev = await makeDevice('a6', 'dev-A', gw)
    await addTableDef(dev.db, { name: 'test_notes', columns: ['text'] })   // the ENTIRE integration surface
    expect(tableNames()).toContain('test_notes')                            // the registry is what makes pull
    await dev.store.put('test_notes', { id: 'z', text: 'hi' })               // and subscribe see the new table
    await dev.engine.syncOnce()
    expect((await gw.fetchUpdatedSince('test_notes', '1970-01-01T00:00:00.000Z'))[0].text).toBe('hi')
    expect(await dev.outbox.count()).toBe(0)
    await dev.db.close()
  })
})
