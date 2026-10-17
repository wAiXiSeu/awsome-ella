import type { Table } from 'dexie'
import type { MetaStore } from './meta'
import { incomingWins } from './conflict'
import { fromRemoteRow } from './case'
import type { RemoteRow, Row } from './types'
import type { WbDb } from './db'

export interface LocalStoreDeps {
  db: WbDb
  meta: MetaStore
  deviceId: string
  ownerUid: () => string | null
  /** Injected by the schema registry (Task 6): LocalStore must not know table names (§9.6). */
  table(name: string): Table<Row, string>
}

export class LocalStore {
  constructor(private d: LocalStoreDeps) {}

  private t(name: string): Table<Row, string> {
    const t = this.d.table(name)
    if (!t) throw new Error(`unregistered table: ${name}`)
    return t
  }

  /** Queue payload = the write intent without the server-owned `updated_at` (spec §5.2). */
  private payloadOf(row: Row): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...row }
    delete payload.updatedAt
    return payload
  }

  async put(table: string, fields: Record<string, unknown> & { id: string }): Promise<Row> {
    const t = this.t(table)
    return this.d.db.transaction('rw', t, this.d.db.outbox, this.d.db.syncMeta, async () => {
      const seq = await this.d.meta.nextSeq()
      const old = await t.get(fields.id)
      const row = {
        ...(old ?? {}), ...fields, id: fields.id,
        ownerId: this.d.ownerUid(), seq, deviceId: this.d.deviceId,
        updatedAt: old?.updatedAt ?? null, deletedAt: null,
      } as unknown as Row
      await t.put(row)
      await this.d.db.outbox.put({
        seq, table, recordId: fields.id, op: 'upsert', payload: this.payloadOf(row),
        attempts: 0, nextAttemptAt: 0, blocked: false,
      })
      return row
    })
  }

  async softDelete(table: string, id: string): Promise<void> {
    const t = this.t(table)
    await this.d.db.transaction('rw', t, this.d.db.outbox, this.d.db.syncMeta, async () => {
      const old = await t.get(id)
      if (!old) return
      const seq = await this.d.meta.nextSeq()
      const row = {
        ...old, deletedAt: new Date().toISOString(), seq,
        ownerId: this.d.ownerUid(), deviceId: this.d.deviceId,
      } as unknown as Row
      await t.put(row)
      // full row snapshot: the tombstone must survive even if the row was never pushed
      await this.d.db.outbox.put({
        seq, table, recordId: id, op: 'delete', payload: this.payloadOf(row),
        attempts: 0, nextAttemptAt: 0, blocked: false,
      })
    })
  }

  async get(table: string, id: string): Promise<Row | undefined> { return this.t(table).get(id) }
  async live(table: string): Promise<Row[]> { return (await this.t(table).toArray()).filter(r => r.deletedAt === null) }
  async pendingCount(): Promise<number> { return this.d.db.outbox.count() }

  async applyRemote(table: string, incomingRaw: RemoteRow): Promise<void> {
    await this.applyRemoteRow(table, fromRemoteRow(incomingRaw) as unknown as Row)
  }

  async applyRemoteBulk(table: string, rows: RemoteRow[]): Promise<void> {
    for (const r of rows) await this.applyRemote(table, r)
  }

  private async applyRemoteRow(table: string, incoming: Row): Promise<void> {
    const t = this.t(table)
    await this.d.db.transaction('rw', t, async () => {
      const local = await t.get(incoming.id)
      // server data is not a local edit: bypass the outbox, never touch local seq/deviceId
      if (incomingWins(local ?? null, incoming)) await t.put(incoming)
    })
  }
}
