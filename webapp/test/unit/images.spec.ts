import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { Outbox } from '../../src/core/outbox'
import { ImageStore, dataUrlToBlob, objectPathFor, quotaNag } from '../../src/core/images'
import { SyncEngine } from '../../src/core/syncEngine'
import { LocalStore } from '../../src/core/localStore'
import { FakeGateway } from '../fakeGateway'
import type { Row } from '../../src/core/types'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function mk(withGw: boolean) {
  const db = await openDb('img-' + Math.random())
  await db.registerTable('notes')
  const meta = new MetaStore(db)
  const outbox = new Outbox(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  const images = new ImageStore(db, meta, 'dA', () => 'u-1')
  const gateway = withGw ? new FakeGateway() : null
  const engine = new SyncEngine({
    store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
    images: {
      getBlob: id => db.images.get(id).then(r => r?.blob),
      markUploaded: async id => { await db.images.update(id, { uploaded: true }) },
    },
  })
  return { db, meta, outbox, store, images, gateway, engine }
}

describe('image pipeline (spec §5.5)', () => {
  it('dataUrlToBlob decodes without canvas', async () => {
    const b = dataUrlToBlob(PNG_1PX)
    expect(b.size).toBeGreaterThan(50)
    expect(b.type).toBe('image/png')
  })

  it('offline: add succeeds, blob readable, upload queued', async () => {
    const { images, outbox } = await mk(false)
    await images.addLocal('img-1', dataUrlToBlob(PNG_1PX))
    const back = await images.getBlob('img-1')
    expect(back!.size).toBeGreaterThan(50)
    expect(await images.isUploaded('img-1')).toBe(false)
    const ready = await outbox.listReady(0, 10)
    expect(ready[0].op).toBe('upload_image')
    expect((ready[0].payload as Record<string, unknown>).objectPath).toBe(objectPathFor('img-1'))
  })

  it('online: push uploads object, marks uploaded, drains queue; bytes never in upsert payloads', async () => {
    const m = await mk(true)
    const { images, outbox, store, gateway, engine } = m
    await images.addLocal('img-1', dataUrlToBlob(PNG_1PX))
    await store.put('notes', { id: 'n1', imageIds: ['img-1'] })   // referencing row takes a later seq
    expect(await engine.pushOnce()).toBe(2)
    expect(gateway!.uploadCalls[0].path).toBe(objectPathFor('img-1'))
    expect(await images.isUploaded('img-1')).toBe(true)
    expect(await outbox.count()).toBe(0)
    const rowUpsert = gateway!.upsertCalls[0].rows[0]
    expect(JSON.stringify(rowUpsert)).not.toContain('iVBOR')       // no base64 in the row (spec §5.5)
    expect(gateway!.uploadCalls.length).toBe(1)                    // the upload landed, once
    expect(gateway!.uploadCalls[0].blob.size).toBeGreaterThan(50)
  })

  it('upload failure keeps the entry queued (no silent loss)', async () => {
    const m = await mk(true)
    const { images, outbox, engine } = m
    await images.addLocal('img-2', dataUrlToBlob(PNG_1PX))
    m.gateway!.failNextUpsert = new Error('storage down')
    await engine.pushOnce()
    expect(await outbox.count()).toBe(1)
    expect(await images.isUploaded('img-2')).toBe(false)
  })

  it('quotaNag is inert without the storage API and never throws', async () => {
    expect(await quotaNag()).toBeNull()                    // node/vitest: no navigator.storage
  })
})
