import type { WbDb } from './db'
import type { MetaStore } from './meta'
import type { LocalStore } from './localStore'
import { dataUrlToBlob, objectPathFor, type ImageStore } from './images'
import { TABLE_DEFS, JSON_FK_MAPS, type TableDef } from './schema'

/**
 * Legacy `wb_tw_data` JSON -> LocalStore (spec §6). Registry-driven: it iterates TABLE_DEFS, so a
 * table can only be missed by forgetting its TableDef, never by forgetting a line here (that is the
 * class of bug that dropped `exams` before). Deterministic ids make a re-run an upsert, not a copy.
 */

export interface MigrationReport {
  backupSaved: boolean
  perTable: Record<string, number>
  unmappedFields: string[]
  skipped: { table: string; reason: string }[]
  alreadyDone?: boolean
}

export interface MigrationDeps {
  db: WbDb
  store: LocalStore
  meta: MetaStore
  images: ImageStore
  ownerUid: () => string | null
  json: Record<string, unknown>
  force?: boolean
}

const BACKUP_NAME = 'legacy-wb_tw_data'

/** SHA-1 over a namespaced string, rendered as an RFC-4122-shaped uuid (version 5 / variant bits). */
export async function deriveUuid(legacyKey: string, legacyId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`ella-legacy:${legacyKey}:${legacyId}`))
  const h = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    '5' + h.slice(13, 16),
    (parseInt(h.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0') + h.slice(18, 20),
    h.slice(20, 32),
  ].join('-')
}

export async function migrationDone(db: WbDb): Promise<boolean> { return !!(await db.syncMeta.get('migrated')) }
export async function markMigrationDone(db: WbDb): Promise<void> { await db.syncMeta.put({ key: 'migrated', value: '1' }) }

export async function runMigration(deps: MigrationDeps): Promise<MigrationReport> {
  const { db, store, meta, images, json } = deps
  if ((await migrationDone(db)) && !deps.force) {
    return { backupSaved: false, perTable: {}, unmappedFields: [], skipped: [], alreadyDone: true }
  }
  // Backup BEFORE any write: the raw JSON is the only place dropped fields (idCard) still exist.
  await meta.setBackup(BACKUP_NAME, JSON.stringify(json))
  const report: MigrationReport = { backupSaved: true, perTable: {}, unmappedFields: [], skipped: [] }

  for (const def of TABLE_DEFS) {
    if (!def.legacyKey) continue
    const src = json[def.legacyKey] as Record<string, unknown> | undefined
    const items = def.legacySubKey
      ? ((src?.[def.legacySubKey] as unknown[]) ?? [])
      : (src as unknown[] | Record<string, unknown> | undefined)
    if (items === undefined || items === null) {
      report.skipped.push({ table: def.name, reason: 'absent in legacy json' })
      report.perTable[def.name] = 0
      continue
    }
    report.perTable[def.name] = 0
    if (def.singleton) {                              // whole legacy object == one row
      report.perTable[def.name] = await migrateRow(def, items as Record<string, unknown>, store, images, report)
      continue
    }
    for (const legacy of items as unknown[]) {
      report.perTable[def.name] += await migrateRow(def, legacy as Record<string, unknown>, store, images, report)
    }
  }
  await markMigrationDone(db)
  return report
}

/** Students carry legacy single-guardian aliases; fold them in before dropping (mirrors index.html:90). */
function foldLegacyGuardians(legacy: Record<string, unknown>): void {
  if (legacy.parentName && !legacy.guardian1Name) legacy.guardian1Name = legacy.parentName
  if (legacy.parentPhone && !legacy.guardian1Phone) legacy.guardian1Phone = legacy.parentPhone
  delete legacy.parentName
  delete legacy.parentPhone
}

async function migrateRow(
  def: TableDef,
  legacyRaw: Record<string, unknown>,
  store: LocalStore,
  images: ImageStore,
  report: MigrationReport,
): Promise<number> {
  const legacy = { ...legacyRaw }                    // never mutate the caller's parsed JSON
  if (def.name === 'students') foldLegacyGuardians(legacy)

  // A singleton's id comes from the object, not from a row id inside it.
  const oldId = def.singleton ? 'singleton' : String(legacy.id ?? '')
  const id = await deriveUuid(def.name, oldId || def.name)

  const drop = new Set([...(def.dropColumns ?? []), ...(def.imageColumns ?? []), ...(def.photoColumn ? [def.photoColumn] : [])])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(legacy)) {
    if (k === 'id' || drop.has(k)) continue
    out[k] = await remapValue(def, k, v)
    if (!def.columns.includes(k)) report.unmappedFields.push(`${def.name}.${k}`)  // report, never silently drop
  }

  if (def.photoColumn && typeof legacy[def.photoColumn] === 'string' && (legacy[def.photoColumn] as string).startsWith('data:')) {
    const imageId = `${id}-photo`
    await images.addLocal(imageId, dataUrlToBlob(legacy[def.photoColumn] as string))
    out.photoPath = objectPathFor(imageId)
  }
  for (const col of def.imageColumns ?? []) {
    const arr = (legacy[col] as unknown[]) ?? []
    const paths: string[] = []
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i]
      if (typeof item !== 'string' || !item.startsWith('data:')) continue
      const imageId = `${id}-${col}-${i}`
      await images.addLocal(imageId, dataUrlToBlob(item))
      paths.push(objectPathFor(imageId))
    }
    out.imagePaths = paths
  }

  await remapNestedStudents(def, out)
  await store.put(def.name, { ...out, id } as Record<string, unknown> & { id: string })
  return 1
}

/** FK remap for plain columns and for the keys of jsonb maps (grades.scores, homework.records). */
async function remapValue(def: TableDef, key: string, value: unknown): Promise<unknown> {
  if (def.fkColumns?.includes(key) && typeof value === 'string' && value) return deriveUuid('students', value)
  const jsonFk = JSON_FK_MAPS.find(m => m.table === def.name && m.column === key)
  if (jsonFk && value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[await deriveUuid('students', k)] = v
    return out
  }
  return value
}

/**
 * Legacy arrays nested inside jsonb columns that still point at students by their old ids.
 * Rebuilds the array: the parsed legacy JSON is the caller's object (and in tests a shared module),
 * so remapping must never write through the alias.
 */
async function remapNestedStudents(def: TableDef, out: Record<string, unknown>): Promise<void> {
  const nested: { column: string; field: string }[] =
    def.name === 'seating' ? [{ column: 'seats', field: 'studentId' }]
      : def.name === 'duty' ? [{ column: 'tasks', field: 'assigneeId' }]
        : []
  for (const { column, field } of nested) {
    const arr = out[column]
    if (!Array.isArray(arr)) continue
    const remapped: Record<string, unknown>[] = []
    for (const entry of arr as Record<string, unknown>[]) {
      const oldId = entry[field]
      const copy = { ...entry }
      if (typeof oldId === 'string' && oldId) copy[field] = await deriveUuid('students', oldId)
      remapped.push(copy)
    }
    out[column] = remapped
  }
}
