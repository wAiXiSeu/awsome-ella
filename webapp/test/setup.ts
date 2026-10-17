import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach } from 'vitest'

afterEach(() => {
  globalThis.indexedDB = new IDBFactory()
})
