import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { Outbox } from '../../src/core/outbox'
import { SyncEngine } from '../../src/core/syncEngine'
import { PermissionDeniedError, RetryableError } from '../../src/core/gateway'
import { FakeGateway } from '../fakeGateway'
import type { Row } from '../../src/core/types'

async function mk(withGw = true) {
  const db: WbDb = await openDb('sp-' + Math.random())
  await db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string>,
  })
  const outbox = new Outbox(db)
  const gateway = withGw ? new FakeGateway() : null
  let t = 0
  const timers: (() => void)[] = []
  const engine = new SyncEngine({
    store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => t, setTimeoutFn: (fn) => { timers.push(fn); return timers.length }, clearTimeoutFn: () => {},
  })
  return {
    db, store, outbox, gateway, engine,
    runTimers: () => { const fns = timers.splice(0); fns.forEach(f => f()) },
    advance: (ms: number) => { t += ms },
  }
}

describe('SyncEngine.push (spec §5.1/§5.2/§7)', () => {
  it('pushes all entries in seq order as one batch; outbox drains', async () => {
    const { store, outbox, gateway, engine } = await mk()
    for (let i = 0; i < 3; i++) await store.put('notes', { id: 'n' + i, title: 'T' + i })
    expect(await engine.pushOnce()).toBe(3)
    const gw = gateway!
    expect(gw.upsertCalls.length).toBe(1)
    expect(gw.upsertCalls[0].rows.map(r => r.seq)).toEqual([1, 2, 3])   // ascending, no duplicates
    expect(await outbox.count()).toBe(0)
    expect(gw.server.get('notes')!.size).toBe(3)
    expect(gw.upsertCalls[0].rows.every(r => r.updated_at === undefined && r.owner_id === 'u-1')).toBe(true)
  })

  it('network failure keeps entries queued, schedules backoff retry that succeeds', async () => {
    const m = await mk()
    const { store, outbox, gateway, engine } = m
    await store.put('notes', { id: 'n1', title: 'a' })
    gateway!.failNextUpsert = new RetryableError('offline')
    expect(await engine.pushOnce()).toBe(0)
    expect(await outbox.count()).toBe(1)                                  // not dropped (spec §7)
    const before = gateway!.upsertCalls.length
    m.advance(5000)
    m.runTimers()
    await engine.pushOnce()
    expect(gateway!.upsertCalls.length).toBeGreaterThan(before)
    expect(await outbox.count()).toBe(0)
  })

  it('403 blocks the entry and surfaces the error (spec §7)', async () => {
    const m = await mk()
    const { store, outbox, gateway, engine } = m
    await store.put('notes', { id: 'n1', title: 'a' })
    gateway!.failNextUpsert = new PermissionDeniedError('RLS rejected')
    let lastError: string | null = null
    engine.onState = s => { lastError = s.lastError }
    await engine.pushOnce()
    expect(await outbox.count()).toBe(1)                    // kept, not silently dropped
    expect(await outbox.listReady(1e15, 10)).toEqual([])    // blocked: never retried
    expect(lastError).toContain('RLS rejected')
  })

  it('local-only mode: no gateway, push is a no-op, data stays queued', async () => {
    const { store, outbox, engine } = await mk(false)
    await store.put('notes', { id: 'n1' })
    expect(await engine.pushOnce()).toBe(0)
    expect(await outbox.count()).toBe(1)
  })
})
