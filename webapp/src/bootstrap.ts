import Dexie from 'dexie'
import type { Table } from 'dexie'
import { openDb, type WbDb } from './core/db'
import { MetaStore } from './core/meta'
import { LocalStore } from './core/localStore'
import { Outbox } from './core/outbox'
import { ImageStore } from './core/images'
import { SyncEngine } from './core/syncEngine'
import { Auth } from './core/auth'
import { registerAllTables } from './core/schema'
import { createSupabaseClient, bucketName } from './core/supabaseClient'
import { SupabaseGateway } from './core/supabaseGateway'
import type { RemoteGateway } from './core/gateway'
import type { Row } from './core/types'

/**
 * Wiring (spec §3): the one place that composes the local-first stack, in dependency order. It must
 * never throw when env/credentials are absent — that IS local-only mode, the state this repo ships in.
 */

export const APP_DB_NAME = 'wb-app'

export type StorageMode = 'native' | 'in-memory-fallback'

/** Set by the probe below; App.vue reads it to decide whether to warn that storage is session-only. */
export let lastStorageMode: StorageMode | null = null

const PROBE_DB = 'wb-storage-probe'
const PROBE_TIMEOUT_MS = 3000

// --- storage probe (spec §7 row 4) -----------------------------------------------------------------
function openProbe(idb: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = idb.open(PROBE_DB, 1)                     // Safari private mode throws synchronously here
    } catch (e) { reject(e); return }
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('probe')) d.createObjectStore('probe')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'))
    req.onblocked = () => reject(new Error('indexedDB.open blocked'))
  })
}

/** Firefox private mode lets open() succeed but aborts every transaction, so the probe writes. */
function writeProbe(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction
    try {
      tx = db.transaction('probe', 'readwrite')
    } catch (e) { reject(e); return }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('probe transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('probe transaction aborted'))
    tx.objectStore('probe').put('ok', 'k')
  })
}

async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(msg)), ms) })])
  } finally { clearTimeout(timer) }
}

/** The factory we installed on a previous fallback, so a re-probe cannot mistake it for durable. */
let inMemory: { idb: IDBFactory; keyRange: typeof IDBKeyRange } | null = null

export async function openNativeIdbOrFallback(): Promise<StorageMode> {
  const idb = globalThis.indexedDB
  if (inMemory && idb === inMemory.idb) {              // already degraded: re-probing the polyfill proves nothing
    return useBackend('in-memory-fallback', inMemory.idb, inMemory.keyRange)
  }
  let durable = false
  if (idb) {
    let db: IDBDatabase | null = null
    try {
      db = await withTimeout(openProbe(idb), PROBE_TIMEOUT_MS, 'indexedDB probe timed out')
      await withTimeout(writeProbe(db), PROBE_TIMEOUT_MS, 'indexedDB probe write timed out')
      durable = true
    } catch { durable = false }
    finally {
      db?.close()
      try {                                            // leave no probe database behind in a real browser
        const del = idb.deleteDatabase(PROBE_DB)
        del.onerror = () => {}
        del.onblocked = () => {}
      } catch { /* nothing to clean up */ }
    }
  }
  if (durable) return useBackend('native', globalThis.indexedDB, globalThis.IDBKeyRange)
  // A FRESH factory, not fake-indexeddb/auto's shared singleton: the fallback has to be an isolated,
  // session-only store, and `auto` is a no-op once its module was already evaluated (vitest setup).
  const Fake = await import('fake-indexeddb')
  inMemory = { idb: new Fake.IDBFactory(), keyRange: Fake.IDBKeyRange }
  return useBackend('in-memory-fallback', inMemory.idb, inMemory.keyRange)
}

/**
 * Dexie snapshots its backend when a database object is constructed (domDeps is captured at import
 * time), so installing the in-memory factory on `globalThis` alone would NOT be picked up — openDb()
 * would keep using the unusable native one. Both paths hand Dexie the factory we just validated.
 */
function useBackend(mode: StorageMode, idb: IDBFactory, keyRange: typeof IDBKeyRange): StorageMode {
  if (globalThis.indexedDB !== idb) {
    // Browsers expose `window.indexedDB` as a getter-only WebIDL attribute, so `globalThis.indexedDB = x`
    // throws TypeError there (node/fake-indexeddb has a plain writable prop — hence unit tests passing
    // while the browser did not). defineProperty is how fake-indexeddb/auto installs it.
    try {
      Object.defineProperty(globalThis, 'indexedDB', { value: idb, configurable: true, writable: true })
    } catch { /* non-configurable host: Dexie.dependencies below is what our own storage actually uses */ }
  }
  Dexie.dependencies.indexedDB = idb
  Dexie.dependencies.IDBKeyRange = keyRange
  lastStorageMode = mode
  return mode
}

// --- context ---------------------------------------------------------------------------------------
export interface AppContext {
  db: WbDb
  store: LocalStore
  outbox: Outbox
  meta: MetaStore
  images: ImageStore
  engine: SyncEngine
  auth: Auth
  gateway: RemoteGateway | null
  mode: 'online' | 'local-only'
}

export async function bootstrap(): Promise<AppContext> {
  await openNativeIdbOrFallback()
  const db = await openDb(APP_DB_NAME)
  await registerAllTables(db)                          // registry-driven: no table list lives here
  const meta = new MetaStore(db)
  const deviceId = await meta.getDeviceId()

  // Auth is resolved further down, so the uid reaches LocalStore/ImageStore through a thunk.
  let auth: Auth | null = null
  const ownerUid = () => auth?.currentUid() ?? null

  const store = new LocalStore({ db, meta, deviceId, ownerUid, table: n => db.business.get(n) as Table<Row, string> })
  const outbox = new Outbox(db)
  const images = new ImageStore(db, meta, deviceId, ownerUid)

  const client = createSupabaseClient()                // null = no credentials = local-only mode
  auth = client ? await Auth.remote(client) : Auth.local('local-user')
  const gateway = client ? new SupabaseGateway(client, bucketName()) : null

  const engine = new SyncEngine({
    store, outbox, meta, gateway, ownerUid,
    now: () => Date.now(),
    setTimeoutFn: (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    images,                                            // getBlob + markUploaded (spec §5.5)
  })
  engine.start()                                       // local-only: push/pull no-op, no network touched

  return { db, store, outbox, meta, images, engine, auth, gateway, mode: client ? 'online' : 'local-only' }
}