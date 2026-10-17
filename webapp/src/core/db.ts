import Dexie, { type Table } from 'dexie'
import type { OutboxEntry, RowBase } from './types'

export interface ImageRecord { id: string; blob: Blob; ownerId: string | null; objectPath: string | null; uploaded: boolean }
export interface MetaRecord { key: string; value: string }

export class WbDb extends Dexie {
  outbox!: Table<OutboxEntry, number>
  syncMeta!: Table<MetaRecord, string>
  images!: Table<ImageRecord, string>
  business = new Map<string, Table<RowBase & Record<string, unknown>, string>>()
  private lv = 1

  constructor(name: string) {
    super(name)
    this.version(1).stores({ outbox: 'seq, table', syncMeta: 'key', images: 'id, ownerId' })
  }

  /**
   * Called by the schema registry (Task 6) for each TableDef. Idempotent per table name.
   *
   * Dexie forbids `version()` once the connection is open (SchemaError: Cannot add version when
   * database is open), so registering a table closes and re-opens the connection at the new
   * version. Table instances (including ones captured earlier, e.g. `db.outbox`) stay valid across
   * that reconnect — verified against fake-indexeddb. Hence this is async; `registerAllTables`
   * and `addTableDef` await it.
   */
  async registerTable(name: string): Promise<void> {
    if (this.business.has(name)) return
    this.lv += 1
    this.close()
    this.version(this.lv).stores({ [name]: 'id, seq, ownerId' })
    this.business.set(name, this.table(name))
    await this.open()
  }
}

export async function openDb(name = 'wb-app'): Promise<WbDb> {
  const db = new WbDb(name)
  await db.open()
  return db
}
