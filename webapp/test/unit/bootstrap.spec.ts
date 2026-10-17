import { describe, it, expect } from 'vitest'
import { bootstrap, openNativeIdbOrFallback, lastStorageMode } from '../../src/bootstrap'

describe('bootstrap without credentials (constraint: app must run local-only)', () => {
  it('completes with mode=local-only and engine alive', async () => {
    const ctx = await bootstrap()
    expect(ctx.mode).toBe('local-only')
    expect(ctx.gateway).toBeNull()
    expect(await ctx.store.pendingCount()).toBeGreaterThanOrEqual(0)
    const r = await ctx.store.put('students', { id: crypto.randomUUID(), name: 'probe' })
    expect(r.seq).toBeGreaterThan(0)
    expect(await ctx.engine.pushOnce()).toBe(0)            // queued, no network attempted
  })
})

describe('openNativeIdbOrFallback (spec §7 row 4: private browsing / no persistent storage)', () => {
  it('reports native when indexedDB answers a read-write probe', async () => {
    expect(await openNativeIdbOrFallback()).toBe('native')
    expect(lastStorageMode).toBe('native')                 // live binding read directly by App.vue
  })

  it('degrades to a fresh in-memory factory when indexedDB is absent', async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
    expect(await openNativeIdbOrFallback()).toBe('in-memory-fallback')
    expect(lastStorageMode).toBe('in-memory-fallback')
    const ctx = await bootstrap()                          // the whole app still boots, session-only
    expect(lastStorageMode).toBe('in-memory-fallback')      // a re-probe must not call the polyfill durable
    await ctx.store.put('todos', { id: 't1', title: 'x' })
    expect((await ctx.store.get('todos', 't1'))?.title).toBe('x')
    // Dexie has to write into the factory we installed, not the native one it captured at import time.
    const raw = await new Promise<{ title?: string } | undefined>(res => {
      const req = globalThis.indexedDB.open('wb-app')
      req.onsuccess = () => {
        const d = req.result
        const tx = d.transaction('todos', 'readonly')
        const getReq = tx.objectStore('todos').get('t1')
        getReq.onsuccess = () => { d.close(); res(getReq.result as { title?: string }) }
        tx.onerror = () => { d.close(); res(undefined) }
      }
      req.onerror = () => res(undefined)
    })
    expect(raw?.title).toBe('x')
  })

  it('degrades when indexedDB exists but throws on open (Safari private mode)', async () => {
    globalThis.indexedDB = { open: () => { throw new Error('SecurityError') } } as unknown as IDBFactory
    expect(await openNativeIdbOrFallback()).toBe('in-memory-fallback')
  })
})
