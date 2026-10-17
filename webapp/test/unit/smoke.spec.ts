import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'

describe('toolchain', () => {
  it('indexedDB is available and strict TS builds', async () => {
    expect(indexedDB).toBeDefined()
    const req = indexedDB.open('smoke-db', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('t')
    await new Promise((res, rej) => {
      req.onsuccess = () => { req.result.close(); res(null) }
      req.onerror = () => rej(req.error)
    })
    expect(typeof crypto.randomUUID).toBe('function')
    expect(crypto.randomUUID()).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof crypto.subtle?.digest).toBe('function')
  })
})
