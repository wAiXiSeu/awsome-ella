import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { ImageStore, objectPathFor } from '../../src/core/images'
import { registerAllTables, TABLE_DEFS } from '../../src/core/schema'
import { runMigration, deriveUuid, migrationDone, markMigrationDone, type MigrationDeps } from '../../src/core/migration'
import type { Row } from '../../src/core/types'
import sample from '../fixtures/wb_tw_data.sample.json'

let db: WbDb
let store: LocalStore
let images: ImageStore
let deps: MigrationDeps

beforeEach(async () => {
  db = await openDb('mig-' + Math.random())
  await registerAllTables(db)
  const meta = new MetaStore(db)
  store = new LocalStore({
    db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  images = new ImageStore(db, meta, 'dA', () => 'u-1')
  deps = { db, store, meta, images, ownerUid: () => 'u-1', json: sample as Record<string, unknown> }
})

describe('deriveUuid', () => {
  it('deterministic uuid shape', async () => {
    const a = await deriveUuid('students', 'm3abc01')
    expect(a).toBe(await deriveUuid('students', 'm3abc01'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(await deriveUuid('todos', 'm3abc01'))
  })
})

describe('runMigration (spec §6)', () => {
  it('imports every legacy table with exact row counts - exams included (criterion 5)', async () => {
    const report = await runMigration(deps)
    expect(report.backupSaved).toBe(true)
    expect(report.unmappedFields).toEqual([])
    expect(report.perTable.exams).toBe(2)
    expect(report.perTable.students).toBe(2)
    expect(report.perTable.todos).toBe(1)
    expect(report.perTable.notices).toBe(1)
    expect(report.perTable.comments).toBe(0)
    expect(report.perTable.settings).toBe(1)
    for (const d of TABLE_DEFS.filter(t => t.legacyKey)) {
      expect(d.name in report.perTable, 'missing perTable for ' + d.name).toBe(true)
    }
  })

  it('field by field: keeps mapped fields, drops idCard, folds parentPhone, photo becomes a blob path', async () => {
    await runMigration(deps)
    const students = await store.live('students')
    const zs = students.find(s => s.name === '张三')!
    expect(zs.studentNo).toBe('01')
    expect(zs.guardian1Phone).toBe('13800000001')
    expect((zs as Record<string, unknown>).idCard).toBeUndefined()
    expect(zs.photoPath).toMatch(/^albums\//)
    const ls = students.find(s => s.name === '李四')!
    expect(ls.guardian1Phone).toBe('13900000002')          // legacy parentName/parentPhone fold (index.html:90)
    expect(ls.guardian1Name).toBe('李父')
    expect((ls as Record<string, unknown>).parentPhone).toBeUndefined()
    const imageId = (zs.photoPath as string).slice(objectPathFor('').length)
    const rec = await db.images.get(imageId)               // bytes live in the blob store, not the row
    expect(rec!.blob.size).toBeGreaterThan(50)
    expect(await images.isUploaded(imageId)).toBe(false)   // queued, not yet uploaded (offline)
    const s = JSON.stringify(students)
    expect(s).not.toContain('iVBOR')
    expect(s).not.toContain('11010120100101001X')          // idCard never enters the DB (spec §2.1)
  })

  it('FK remap: studentId, jsonb score keys and nested seats/tasks follow the derived uuid', async () => {
    await runMigration(deps)
    const zsNew = await deriveUuid('students', 'm3abc01')
    const pts = await store.live('points')
    expect(pts[0].studentId).toBe(zsNew)
    const gr = await store.live('grades')
    expect(Object.keys(gr[0].scores as object)).toContain(zsNew)
    const hw = await store.live('homework')
    expect(Object.keys(hw[0].records as object)).toContain(zsNew)
    const seat = (await store.live('seating'))[0]
    expect((seat.seats as { studentId: string }[])[0].studentId).toBe(zsNew)
    const duty = (await store.live('duty'))[0]
    expect((duty.tasks as { assigneeId: string }[])[0].assigneeId).toBe(zsNew)
    // the legacy JSON the caller handed over is never written through (regression: nested remap)
    const rawSeats = (sample as unknown as { seating: { seats: { studentId: string }[] } }).seating.seats
    expect(rawSeats[0].studentId).toBe('m3abc01')
  })

  it('singleton defs produce one deterministic row per legacy object', async () => {
    await runMigration(deps)
    const settings = await store.live('settings')
    expect(settings.length).toBe(1)
    expect(settings[0].id).toBe(await deriveUuid('settings', 'singleton'))
    expect((settings[0] as Record<string, unknown>).weekType).toBe('single')
  })

  it('idempotent: forced re-run keeps identical rows (spec §6)', async () => {
    await runMigration(deps)
    const before = await store.live('exams')
    const report2 = await runMigration({ ...deps, force: true })
    expect(report2.backupSaved).toBe(true)
    expect(await migrationDone(db)).toBe(true)
    const after = await store.live('exams')
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
    expect(await store.live('students')).toHaveLength(2)
  })

  it('every write lands in the outbox; the raw backup keeps dropped fields', async () => {
    const report = await runMigration(deps)
    const total = Object.values(report.perTable).reduce((a, b) => a + b, 0)
    expect(await db.outbox.count()).toBeGreaterThanOrEqual(total)
    const backup = await deps.meta.getBackup('legacy-wb_tw_data')
    expect(backup).toContain('期中考试')
    expect(backup).toContain('11010120100101001X')
  })

  it('refuses to re-run once migrationDone unless force', async () => {
    await runMigration(deps)
    await markMigrationDone(db)
    await expect(runMigration(deps)).resolves.toMatchObject({ alreadyDone: true })
  })
})
