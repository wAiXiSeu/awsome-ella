import type { WbDb } from './db'

/**
 * Single source of truth (spec §4, plan Task 6): one TableDef drives the Dexie schema, the sync
 * table list, the migration mapping and the generated SQL DDL. Adding a business table means
 * adding a def + registering it — no other code (acceptance criterion 6).
 */
export interface TableDef {
  name: string                       // local AND remote name (spec §4 同构)
  legacyKey?: string                 // key inside wb_tw_data JSON
  legacySubKey?: string              // e.g. drafts -> notices | comments
  singleton?: boolean                // seating, settings: whole object == one row
  columns: string[]                  // legacy field names kept as payload (audit cols implicit)
  dropColumns?: string[]             // fields never entering the DB (idCard: spec §2.1; base64 fields)
  imageColumns?: string[]            // string[] of dataURLs -> blob store (activities/behaviors images)
  photoColumn?: string               // single dataURL -> blob store (students.photo)
  fkColumns?: string[]               // studentId values remapped to derived uuids
  jsonColumns?: string[]             // fields stored as jsonb
}

export const TABLE_DEFS: TableDef[] = [
  { name: 'students', legacyKey: 'students',
    columns: ['name', 'studentNo', 'gender', 'primarySchool', 'address', 'guardian1Name', 'guardian1Phone', 'guardian2Name', 'guardian2Phone', 'group', 'tags', 'notes', 'photoPath'],
    dropColumns: ['idCard'], photoColumn: 'photo', jsonColumns: ['tags'] },
  { name: 'notices', legacyKey: 'drafts', legacySubKey: 'notices', columns: ['title', 'content', 'date'] },
  { name: 'comments', legacyKey: 'drafts', legacySubKey: 'comments', columns: ['title', 'content', 'date'] },
  { name: 'todos', legacyKey: 'todos', columns: ['title', 'content', 'deadline', 'priority', 'category', 'completed'] },
  { name: 'schedule', legacyKey: 'schedule', columns: ['day', 'period', 'subject', 'class', 'weekType'] },
  { name: 'seating', legacyKey: 'seating', singleton: true, columns: ['rows', 'cols', 'seats'], jsonColumns: ['seats'] },
  { name: 'duty', legacyKey: 'duty', columns: ['week', 'group', 'tasks'], jsonColumns: ['tasks'] },
  { name: 'violations', legacyKey: 'violations', columns: ['studentId', 'date', 'event', 'action'], fkColumns: ['studentId'] },
  { name: 'communications', legacyKey: 'communications', columns: ['studentId', 'date', 'method', 'content', 'followUp'], fkColumns: ['studentId'] },
  { name: 'grades', legacyKey: 'grades', columns: ['examName', 'subject', 'date', 'scores'], jsonColumns: ['scores'] },
  { name: 'exams', legacyKey: 'exams', columns: ['name', 'date', 'subjects', 'students', 'stats'], jsonColumns: ['subjects', 'students', 'stats'] },
  { name: 'homework', legacyKey: 'homework', columns: ['date', 'subject', 'title', 'records'], jsonColumns: ['records'] },
  { name: 'points', legacyKey: 'points', columns: ['studentId', 'points', 'type', 'reason', 'date'], fkColumns: ['studentId'] },
  { name: 'activities', legacyKey: 'activities', columns: ['title', 'date', 'content', 'imagePaths'], imageColumns: ['images'] },
  { name: 'behaviors', legacyKey: 'behaviors', columns: ['studentId', 'date', 'type', 'level', 'title', 'description', 'imagePaths'], imageColumns: ['images'], fkColumns: ['studentId'] },
  { name: 'committee', legacyKey: 'committee', columns: ['studentId', 'position'], fkColumns: ['studentId'] },
  { name: 'settings', legacyKey: 'settings', singleton: true, columns: ['subjects', 'mySubjects', 'tags', 'dutyPositions', 'weekType'], jsonColumns: ['subjects', 'mySubjects', 'tags', 'dutyPositions'] },
]

export function tableDef(name: string): TableDef | undefined { return TABLE_DEFS.find(d => d.name === name) }
export function tableNames(): string[] { return TABLE_DEFS.map(d => d.name) }

export function legacyKeyIndex(): Record<string, TableDef> {
  const out: Record<string, TableDef> = {}
  for (const d of TABLE_DEFS) if (d.legacyKey) out[d.legacyKey + (d.legacySubKey ? '.' + d.legacySubKey : '')] = d
  return out
}

/** Every distinct top-level wb_tw_data key the defs claim — migration iterates defs, never a hand-written list. */
export function coveredLegacyKeys(): Set<string> { return new Set(TABLE_DEFS.map(d => d.legacyKey).filter(Boolean) as string[]) }

export async function registerAllTables(db: WbDb): Promise<void> {
  for (const d of TABLE_DEFS) await db.registerTable(d.name)
}

/** Runtime registration: adding a business table = one TableDef + register. No other code (§9.6). */
export async function addTableDef(db: WbDb, def: TableDef): Promise<void> {
  if (tableDef(def.name)) throw new Error('duplicate table: ' + def.name)
  TABLE_DEFS.push(def)
  await db.registerTable(def.name)
}

/** Legacy json columns whose KEYS are student ids and must be remapped during migration. */
export const JSON_FK_MAPS: { table: string; column: string }[] = [
  { table: 'homework', column: 'records' },
  { table: 'grades', column: 'scores' },
]
