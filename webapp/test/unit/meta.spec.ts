import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'

describe('MetaStore', () => {
  it('deviceId is stable uuid', async () => {
    const db = await openDb('m1'); const meta = new MetaStore(db)
    const a = await meta.getDeviceId(); const b = await meta.getDeviceId()
    expect(a).toMatch(/^[0-9a-f-]{36}$/); expect(b).toBe(a)
  })
  it('seq is strictly monotonic across opens', async () => {
    const db = await openDb('m2'); const meta = new MetaStore(db)
    const s = [await meta.nextSeq(), await meta.nextSeq()]
    expect(s[1]).toBeGreaterThan(s[0])
    const db2 = await openDb('m2'); const meta2 = new MetaStore(db2)
    expect(await meta2.nextSeq()).toBeGreaterThan(s[1])
  })
  it('watermark starts at epoch and persists', async () => {
    const db = await openDb('m3'); const meta = new MetaStore(db)
    expect(await meta.getWatermark()).toBe('1970-01-01T00:00:00.000Z')
    await meta.setWatermark('2026-10-17T01:00:00.000Z')
    expect(await meta.getWatermark()).toBe('2026-10-17T01:00:00.000Z')
  })
})
