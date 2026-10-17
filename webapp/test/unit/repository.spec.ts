import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { ImageStore } from '../../src/core/images'
import { Repository } from '../../src/core/repository'
import type { Row } from '../../src/core/types'

let db: WbDb
let repo: Repository<{ name: string; group?: number }>

beforeEach(async () => {
  db = await openDb('repo-' + Math.random())
  await db.registerTable('students')
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  const images = new ImageStore(db, meta, 'dA', () => 'u-1')
  repo = new Repository('students', store, images)
})

describe('Repository (spec §3 business door)', () => {
  it('create → uuid id, row in store, outbox entry queued', async () => {
    const r = await repo.create({ name: '小明', group: 3 })
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await repo.get(r.id)).toMatchObject({ name: '小明' })
    expect(await db.outbox.count()).toBe(1)
  })

  it('update merges patch, remove soft-deletes and disappears from list', async () => {
    const r = await repo.create({ name: 'a', group: 2 })
    await repo.update(r.id, { name: 'b' })
    expect((await repo.get(r.id))!.name).toBe('b')
    expect((await repo.get(r.id))!.group).toBe(2)              // patch merged, not replaced
    await repo.remove(r.id)
    expect(await repo.list()).toEqual([])
    expect((await repo.get(r.id))!.deletedAt).not.toBeNull()   // tombstone kept (spec §4)
    const ops = (await db.outbox.toArray()).map(e => e.op)
    expect(ops).toEqual(['upsert', 'upsert', 'delete'])
  })

  it('attachImage: blob stored, row holds objectPath only', async () => {
    const r = await repo.create({ name: 'a' })
    const blob = new Blob(['x'], { type: 'image/png' })
    const { objectPath } = await repo.attachImage(r.id, 'photoPath', blob)
    expect(objectPath).toMatch(/^albums\//)
    expect((await repo.get(r.id))!.photoPath).toBe(objectPath)
    const row = (await repo.get(r.id))!
    // bytes never reach the business row: no data-url-sized strings (spec §5.5)
    expect(Object.values(row).filter(v => typeof v === 'string' && v.length > 64)).toEqual([])
    const blobs = await db.images.toArray()
    expect(blobs[0].blob.size).toBe(1)
    // the queued upload took a seq before the row write that points at it
    const entries = await db.outbox.orderBy('seq').toArray()
    const upload = entries.find(e => e.op === 'upload_image')!
    const referencing = entries.find(e => e.op === 'upsert' && JSON.stringify(e.payload).includes(objectPath))!
    expect(referencing.seq).toBeGreaterThan(upload.seq)
  })
})
