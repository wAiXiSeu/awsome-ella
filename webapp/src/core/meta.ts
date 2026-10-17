import type { WbDb } from './db'

export const EPOCH = '1970-01-01T00:00:00.000Z'

export class MetaStore {
  constructor(private db: WbDb) {}

  private async kv(key: string): Promise<string | undefined> { return (await this.db.syncMeta.get(key))?.value }
  private async setKv(key: string, value: string) { await this.db.syncMeta.put({ key, value }) }

  async getDeviceId(): Promise<string> {
    const cur = await this.kv('deviceId')
    if (cur) return cur
    const id = crypto.randomUUID()
    await this.setKv('deviceId', id)
    return id
  }

  /** Monotonic write counter. Safe inside an outer Dexie transaction (runs as a sub-transaction). */
  async nextSeq(): Promise<number> {
    return this.db.transaction('rw', this.db.syncMeta, async () => {
      const cur = Number((await this.kv('seq')) ?? '0')
      const n = cur + 1
      await this.setKv('seq', String(n))
      return n
    })
  }

  async getWatermark(): Promise<string> { return (await this.kv('watermark')) ?? EPOCH }
  async setWatermark(iso: string): Promise<void> { await this.setKv('watermark', iso) }
  async getBackup(name: string): Promise<string | undefined> { return this.kv('backup:' + name) }
  async setBackup(name: string, json: string): Promise<void> { await this.setKv('backup:' + name, json) }
}
