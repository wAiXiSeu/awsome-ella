import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type WbDb } from '../../src/core/db'
import { Outbox, backoffDelay } from '../../src/core/outbox'
import type { OutboxEntry } from '../../src/core/types'

const entry = (seq: number, over: Partial<OutboxEntry> = {}): OutboxEntry =>
  ({ seq, table: 'notes', recordId: 'r' + seq, op: 'upsert', payload: {}, attempts: 0, nextAttemptAt: 0, blocked: false, ...over })

describe('Outbox', () => {
  let db: WbDb, ob: Outbox
  beforeEach(async () => { db = await openDb('ob-' + Math.random()); ob = new Outbox(db) })

  it('listReady returns ascending seq, respects limit', async () => {
    await db.outbox.bulkPut([entry(3), entry(1), entry(2)])
    expect((await ob.listReady(0, 2)).map(e => e.seq)).toEqual([1, 2])
    expect((await ob.listReady(0, 50)).map(e => e.seq)).toEqual([1, 2, 3])
  })
  it('backoff: failed entries hidden until nextAttemptAt, attempts counted', async () => {
    await db.outbox.add(entry(1))
    await ob.markFailed(1, 'network', 5000, 0)
    expect(await ob.listReady(1000, 10)).toEqual([])
    expect(await ob.listReady(6000, 10)).toMatchObject([{ attempts: 1, nextAttemptAt: 5000 }])
  })
  it('blocked entries never returned but still counted', async () => {
    await db.outbox.add(entry(1))
    await ob.markBlocked(1, '403')
    expect(await ob.listReady(99999, 10)).toEqual([])
    expect(await ob.count()).toBe(1)
    expect(await ob.earliestNextAttempt(0)).toBeNull()
  })
  it('markDone removes; tables() lists pending tables', async () => {
    await db.outbox.bulkPut([entry(1), entry(2, { table: 'todos' })])
    await ob.markDone(1)
    expect(await ob.count()).toBe(1)
    expect(await ob.tables()).toEqual(['todos'])
  })
  it('backoffDelay is exponential and capped', () => {
    expect(backoffDelay(0)).toBe(2000)
    expect(backoffDelay(1)).toBe(4000)
    expect(backoffDelay(10)).toBe(300000)
  })
})
