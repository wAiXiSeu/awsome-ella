import type { RemoteGateway } from '../src/core/gateway'
import type { RemoteRow } from '../src/core/types'

/**
 * Faithful in-memory stand-in for the remote: it stamps `updated_at` on write (like the SQL
 * trigger), keeps one monotonic clock shared by all "devices" in a test, and emits realtime
 * events to subscribers.
 */
export class FakeGateway implements RemoteGateway {
  server = new Map<string, Map<string, RemoteRow>>()
  upsertCalls: { table: string; rows: RemoteRow[] }[] = []
  uploadCalls: { path: string; blob: Blob }[] = []
  failNextUpsert: Error | null = null
  clock = 0                                   // ms; each write stamps updated_at = ISO of clock
  private subs: ((table: string, row: RemoteRow) => void)[] = []

  private t(table: string) {
    if (!this.server.has(table)) this.server.set(table, new Map())
    return this.server.get(table)!
  }

  async upsertRows(table: string, rows: RemoteRow[]): Promise<void> {
    if (this.failNextUpsert) { const e = this.failNextUpsert; this.failNextUpsert = null; throw e }
    this.clock += 1000
    this.upsertCalls.push({ table, rows })
    for (const r of rows) {
      const stamped = { ...r, updated_at: new Date(this.clock).toISOString() }
      this.t(table).set(String(r.id), stamped)
      this.subs.forEach(cb => cb(table, stamped))
    }
  }

  async fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]> {
    return [...this.t(table).values()].filter(r => (r.updated_at as string) > watermark)
  }

  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void {
    const cb = (t: string, r: RemoteRow) => { if (t === table) onRow(r) }
    this.subs.push(cb)
    return () => { this.subs = this.subs.filter(x => x !== cb) }
  }

  async uploadObject(path: string, blob: Blob): Promise<void> {
    if (this.failNextUpsert) { const e = this.failNextUpsert; this.failNextUpsert = null; throw e }
    this.uploadCalls.push({ path, blob })
  }
}
