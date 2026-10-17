# Infra & Sync Engine (子项目 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Steps marked **🚫CRED** are blocked on Supabase credentials (URL / anon key / live instance) that do not exist yet: skip them, leave the box unchecked, and note the skip in your work summary. Every un-marked step must be completable and verifiable with **no network and no Supabase instance**.

**Goal:** Build the local-first foundation (auth plumbing, Dexie LocalStore, outbox + background SyncEngine, unified table conventions, Repository layer, one-shot legacy-data migration channel) that replaces the storage architecture of the 1108-line `index.html` single-file app.

**Architecture:** UI reads only from LocalStore (IndexedDB via Dexie); every write is one Dexie transaction that updates a business table and appends an ordered outbox entry, then returns "已保存". SyncEngine — the only component allowed to talk to the remote — pushes outbox entries in `seq` order and pulls via realtime subscription + watermark catch-up. Conflicts resolve on server-stamped `updated_at` (LWW), then `seq`, then `device_id`. A single schema registry (`TableDef[]`) generates the Dexie schema, the sync table list, the migration mapping, and the SQL DDL — structurally preventing the "漏 exams" class of bug.

**Tech Stack:** Vite + TypeScript (strict) + Vue 3, Dexie 4, `@supabase/supabase-js` v2, Vitest, `fake-indexeddb`, `tsx` (for the DDL generator script). Node ≥ 20.

**Spec:** `docs/superpowers/specs/2026-10-17-infra-and-sync-engine-design.md` — read it fully before executing; the plan argues from the spec. Do not edit the spec.

## Global Constraints

- `index.html` at repo root is **never modified** (spec §10): reference implementation and migration data source. New app code lives only in `webapp/`; all SQL only in `supabase/migrations/*.sql`.
- No Supabase connection details exist yet (`SUPABASE_URL`, anon key, schema export are all missing). The plan is ordered so that Tasks 1–14 and the local half of 15–18 verify fully without an instance. Anything requiring the live instance is marked 🚫CRED.
- `node`/`npm` were just installed via winget and are **not on the PATH of the current session** — Task 1 Step 1 handles this before anything else.
- `updated_at` is server-generated only (spec §5.2/§5.4): push payloads must never contain it; SQL triggers stamp it.
- Deletes are soft only — tombstones in `deleted_at` (spec §4).
- No client clocks in conflict decisions (spec §5.4).
- Database has no `idCard` column (spec §2.1): the legacy `idCard` field is dropped during migration (it survives only in the pre-migration JSON backup).
- No base64 or bytes ever in database rows; images live in an IndexedDB blob store, rows keep object paths (spec §5.5).
- Connection strings, keys, bucket names come from environment variables only (spec §2.1): `webapp/.env` with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_BUCKET` (bucket default `album`); `.env` is gitignored, `.env.example` committed; the app must boot and pass all tests with the env file absent.
- RLS unified to `owner_id = auth.uid()`, all four policies per table (spec §4).
- Dependencies allowed: runtime `dexie`, `@supabase/supabase-js` (^2), `fake-indexeddb` (runtime too — it is the private-browsing in-memory fallback, see Task 17); dev: `vite`, `@vitejs/plugin-vue`, `typescript`, `vue`, `vue-tsc`, `vitest`, `tsx`. Nothing else — no CRDT libs, no xlsx lib (parsers are ported from `index.html`).
- Single-teacher scenario (spec §2/§5.4). Business modules (students/grades UI etc.) are out of scope; only the tables' storage conventions and migration mapping are defined here.

## Acceptance Criteria Coverage (spec §9)

| # | Criterion (spec §9) | Covered by | Locally verifiable? |
|---|---|---|---|
| 1 | 断网 30 次写入，恢复后远端 30 条齐全、顺序一致、无重复 | Task 8 (outbox order/dedup) + Task 9 (push) + Task 18 test `A1` | **Locally yes** against FakeGateway; the remote side is a faithful gateway, but final confirmation on the live instance is 🚫CRED |
| 2 | 两实例编辑同一行，刷新后收敛且可解释 | Task 4 (conflict matrix) + Task 7 (remote apply) + Task 18 test `A2` | **Locally yes**; live two-browser check 🚫CRED |
| 3 | 删除后另一设备刷新不复活 | Task 5 (soft delete), Task 7 (tombstone apply), Task 18 test `A3` | **Locally yes**; live check 🚫CRED |
| 4 | 相册断网可新增可查看 | Task 12 (blob store + upload queue), Task 18 test `A4` | **Locally yes**; live Storage upload 🚫CRED |
| 5 | 旧数据导入逐项比对无字段丢失（含 `exams`） | Task 6 (registry), Task 14 (migration) | **Fully local** — no credentials needed |
| 6 | 新增表仅需 schema + 注册，无同步代码 | Task 6 `addTableDef()` + registry-driven LocalStore/outbox/push/pull/DDL (Tasks 5-10, 16) + Task 18 test `A6` | **Fully local**; applying generated DDL on the live instance 🚫CRED |

Explicitly blocked until credentials arrive: live login (Task 11), realtime subscription against the real server (Task 10), `supabase db push` + trigger/RLS behavior (Task 16), live Storage upload (Task 12), end-to-end reruns of criteria 1–4 against the real instance (Task 18 checklist).

## File Structure

```
webapp/
  index.html  vite.config.ts  vitest.config.ts  tsconfig.json  .env.example
  src/
    main.ts                     # mounts App over bootstrap() (Task 17)
    core/
      types.ts                  # RowBase, Row, OutboxEntry, RemoteRow, SyncState
      schema.ts                 # TableDef registry: single source of truth
      case.ts                   # camel<->snake, toRemoteRow (drops updated_at, injects owner_id), fromRemoteRow
      db.ts                     # WbDb (Dexie): business tables from registry + outbox + sync_meta + images
      meta.ts                   # MetaStore: deviceId, seq counter, watermark, legacyBackup, migrationDone
      conflict.ts               # pure incomingWins() + isoMax()
      localStore.ts             # LocalStore: tx put/softDelete (outbox in same tx), get/live, applyRemote*
      outbox.ts                 # Outbox: seq-ordered queue, done/failed/backoff/blocked, count, pendingTables
      syncEngine.ts             # push/pull loop, realtime subscribe, wake triggers, phases, upload_image
      gateway.ts                # RemoteGateway interface + PermissionDeniedError/RetryableError
      supabaseClient.ts         # createSupabaseClient(): env-gated, null without credentials
      supabaseGateway.ts        # RemoteGateway over supabase-js (only module importing it)
      auth.ts                   # Auth class: session uid cache, onUidChange
      images.ts                 # ImageStore: blob-first add + upload_image outbox entry; dataUrlToBlob
      repository.ts             # generic Repository (per-table business facade)
      migration.ts              # legacy JSON -> LocalStore, deterministic uuids, idempotent, report
      importContacts.ts         # CSV/XLSX -> contact rows, row-level validation, report
      legacyParsers.ts          # parseCsv + parseXlsx ported verbatim from index.html
      bootstrap.ts              # DI root: probe IDB, deviceId, stores, auth?, gateway?, engine, lastStorageMode
    env.d.ts                    # ImportMetaEnv typing
    tools/genDdl.ts             # registry -> supabase/migrations/*_0001_tables.sql
    App.vue                     # local-first shell: status banner, migration panel (gated on migrationDone), demo write
    components/StatusBanner.vue # 已保存 / 待同步 N 条 / 已同步 split display
    components/LoginForm.vue    # email+password form; hidden until Auth exists
  test/
    setup.ts                    # fake-indexeddb/auto; reset databases between tests
    unit/…spec.ts               # case, schema, conflict, outbox, localStore, syncEngine.push, syncEngine.pull,
                                # images, repository, migration, importContacts, supabaseGateway(undici-mocked)
    fixtures/wb_tw_data.sample.json
    fixtures/contacts.csv
    acceptance.local.spec.ts    # criteria 1–6 without a live instance
supabase/migrations/            # generated + hand-written SQL (applied only when credentials arrive)
docs/superpowers/plans/2026-10-17-infra-and-sync-engine.md   # this file
docs/superpowers/specs/2026-10-17-infra-and-sync-engine-design.md  # spec (read-only)
```

Registry `TABLE_DEFS` (Task 6) covers all legacy keys — `students, todos, schedule, seating, duty, violations, communications, grades, exams, homework, points, drafts (→notices/comments), activities, behaviors, committee, settings` — so migration can never silently omit one (`exams` included).

---

## Phase A — Toolchain & Skeleton (no credentials needed)

### Task 1: Verify toolchain, then scaffold Vite + Vue 3 + TS + Vitest

**Files:**
- Create: `webapp/` (via Vite scaffold), `webapp/vitest.config.ts`, `webapp/tsconfig.json` (edit), `webapp/test/setup.ts`, `webapp/.env.example`
- Modify: `webapp/package.json` (scripts/deps), `.gitignore` (repo root, append `webapp/node_modules/`, `webapp/dist/`, `webapp/.env`)

**Interfaces:**
- Produces: `npm run build` / `npm run test` / `npm run typecheck` scripts; a green empty test run — every later task depends on this working in `webapp/`.

- [ ] **Step 1: Verify node/npm are reachable in this session.** Run `node --version` (expect `v20.x`+) and `npm --version` in the repo root shell. **If not found: the winget PATH update requires a full Qoder restart — quit Qoder completely, reopen, and re-verify before doing anything else.** Do not hardcode winget paths or edit PATH manually.
- [ ] **Step 2: Scaffold.** From repo root: `npm create vite@latest webapp -- --template vue-ts`. Then `cd webapp && npm install`.
- [ ] **Step 3: Add dependencies.** `npm i dexie @supabase/supabase-js fake-indexeddb && npm i -D vitest tsx vue-tsc`.
- [ ] **Step 4: Configure Vitest.** Create `webapp/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ plugins: [vue()], test: { environment: 'node', setupFiles: ['test/setup.ts'], include: ['test/**/*.spec.ts'] } })
```

Create `webapp/test/setup.ts`:

```ts
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
afterEach(() => { globalThis.indexedDB = new IDBFactory() })
```

- [ ] **Step 5: Strict TS.** In `webapp/tsconfig.json` set `"strict": true` and add `"types": ["vite/client"]` to `compilerOptions`. Create `webapp/src/env.d.ts`:

```ts
/// <reference types="vite/client" />
interface ImportMetaEnv { readonly VITE_SUPABASE_URL?: string; readonly VITE_SUPABASE_ANON_KEY?: string; readonly VITE_SUPABASE_BUCKET?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
```

- [ ] **Step 6: Scripts + env example.** In `package.json` set: `"test": "vitest run"`, `"typecheck": "vue-tsc --noEmit"`, `"gen:ddl": "tsx src/tools/genDdl.ts"`. Create `webapp/.env.example` with the three `VITE_SUPABASE_*` keys, each commented `# fill when Supabase credentials are available`. Add `webapp/.env` to `.gitignore`.
- [ ] **Step 7: Smoke test.** Create `webapp/test/unit/smoke.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import 'fake-indexeddb/auto'
describe('toolchain', () => {
  it('indexedDB is available and strict TS builds', async () => {
    expect(indexedDB).toBeDefined()
    const req = indexedDB.open('smoke-db', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('t')
    await new Promise((res, rej) => { req.onsuccess = () => { req.result.close(); res(null) }; req.onerror = () => rej(req.error) })
    expect(typeof crypto.randomUUID()).toBe('function')
  })
})
```

- [ ] **Step 8: Run tests + typecheck + build.** `npm run test` (expect PASS), `npm run typecheck` (expect no errors), `npm run build` (expect success). Delete the scaffold's default `HelloWorld.vue` usage if typecheck complains about unused demo code (keep `App.vue` minimal: `<template><div>wb</div></template>`).
- [ ] **Step 9: Commit.** `git add webapp .gitignore && git commit -m "chore: scaffold vite+vue3+ts+vitest app shell (no supabase)"`

---

## Phase B — Local-First Core (fully verifiable without an instance)

### Task 2: Row conventions + case conversion

**Files:**
- Create: `webapp/src/core/types.ts`, `webapp/src/core/case.ts`, `webapp/test/unit/case.spec.ts`

**Interfaces:**
- Produces: `RowBase { id, ownerId, seq, updatedAt, deletedAt, deviceId }`, `Row = RowBase & Record<string, unknown>`, `OutboxEntry`, `RemoteRow = Record<string, unknown>`; `camelToSnake(s): string`, `snakeToCamel(s): string`, `toRemoteRow(row: Record<string, unknown>, ownerUid: string): RemoteRow`, `fromRemoteRow(r: RemoteRow): Record<string, unknown>`.
- Consumes: nothing (foundation).

- [ ] **Step 1: Write failing test** `test/unit/case.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { camelToSnake, snakeToCamel, toRemoteRow, fromRemoteRow } from '../../src/core/case'
describe('case + row conventions', () => {
  it('converts keys both ways', () => {
    expect(camelToSnake('guardian1Phone')).toBe('guardian1_phone')
    expect(snakeToCamel('guardian1_phone')).toBe('guardian1Phone')
    expect(camelToSnake('id')).toBe('id')
  })
  it('toRemoteRow drops updatedAt and injects owner_id (spec §5.2, §5.4)', () => {
    const r = toRemoteRow({ id: 'a', ownerId: null, seq: 3, updatedAt: '2026-10-17T00:00:00Z', deletedAt: null, deviceId: 'd1', studentNo: '5' }, 'u-9')
    expect(r.updated_at).toBeUndefined()
    expect(r.owner_id).toBe('u-9')
    expect(r.student_no).toBe('5')
    expect(r.seq).toBe(3)
  })
  it('fromRemoteRow restores camelCase incl. server updated_at', () => {
    const l = fromRemoteRow({ id: 'a', owner_id: 'u-9', seq: 3, updated_at: '2026-10-17T00:00:00Z', deleted_at: null, device_id: 'd1' })
    expect(l.updatedAt).toBe('2026-10-17T00:00:00Z')
    expect(l.deviceId).toBe('d1')
    expect(l.ownerId).toBe('u-9')
  })
})
```

- [ ] **Step 2: Run, confirm FAIL** (`Cannot find module …/case`).
- [ ] **Step 3: Implement** `src/core/types.ts`:

```ts
export interface RowBase {
  id: string
  ownerId: string | null   // server-side authoritative; local copy may be null pre-auth
  seq: number              // local monotonic, clock-independent tiebreaker
  updatedAt: string | null // SERVER timestamp only; null = never confirmed by server
  deletedAt: string | null // soft-delete tombstone
  deviceId: string
}
export type Row = RowBase & Record<string, unknown>
export interface OutboxEntry {
  seq: number
  table: string
  recordId: string
  op: 'upsert' | 'delete' | 'upload_image'
  payload: Record<string, unknown>
  attempts: number
  nextAttemptAt: number    // epoch ms
  blocked: boolean         // RLS 403: stop retrying, surface error (spec §7)
  lastError?: string
}
export type RemoteRow = Record<string, unknown>
```

Implement `src/core/case.ts`:

```ts
import type { RowBase, RemoteRow } from './types'
const c2s = new Map<string, string>()
const s2c = new Map<string, string>()
export function camelToSnake(k: string): string {
  let v = c2s.get(k); if (v !== undefined) return v
  v = k.replace(/[A-Z]/g, m => '_' + m.toLowerCase()); c2s.set(k, v); return v
}
export function snakeToCamel(k: string): string {
  let v = s2c.get(k); if (v !== undefined) return v
  v = k.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()); s2c.set(k, v); return v
}
export function toRemoteRow(row: Record<string, unknown>, ownerUid: string): RemoteRow {
  const out: RemoteRow = {}
  for (const [k, v] of Object.entries(row)) {
    if (k === 'updatedAt' || k === 'updated_at') continue   // server trigger owns it (spec §5.2)
    if (k === 'ownerId') { out.owner_id = ownerUid; continue }
    out[camelToSnake(k)] = v
  }
  out.owner_id = ownerUid
  return out
}
export function fromRemoteRow(r: RemoteRow): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(r)) out[snakeToCamel(k)] = v
  return out
}
export type { RowBase }
```

- [ ] **Step 4: Run `npx vitest run test/unit/case.spec.ts`** → PASS.
- [ ] **Step 5: `npm run typecheck`** → clean. **Commit:** `git add webapp/src/core webapp/test/unit/case.spec.ts && git commit -m "feat(core): unified row conventions and camel/snake boundary"`

### Task 3: Dexie database + MetaStore (deviceId, seq, watermark, backups)

**Files:**
- Create: `webapp/src/core/db.ts`, `webapp/src/core/meta.ts`, `webapp/test/unit/meta.spec.ts`

**Interfaces:**
- Consumes: `RowBase`, `OutboxEntry` from Task 2.
- Produces: `WbDb` (Dexie subclass) with tables `outbox` (pk `seq`), `syncMeta` (pk `key`), `images` (pk `id`); `openDb(name?): Promise<WbDb>`; `MetaStore(db)` with `getDeviceId(): Promise<string>` (stable uuid across calls), `nextSeq(tx?): Promise<number>`, `getWatermark(): Promise<string>` (initial `'1970-01-01T00:00:00.000Z'`), `setWatermark(iso): Promise<void>`, `getBackup(k)/setBackup(k, json)`.
- Note: business tables are not declared here — Task 6 registers them from `TABLE_DEFS` via `db.registerTable`. `images` records: `{ id: string; blob: Blob; ownerId: string | null; objectPath: string | null; uploaded: boolean }`.

- [ ] **Step 1: Write failing test** `test/unit/meta.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run → FAIL** (missing modules).
- [ ] **Step 3: Implement** `src/core/db.ts`:

```ts
import Dexie, { type Table } from 'dexie'
import type { OutboxEntry, RowBase } from './types'
export interface ImageRecord { id: string; blob: Blob; ownerId: string | null; objectPath: string | null; uploaded: boolean }
export interface MetaRecord { key: string; value: string }
export class WbDb extends Dexie {
  outbox!: Table<OutboxEntry, number>
  syncMeta!: Table<MetaRecord, string>
  images!: Table<ImageRecord, string>
  business = new Map<string, Table<RowBase & Record<string, unknown>, string>>()
  private lv = 1
  constructor(name: string) {
    super(name)
    this.version(1).stores({ outbox: 'seq, table', syncMeta: 'key', images: 'id, ownerId' })
  }
  /** Called by the schema registry (Task 6) for each TableDef. Idempotent per table name. */
  registerTable(name: string): void {
    if (this.business.has(name)) return
    this.lv += 1
    this.version(this.lv).stores({ [name]: 'id, seq, ownerId' })
    this.business.set(name, this.table(name))
  }
}
export async function openDb(name = 'wb-app'): Promise<WbDb> {
  const db = new WbDb(name)
  await db.open()
  return db
}
```

> Implementation note: `lv` is an instance counter; the behavior contract is that `registerTable` is idempotent per table name and bumps the Dexie version exactly once per new table. Public API used by later tasks: `openDb`, `registerTable`, `db.business.get(name)`.

Implement `src/core/meta.ts`:

```ts
import type { WbDb } from './db'
export const EPOCH = '1970-01-01T00:00:00.000Z'
export class MetaStore {
  constructor(private db: WbDb) {}
  private async kv(key: string): Promise<string | undefined> { return (await this.db.syncMeta.get(key))?.value }
  private async setKv(key: string, value: string) { await this.db.syncMeta.put({ key, value }) }
  async getDeviceId(): Promise<string> {
    const cur = await this.kv('deviceId'); if (cur) return cur
    const id = crypto.randomUUID(); await this.setKv('deviceId', id); return id
  }
  async nextSeq(): Promise<number> {
    return this.db.transaction('rw', this.db.syncMeta, async () => {
      const cur = Number((await this.kv('seq')) ?? '0'); const n = cur + 1
      await this.setKv('seq', String(n)); return n
    })
  }
  async getWatermark(): Promise<string> { return (await this.kv('watermark')) ?? EPOCH }
  async setWatermark(iso: string): Promise<void> { await this.setKv('watermark', iso) }
  async getBackup(name: string): Promise<string | undefined> { return this.kv('backup:' + name) }
  async setBackup(name: string, json: string): Promise<void> { await this.setKv('backup:' + name, json) }
}
```

- [ ] **Step 4: Run `npx vitest run test/unit/meta.spec.ts`** → PASS (fix `registerTable` versioning only if the smoke here exposes it; business tables are untouched by this test).
- [ ] **Step 5: Commit.** `git add webapp/src/core/db.ts webapp/src/core/meta.ts webapp/test/unit/meta.spec.ts && git commit -m "feat(core): dexie store with outbox/sync-meta/images"`

### Task 4: Conflict resolution — pure functions + unit matrix

**Files:**
- Create: `webapp/src/core/conflict.ts`, `webapp/test/unit/conflict.spec.ts`

**Interfaces:**
- Produces: `incomingWins(local: RowBase | null, incoming: RowBase): boolean` implementing spec §5.4: (1) server `updated_at` LWW; (2) equal → bigger `seq` wins; (3) equal → bigger `device_id` wins (deterministic, no jitter). Also `isoMax(a: string, b: string): string` and `maxUpdatedAt(rows: RowBase[]): string | null`.
- Consumes: `RowBase` (Task 2).

Rules made explicit (encode these as tests):
- `local === null` → incoming wins (new row).
- `local.updatedAt === null` (local edit never server-confirmed) vs incoming with `updatedAt !== null` → incoming wins (only server stamps count).
- Both `updatedAt === null` (incoming cannot have null from a real server; FakeGateway always stamps) → fall through to `seq` then `deviceId`.
- ISO strings compare lexicographically (all server stamps are UTC `timestamptz` rendered with `Z`).
- Deleted-vs-edited is NOT special here: a tombstone wins purely by the same ordering; revival prevention is tested in Task 8/13.

- [ ] **Step 1: Write failing test** `test/unit/conflict.spec.ts` (full matrix):

```ts
import { describe, it, expect } from 'vitest'
import { incomingWins, isoMax } from '../../src/core/conflict'
import type { RowBase } from '../../src/core/types'
const R = (over: Partial<RowBase> = {}): RowBase =>
  ({ id: 'r', ownerId: 'u', seq: 1, updatedAt: '2026-10-17T00:00:00Z', deletedAt: null, deviceId: 'AAA', ...over })
describe('incomingWins (spec §5.4)', () => {
  it('no local row: incoming wins', () => expect(incomingWins(null, R())).toBe(true))
  it('newer incoming updatedAt wins regardless of seq', () =>
    expect(incomingWins(R({ updatedAt: '2026-10-17T00:00:01Z', seq: 99 }), R({ updatedAt: '2026-10-17T00:00:02Z', seq: 1 }))).toBe(true))
  it('older incoming loses', () =>
    expect(incomingWins(R({ updatedAt: '2026-10-17T00:00:03Z' }), R({ updatedAt: '2026-10-17T00:00:02Z' }))).toBe(false))
  it('equal updatedAt: higher seq wins', () =>
    expect(incomingWins(R({ seq: 5 }), R({ seq: 6 }))).toBe(true))
  it('equal updatedAt+seq: higher deviceId wins', () =>
    expect(incomingWins(R({ deviceId: 'BBB' }), R({ deviceId: 'CCC' }))).toBe(true))
  it('fully equal: incoming wins (idempotent put, no jitter)', () =>
    expect(incomingWins(R(), R())).toBe(true))
  it('unpushed local (updatedAt null) loses to any stamped incoming', () =>
    expect(incomingWins(R({ updatedAt: null, seq: 999 }), R({ updatedAt: '2020-01-01T00:00:00Z', seq: 1 }))).toBe(false))
  it('incoming without stamp never overwrites stamped local', () =>
    expect(incomingWins(R({ updatedAt: '2026-10-17T00:00:00Z' }), R({ updatedAt: null }))).toBe(false))
  it('both unstamped: falls through to seq then deviceId', () => {
    expect(incomingWins(R({ updatedAt: null, seq: 2 }), R({ updatedAt: null, seq: 3 }))).toBe(true)
    expect(incomingWins(R({ updatedAt: null, seq: 3, deviceId: 'X' }), R({ updatedAt: null, seq: 3, deviceId: 'Y' }))).toBe(true)
  })
  it('isoMax', () => expect(isoMax('2026-10-17T00:00:01Z', '2026-10-17T00:00:02Z')).toBe('2026-10-17T00:00:02Z'))
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/conflict.ts`:

```ts
import type { RowBase } from './types'
export function incomingWins(local: RowBase | null, incoming: RowBase): boolean {
  if (!local) return true
  const lu = local.updatedAt, iu = incoming.updatedAt
  if (lu === null && iu === null) return tieBreak(local, incoming)
  if (lu === null) return false   // unpushed local yields: only server stamps count (spec §5.4)
  if (iu === null) return false   // unstamped incoming never overwrites a stamped local
  if (lu !== iu) return iu > lu
  return tieBreak(local, incoming)
}
function tieBreak(local: RowBase, incoming: RowBase): boolean {
  if (local.seq !== incoming.seq) return incoming.seq > local.seq
  return incoming.deviceId >= local.deviceId
}
export function isoMax(a: string, b: string): string { return a >= b ? a : b }
```

- [ ] **Step 4: Run `npx vitest run test/unit/conflict.spec.ts`** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/conflict.ts webapp/test/unit/conflict.spec.ts && git commit -m "feat(core): LWW+seq+device conflict resolution matrix"`

### Task 5: Write path — LocalStore put/softDelete with same-transaction outbox append

**Files:**
- Create: `webapp/src/core/localStore.ts`, `webapp/test/unit/localStore.write.spec.ts`

**Interfaces:**
- Consumes: `WbDb` + `MetaStore` (Task 3), `RowBase`/`OutboxEntry` (Task 2), `incomingWins` (Task 4), `fromRemoteRow` (Task 2).
- Produces class `LocalStore`:
  - `constructor(deps: { db: WbDb; meta: MetaStore; deviceId: string; ownerUid: () => string | null; table(name: string): Table<Row, string> })` — `table()` is injected by the registry (Task 6); LocalStore itself must not know table names (acceptance criterion 6).
  - `put(table: string, fields: Record<string, unknown> & { id: string }): Promise<Row>` — spec §5.1 steps 1–3: one Dexie transaction writing business row + outbox entry `op:'upsert'` with the full payload; allocates `seq` from `MetaStore` inside that transaction; sets `deletedAt: null`, `ownerId` from `ownerUid()`, `deviceId`; preserves existing `updatedAt`.
  - `softDelete(table: string, id: string): Promise<void>` — sets `deletedAt = new Date().toISOString()` (a marker; ordering still uses server `updated_at`), appends outbox entry `op:'delete'` with the full row snapshot (so the tombstone survives even if the row was never pushed).
  - `get(table, id): Promise<Row | undefined>`, `live(table): Promise<Row[]>` (`deletedAt === null`, ascending by insertion), `pendingCount(): Promise<number>`.
  - Remote side (used in Task 7): `applyRemote(table: string, incomingRaw: RemoteRow): Promise<void>` and `applyRemoteBulk(table, rows): Promise<void>` — convert with `fromRemoteRow`, apply `incomingWins`, write **directly via the Dexie table (bypassing the outbox — remote data must never re-enqueue)** and never touch `seq`/`deviceId` of local edits.

- [ ] **Step 1: Write failing tests** `test/unit/localStore.write.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import Dexie, { type Table } from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import type { RowBase } from '../../src/core/types'
type Row = RowBase & Record<string, unknown>

function makeLocal(db: WbDb) {
  db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({
    db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: (n) => db.business.get(n) as Table<Row, string>,
  })
  return { meta, store }
}

describe('LocalStore write path (spec §5.1)', () => {
  let db: WbDb
  beforeEach(async () => { db = await openDb('lw-' + Math.random()) })

  it('put writes row + outbox entry atomically, seq monotonic', async () => {
    const { store } = makeLocal(db)
    const r1 = await store.put('notes', { id: 'n1', title: 'a' })
    const r2 = await store.put('notes', { id: 'n2', title: 'b' })
    expect(r2.seq).toBeGreaterThan(r1.seq)
    expect(r1.deletedAt).toBeNull()
    const ob = await db.outbox.toArray()
    expect(ob.map(e => e.seq)).toEqual([r1.seq, r2.seq])          // ascending, one per write
    expect(ob[0].op).toBe('upsert')
    expect(ob[0].payload.title).toBe('a')
    expect(ob[0].payload.updatedAt).toBeUndefined()               // client never supplies it
    expect((ob[0].payload as Record<string, unknown>).ownerId).toBe('u-1')
  })

  it('put merges into existing row and keeps server updatedAt', async () => {
    const { store } = makeLocal(db)
    await store.put('notes', { id: 'n1', title: 'a' })
    await store.applyRemote('notes', { id: 'n1', owner_id: 'u-1', seq: 7, updated_at: '2026-10-17T05:00:00Z', deleted_at: null, device_id: 'dev-A', title: 'a' })
    const r = await store.put('notes', { id: 'n1', title: 'a2' })
    expect(r.updatedAt).toBe('2026-10-17T05:00:00Z')
    expect((await db.outbox.toArray()).length).toBe(2)            // both writes queued
  })

  it('softDelete is a tombstone + queued delete, row hidden from live()', async () => {
    const { store } = makeLocal(db)
    await store.put('notes', { id: 'n1', title: 'a' })
    await store.softDelete('notes', 'n1')
    expect(await store.live('notes')).toEqual([])
    const raw = await store.get('notes', 'n1')
    expect(raw!.deletedAt).not.toBeNull()
    const ob = await db.outbox.toArray()
    expect(ob[1].op).toBe('delete')
    expect((ob[1].payload as Row).deletedAt).not.toBeNull()
  })

  it('pendingCount mirrors outbox size', async () => {
    const { store } = makeLocal(db)
    expect(await store.pendingCount()).toBe(0)
    await store.put('notes', { id: 'n1' })
    expect(await store.pendingCount()).toBe(1)
  })
})
```

- [ ] **Step 2: Run → FAIL** (missing `localStore`).
- [ ] **Step 3: Implement** `src/core/localStore.ts`:

```ts
import type { Table } from 'dexie'
import type { MetaStore } from './meta'
import { incomingWins } from './conflict'
import { fromRemoteRow } from './case'
import type { RemoteRow, Row, RowBase } from './types'
import type { WbDb } from './db'

export interface LocalStoreDeps {
  db: WbDb
  meta: MetaStore
  deviceId: string
  ownerUid: () => string | null
  table(name: string): Table<Row, string>
}

export class LocalStore {
  constructor(private d: LocalStoreDeps) {}
  private t(name: string) { const t = this.d.table(name); if (!t) throw new Error(`unregistered table: ${name}`); return t }

  async put(table: string, fields: Record<string, unknown> & { id: string }): Promise<Row> {
    const t = this.t(table)
    return this.d.db.transaction('rw', t, this.d.db.outbox, this.d.db.syncMeta, async () => {
      const seq = await this.d.meta.nextSeq()
      const old = await t.get(fields.id)
      const row: Row = {
        ...(old ?? {}), ...fields, id: fields.id,
        ownerId: this.d.ownerUid(), seq, deviceId: this.d.deviceId,
        updatedAt: old?.updatedAt ?? null, deletedAt: null,
      } as Row
      await t.put(row)
      await this.d.db.outbox.put({ seq, table, recordId: fields.id, op: 'upsert', payload: { ...row }, attempts: 0, nextAttemptAt: 0, blocked: false })
      return row
    })
  }

  async softDelete(table: string, id: string): Promise<void> {
    const t = this.t(table)
    await this.d.db.transaction('rw', t, this.d.db.outbox, this.d.db.syncMeta, async () => {
      const old = await t.get(id)
      if (!old) return
      const seq = await this.d.meta.nextSeq()
      const row: Row = { ...old, deletedAt: new Date().toISOString(), seq, ownerId: this.d.ownerUid(), deviceId: this.d.deviceId }
      await t.put(row)
      await this.d.db.outbox.put({ seq, table, recordId: id, op: 'delete', payload: { ...row }, attempts: 0, nextAttemptAt: 0, blocked: false })
    })
  }

  async get(table: string, id: string): Promise<Row | undefined> { return this.t(table).get(id) }
  async live(table: string): Promise<Row[]> { return (await this.t(table).toArray()).filter(r => r.deletedAt === null) }
  async pendingCount(): Promise<number> { return this.d.db.outbox.count() }

  async applyRemote(table: string, incomingRaw: RemoteRow): Promise<void> {
    const incoming = fromRemoteRow(incomingRaw) as unknown as Row
    await this.applyRemoteRow(table, incoming)
  }
  async applyRemoteBulk(table: string, rows: RemoteRow[]): Promise<void> {
    for (const r of rows) await this.applyRemote(table, r)
  }
  private async applyRemoteRow(table: string, incoming: RowBase & Record<string, unknown>): Promise<void> {
    const t = this.t(table)
    await this.d.db.transaction('rw', t, async () => {
      const local = await t.get(incoming.id)
      if (incomingWins(local ?? null, incoming)) await t.put(incoming)  // bypass outbox: server data is not a local edit
    })
  }
}
```

- [ ] **Step 4: Run `npx vitest run test/unit/localStore.write.spec.ts`** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/localStore.ts webapp/test/unit/localStore.write.spec.ts && git commit -m "feat(core): transactional write path with same-tx outbox append"`

### Task 6: Schema registry — unified table conventions as single source of truth

**Files:**
- Create: `webapp/src/core/schema.ts`, `webapp/test/unit/schema.spec.ts`

**Interfaces:**
- Consumes: `WbDb.registerTable` (Task 3), `RowBase` (Task 2).
- Produces: `TableDef` + `TABLE_DEFS: TableDef[]` (all 16 legacy keys), `registerAllTables(db: WbDb): void`, `tableNames(): string[]`, `legacyKeyIndex(): Record<string, TableDef>` (maps `wb_tw_data` JSON keys → defs, including both drafts sub-keys under `'drafts'`), `LEGACY_ARRAY_KEYS: string[]` derived from the defs (used by migration so no key can be forgotten).

```ts
export interface TableDef {
  name: string                       // local AND remote name (spec §4 同构)
  legacyKey?: string                 // key inside wb_tw_data JSON
  legacySubKey?: string              // e.g. drafts -> notices | comments
  singleton?: boolean                // seating, settings: whole object == one row
  columns: string[]                  // legacy field names kept as payload (audit cols implicit)
  dropColumns?: string[]             // fields never entering the DB (idCard: spec §2.1; base64 fields)
  imageColumns?: string[]            // string[] of dataURLs -> blob store (activities/behaviors images)
  photoColumn?: string               // single dataURL -> blob store (students.photo)
  fkColumns?: string[]               // studentId values remapped to derived uuids
  jsonColumns?: string[]             // fields stored as jsonb (columns whose type is jsonb in DDL)
}
```

- [ ] **Step 1: Write failing test** `test/unit/schema.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { TABLE_DEFS, legacyKeyIndex, registerAllTables } from '../../src/core/schema'
import { openDb } from '../../src/core/db'
describe('schema registry', () => {
  it('covers every legacy key from index.html load() (line 90) — exams included', () => {
    const legacyTopKeys = ['students','todos','schedule','seating','duty','violations','communications','grades','exams','homework','points','drafts','activities','behaviors','committee','settings']
    const kSet = coveredLegacyKeys()
    for (const k of legacyTopKeys) expect(kSet.has(k), 'missing legacyKey: ' + k).toBe(true)
    const idx = legacyKeyIndex()
    expect(TABLE_DEFS.find(d => d.name === 'exams')!.legacyKey).toBe('exams')
    expect(TABLE_DEFS.find(d => d.name === 'notices')!.legacySubKey).toBe('notices')
    expect(TABLE_DEFS.find(d => d.name === 'students')!.dropColumns).toContain('idCard')
  })
  it('registers all tables into the dexie db idempotently', async () => {
    const db = await openDb('sch-' + Math.random())
    registerAllTables(db); registerAllTables(db)
    expect(db.business.size).toBe(TABLE_DEFS.length)
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/schema.ts`. Field lists below were extracted from `index.html` (line 84 state shape; pushes at 159/161/172/176/183/197/199/392/574/582/869/936; load() at 90):

```ts
import type { WbDb } from './db'
export interface TableDef { /* as declared in Interfaces */
  name: string; legacyKey?: string; legacySubKey?: string; singleton?: boolean
  columns: string[]; dropColumns?: string[]; imageColumns?: string[]; photoColumn?: string
  fkColumns?: string[]; jsonColumns?: string[]
}
export const TABLE_DEFS: TableDef[] = [
  { name: 'students', legacyKey: 'students',
    columns: ['name','studentNo','gender','primarySchool','address','guardian1Name','guardian1Phone','guardian2Name','guardian2Phone','group','tags','notes','photoPath'],
    dropColumns: ['idCard'], photoColumn: 'photo', jsonColumns: ['tags'] },
  { name: 'notices', legacyKey: 'drafts', legacySubKey: 'notices', columns: ['title','content','date'] },
  { name: 'comments', legacyKey: 'drafts', legacySubKey: 'comments', columns: ['title','content','date'] },
  { name: 'todos', legacyKey: 'todos', columns: ['title','content','deadline','priority','category','completed'] },
  { name: 'schedule', legacyKey: 'schedule', columns: ['day','period','subject','class','weekType'] },
  { name: 'seating', legacyKey: 'seating', singleton: true, columns: ['rows','cols','seats'], jsonColumns: ['seats'] },
  { name: 'duty', legacyKey: 'duty', columns: ['week','group','tasks'], jsonColumns: ['tasks'] },
  { name: 'violations', legacyKey: 'violations', columns: ['studentId','date','event','action'], fkColumns: ['studentId'] },
  { name: 'communications', legacyKey: 'communications', columns: ['studentId','date','method','content','followUp'], fkColumns: ['studentId'] },
  { name: 'grades', legacyKey: 'grades', columns: ['examName','subject','date','scores'], jsonColumns: ['scores'] },
  { name: 'exams', legacyKey: 'exams', columns: ['name','date','subjects','students','stats'], jsonColumns: ['subjects','students','stats'] },
  { name: 'homework', legacyKey: 'homework', columns: ['date','subject','title','records'], jsonColumns: ['records'], fkColumns: [] },
  { name: 'points', legacyKey: 'points', columns: ['studentId','points','type','reason','date'], fkColumns: ['studentId'] },
  { name: 'activities', legacyKey: 'activities', columns: ['title','date','content','imagePaths'], imageColumns: ['images'] },
  { name: 'behaviors', legacyKey: 'behaviors', columns: ['studentId','date','type','level','title','description','imagePaths'], imageColumns: ['images'], fkColumns: ['studentId'] },
  { name: 'committee', legacyKey: 'committee', columns: ['studentId','position'], fkColumns: ['studentId'] },
  { name: 'settings', legacyKey: 'settings', singleton: true, columns: ['subjects','mySubjects','tags','dutyPositions','weekType'], jsonColumns: ['subjects','mySubjects','tags','dutyPositions'] },
]
export function tableDef(name: string): TableDef | undefined { return TABLE_DEFS.find(d => d.name === name) }
export function tableNames(): string[] { return TABLE_DEFS.map(d => d.name) }
export function legacyKeyIndex(): Record<string, TableDef> {
  const out: Record<string, TableDef> = {}
  for (const d of TABLE_DEFS) if (d.legacyKey) out[d.legacyKey + (d.legacySubKey ? '.' + d.legacySubKey : '')] = d
  return out
}
/** every distinct top-level wb_tw_data key that defs claim — migration iterates defs, never a hand-written list */
export function coveredLegacyKeys(): Set<string> { return new Set(TABLE_DEFS.map(d => d.legacyKey).filter(Boolean) as string[]) }
export function registerAllTables(db: WbDb): void { for (const d of TABLE_DEFS) db.registerTable(d.name) }
/** Runtime registration: adding a business table = one TableDef + db.registerTable. No other code. (Acceptance §9.6) */
export function addTableDef(db: WbDb, def: TableDef): void {
  if (tableDef(def.name)) throw new Error('duplicate table: ' + def.name)
  TABLE_DEFS.push(def); db.registerTable(def.name)
}
/** legacy json columns whose KEYS are student ids and must be remapped during migration */
export const JSON_FK_MAPS: { table: string; column: string }[] = [
  { table: 'homework', column: 'records' },
  { table: 'grades', column: 'scores' },
]
```

- [ ] **Step 4: Run `npx vitest run test/unit/schema.spec.ts`** → PASS. Also `npm run typecheck` clean.
- [ ] **Step 5: Commit.** `git add webapp/src/core/schema.ts webapp/test/unit/schema.spec.ts && git commit -m "feat(core): schema registry covering all legacy keys incl exams"`

### Task 7: Remote apply semantics + watermark advancement

**Files:**
- Create: `webapp/src/core/remoteApply.ts`, `webapp/test/unit/remoteApply.spec.ts`
- Modify: `webapp/src/core/localStore.ts` (move `applyRemote*` bodies here or keep LocalStore as facade — LocalStore's public methods stay; logic lives in `remoteApply.ts` for testability)

**Interfaces:**
- Consumes: `LocalStore` (Task 5), `incomingWins`/`isoMax` (Task 4), `MetaStore` (Task 3).
- Produces: `applyRemoteRows(store: LocalStore, meta: MetaStore, table: string, rows: RemoteRow[]): Promise<{ applied: number; newWatermark: string }>` — applies each row through the conflict rule and advances the watermark to `isoMax(current, max(updated_at of ALL fetched rows))` — advancement happens **after** the batch is applied (spec §5.3 "补拉后推进水位线"). `EPOCH` from Task 3 is the floor.

- [ ] **Step 1: Write failing test** `test/unit/remoteApply.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import { openDb } from '../../src/core/db'
import { MetaStore, EPOCH } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { applyRemoteRows } from '../../src/core/remoteApply'
import type { Row, RowBase } from '../../src/core/types'

function mk(seed = 'ra') {
  const DBNAME = seed + '-' + Math.random()
  return openDb(DBNAME).then(db => {
    db.registerTable('notes')
    const meta = new MetaStore(db)
    const store = new LocalStore({ db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
      table: n => db.business.get(n) as Table<Row, string> })
    return { db, meta, store }
  })
}
const rem = (over: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ id: 'n1', owner_id: 'u-1', seq: 1, updated_at: '2026-10-17T00:00:00Z', deleted_at: null, device_id: 'dev-A', ...over })

describe('applyRemoteRows + watermark', () => {
  it('applies newer incoming, keeps newer local edit, advances watermark to max seen', async () => {
    const { store, meta } = await mk()
    await store.put('notes', { id: 'n1', title: 'local-edit' })
    await store.applyRemote('notes', { ...rem({ updated_at: '2026-10-17T00:00:05Z' }), id: 'n2' })
    const r = await applyRemoteRows(store, meta, 'notes', [
      rem({ title: 'server-wins', updated_at: '2026-10-17T00:00:10Z' }),
      rem({ id: 'n3', updated_at: '2026-10-17T00:00:02Z' }),
    ])
    expect((await store.get('notes', 'n1'))!.title).toBe('server-wins')   // stamped-newer wins over unpushed local edit
    expect(await store.get('notes', 'n3')).toBeDefined()                   // fresh server row applied
    expect(r.newWatermark).toBe('2026-10-17T00:00:10Z')
    expect(await meta.getWatermark()).toBe('2026-10-17T00:00:10Z')
  })
  it('older incoming cannot overwrite stamped local (server-side newer edit already applied)', async () => {
    const { store, meta } = await mk()
    await store.applyRemote('notes', rem({ title: 'v2', updated_at: '2026-10-17T00:00:05Z' }))
    await applyRemoteRows(store, meta, 'notes', [rem({ title: 'v1-old', updated_at: '2026-10-17T00:00:01Z' })])
    expect((await store.get('notes', 'n1'))!.title).toBe('v2')
  })
  it('empty fetch does not move the watermark', async () => {
    const { store, meta } = await mk()
    await meta.setWatermark('2026-10-17T00:00:00Z')
    const r = await applyRemoteRows(store, meta, 'notes', [])
    expect(r.newWatermark).toBe('2026-10-17T00:00:00Z')
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/remoteApply.ts`:

```ts
import type { LocalStore } from './localStore'
import type { MetaStore } from './meta'
import { isoMax } from './conflict'
import type { RemoteRow } from './types'
export async function applyRemoteRows(
  store: LocalStore, meta: MetaStore, table: string, rows: RemoteRow[],
): Promise<{ applied: number; newWatermark: string }> {
  let max = await meta.getWatermark()
  for (const raw of rows) {
    const ua = raw.updated_at
    if (typeof ua === 'string') max = isoMax(max, ua)
  }
  await store.applyRemoteBulk(table, rows)
  await meta.setWatermark(max)
  return { applied: rows.length, newWatermark: max }
}
```

(Advance from the **fetched** rows' stamps even if an individual row lost conflict — the server timestamp is real regardless; otherwise the watermark would stall. This matches spec §5.3.)
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git add webapp/src/core/remoteApply.ts webapp/test/unit/remoteApply.spec.ts webapp/src/core/localStore.ts && git commit -m "feat(core): remote apply with watermark advancement"`

### Task 8: Outbox queue + exponential backoff

**Files:**
- Create: `webapp/src/core/outbox.ts`, `webapp/test/unit/outbox.spec.ts`

**Interfaces:**
- Consumes: `WbDb.outbox` (`OutboxEntry`, Task 2/3).
- Produces: `class Outbox` — `constructor(db: WbDb)`; `listReady(now: number, limit: number): Promise<OutboxEntry[]>` (unblocked + `nextAttemptAt <= now`, **ascending `seq`**); `markDone(seq: number): Promise<void>`; `markFailed(seq: number, error: string, retryInMs: number, now: number): Promise<void>` (attempts+1; `nextAttemptAt = now + retryInMs`); `markBlocked(seq: number, error: string): Promise<void>`; `count(): Promise<number>`; `earliestNextAttempt(now: number): Promise<number | null>` (soonest retry across unblocked entries); `tables(): Promise<string[]>` (distinct tables with pending entries — used for sync-state UI). Pure helper `backoffDelay(attempts: number, baseMs = 2000, maxMs = 300000): number` = `min(baseMs * 2^attempts, maxMs)`.

- [ ] **Step 1: Write failing test** `test/unit/outbox.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/outbox.ts`:

```ts
import type { WbDb } from './db'
import type { OutboxEntry } from './types'
export function backoffDelay(attempts: number, baseMs = 2000, maxMs = 300000): number {
  return Math.min(baseMs * 2 ** attempts, maxMs)
}
export class Outbox {
  constructor(private db: WbDb) {}
  async listReady(now: number, limit: number): Promise<OutboxEntry[]> {
    const all = await this.db.outbox.orderBy('seq').toArray()
    return all.filter(e => !e.blocked && e.nextAttemptAt <= now).slice(0, limit)
  }
  async markDone(seq: number): Promise<void> { await this.db.outbox.delete(seq) }
  async markFailed(seq: number, error: string, retryInMs: number, now: number): Promise<void> {
    const e = await this.db.outbox.get(seq); if (!e) return
    await this.db.outbox.put({ ...e, attempts: e.attempts + 1, nextAttemptAt: now + retryInMs, lastError: error })
  }
  async markBlocked(seq: number, error: string): Promise<void> {
    const e = await this.db.outbox.get(seq); if (!e) return
    await this.db.outbox.put({ ...e, blocked: true, lastError: error })
  }
  count(): Promise<number> { return this.db.outbox.count() }
  async earliestNextAttempt(now: number): Promise<number | null> {
    const all = (await this.db.outbox.toArray()).filter(e => !e.blocked)
    if (!all.length) return null
    return Math.min(...all.map(e => Math.max(e.nextAttemptAt, now + 50)))
  }
  async tables(): Promise<string[]> { return [...new Set((await this.db.outbox.toArray()).map(e => e.table))] }
}
```

- [ ] **Step 4: Run `npx vitest run test/unit/outbox.spec.ts`** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/outbox.ts webapp/test/unit/outbox.spec.ts && git commit -m "feat(core): ordered outbox queue with exponential backoff"`

### Task 9: SyncEngine push — ordered batches, 403 blocking, local-only mode

**Files:**
- Create: `webapp/src/core/syncEngine.ts`, `webapp/test/fakeGateway.ts`, `webapp/test/unit/syncEngine.push.spec.ts`

**Interfaces:**
- Consumes: `Outbox` (Task 8), `LocalStore` (Task 5), `toRemoteRow` (Task 2), `RemoteRow` (Task 2).
- Produces:
  - `interface RemoteGateway { upsertRows(table: string, rows: RemoteRow[]): Promise<void>; fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]>; subscribe(table: string, onRow: (row: RemoteRow) => void): () => void; uploadObject(path: string, blob: Blob): Promise<void> }`
  - `class PermissionDeniedError extends Error` (RLS 403) and `class RetryableError extends Error` — declared in `src/core/gateway.ts` (new file holding the interface + error classes; `syncEngine.ts` imports from it).
  - `interface SyncEngineDeps { store: LocalStore; outbox: Outbox; meta: MetaStore; gateway: RemoteGateway | null; ownerUid: () => string | null; now: () => number; setTimeoutFn: (fn: () => void, ms: number) => unknown; clearTimeoutFn: (h: unknown) => void }`, `interface SyncState { pending: number; lastError: string | null; running: boolean }` (emitted through the public `SyncEngine.onState` field).
  - `class SyncEngine` — `pushOnce(): Promise<number>` (returns rows pushed; **no-op when `gateway === null`** — local-only mode until credentials arrive), `start()`, `stop()`, `syncOnce(): Promise<void>` (pull + push, added Task 10), public field `onState: ((s: SyncState) => void) | null` used by the status UI (Task 14).

FakeGateway (`test/fakeGateway.ts`) — used by every gateway-touching test from here on:

```ts
import type { RemoteGateway } from '../src/core/gateway'
import type { RemoteRow } from '../src/core/types'
export class FakeGateway implements RemoteGateway {
  server = new Map<string, Map<string, RemoteRow>>()
  upsertCalls: { table: string; rows: RemoteRow[] }[] = []
  uploadCalls: { path: string; blob: Blob }[] = []
  failNextUpsert: Error | null = null
  clock = 0                                   // ms; each write stamps updated_at = ISO of clock
  private subs: ((table: string, row: RemoteRow) => void)[] = []
  private t(table: string) { if (!this.server.has(table)) this.server.set(table, new Map()); return this.server.get(table)! }
  async upsertRows(table: string, rows: RemoteRow[]): Promise<void> {
    if (this.failNextUpsert) { const e = this.failNextUpsert; this.failNextUpsert = null; throw e }
    this.clock += 1000
    this.upsertCalls.push({ table, rows })
    for (const r of rows) { this.t(table).set(String(r.id), { ...r, updated_at: new Date(this.clock).toISOString() })
      this.subs.forEach(cb => cb(table, { ...r, updated_at: new Date(this.clock).toISOString() })) }
  }
  async fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]> {
    return [...this.t(table).values()].filter(r => (r.updated_at as string) > watermark)
  }
  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void {
    const cb = (t: string, r: RemoteRow) => { if (t === table) onRow(r) }
    this.subs.push(cb); return () => { this.subs = this.subs.filter(x => x !== cb) }
  }
  async uploadObject(path: string, blob: Blob): Promise<void> {
    if (this.failNextUpsert) { const e = this.failNextUpsert; this.failNextUpsert = null; throw e }
    this.uploadCalls.push({ path, blob })
  }
}
```

- [ ] **Step 1: Write failing test** `test/unit/syncEngine.push.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import Dexie from 'dexie'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { Outbox } from '../../src/core/outbox'
import { SyncEngine } from '../../src/core/syncEngine'
import { PermissionDeniedError, RetryableError } from '../../src/core/gateway'
import { FakeGateway } from '../fakeGateway'
import type { Row } from '../../src/core/types'

async function mk(withGw = true) {
  const db = await openDb('sp-' + Math.random())
  db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({ db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  const outbox = new Outbox(db)
  const gateway = withGw ? new FakeGateway() : null
  let t = 0
  const timers: unknown[] = []
  const engine = new SyncEngine({ store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => t, setTimeoutFn: (fn) => { timers.push(fn); return timers.length }, clearTimeoutFn: () => {} })
  return { db, store, outbox, gateway, engine, runTimers: () => { const fns = timers.splice(0); fns.forEach(f => f()) }, advance: (ms: number) => { t += ms } }
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
    const m = await mk(); const { store, outbox, gateway, engine } = m
    await store.put('notes', { id: 'n1', title: 'a' })
    gateway!.failNextUpsert = new RetryableError('offline')
    expect(await engine.pushOnce()).toBe(0)
    expect(await outbox.count()).toBe(1)                                  // not dropped (spec §7)
    const before = gateway!.upsertCalls.length
    m.advance(5000); m.runTimers()
    await engine.pushOnce()
    expect(gateway!.upsertCalls.length).toBeGreaterThan(before)
    expect(await outbox.count()).toBe(0)
  })
  it('403 blocks the entry and surfaces the error (spec §7)', async () => {
    const m = await mk(); const { store, outbox, gateway, engine } = m
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
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/gateway.ts`:

```ts
import type { RemoteRow } from './types'
export class PermissionDeniedError extends Error {}
export class RetryableError extends Error {}
export interface RemoteGateway {
  upsertRows(table: string, rows: RemoteRow[]): Promise<void>
  fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]>
  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void
  uploadObject(path: string, blob: Blob): Promise<void>
}
```

`src/core/syncEngine.ts`:

```ts
import type { LocalStore } from './localStore'
import type { Outbox } from './outbox'
import { backoffDelay } from './outbox'
import type { MetaStore } from './meta'
import type { RemoteGateway } from './gateway'
import { PermissionDeniedError } from './gateway'
import { toRemoteRow } from './case'
import type { Row } from './types'
export interface SyncState { pending: number; lastError: string | null; running: boolean }
export interface SyncEngineDeps {
  store: LocalStore
  outbox: Outbox
  meta: MetaStore
  gateway: RemoteGateway | null
  ownerUid: () => string | null
  now: () => number
  setTimeoutFn: (fn: () => void, ms: number) => unknown
  clearTimeoutFn: (h: unknown) => void
}
const BATCH = 50
export class SyncEngine {
  onState: ((s: SyncState) => void) | null = null
  private lastError: string | null = null
  constructor(private d: SyncEngineDeps) {}
  private emit(): Promise<void> {
    return this.d.outbox.count().then(pending => { this.onState?.({ pending, lastError: this.lastError, running: false }) })
  }
  async pushOnce(): Promise<number> {
    if (!this.d.gateway) return 0                       // local-only mode (no credentials yet)
    const uid = this.d.ownerUid()
    if (!uid) return 0                                  // auth expired: keep queue (spec §7)
    const now = this.d.now()
    const ready = await this.d.outbox.listReady(now, BATCH)
    if (!ready.length) return 0
    let pushed = 0
    const byTable = new Map<string, typeof ready>()
    for (const e of ready) { const a = byTable.get(e.table) ?? []; a.push(e); byTable.set(e.table, a) }
    for (const [table, entries] of byTable) {
      const rows = entries.map(e => toRemoteRow(e.payload as Row, uid))
      try {
        await this.d.gateway.upsertRows(table, rows)
        for (const e of entries) await this.d.outbox.markDone(e.seq)
        pushed += entries.length
        this.lastError = null
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (err instanceof PermissionDeniedError) {
          for (const e of entries) await this.d.outbox.markBlocked(e.seq, msg)   // spec §7: stop retrying, surface
          this.lastError = `RLS 拒绝（疑似程序缺陷）：${table} — ${msg}`
        } else {
          for (const e of entries) {
            const delay = backoffDelay(e.attempts)
            await this.d.outbox.markFailed(e.seq, msg, delay, this.d.now())
          }
          this.lastError = msg
          this.scheduleRetry()
        }
      }
    }
    await this.emit()
    return pushed
  }
  private scheduleRetry(): void {
    void this.d.outbox.earliestNextAttempt(this.d.now()).then(next => {
      if (next === null) return
      this.d.setTimeoutFn(() => { void this.pushOnce() }, Math.max(0, next - this.d.now()))
    })
  }
  start(): void { void this.pushOnce() }                // pull/realtime added in Task 10
  stop(): void {}
}
```

- [ ] **Step 4: Run `npx vitest run test/unit/syncEngine.push.spec.ts`** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/gateway.ts webapp/src/core/syncEngine.ts webapp/test/fakeGateway.ts webapp/test/unit/syncEngine.push.spec.ts && git commit -m "feat(core): sync engine push with backoff and RLS-403 hard-stop"`

### Task 10: SyncEngine pull — catch-up + realtime + wake triggers

**Files:**
- Modify: `webapp/src/core/syncEngine.ts` (fill `start()`/`sync()`), `webapp/test/unit/syncEngine.pull.spec.ts` (new)

**Interfaces:**
- Consumes: `RemoteGateway.fetchUpdatedSince/subscribe` (Task 9), `applyRemoteRows` (Task 7), `MetaStore.getWatermark` (Task 3), `schema.tableNames()` (Task 6).
- Produces: `syncOnce(): Promise<void>` (pull all registered tables then push), `start()` also registers realtime subscriptions for every registered table; wake triggers (`online` event, `visibilitychange`/`focus`, and a periodic `pullTimer`) run **only when `typeof window !== 'undefined'`** so tests stay deterministic; `stop()` unsubscribes and clears timers.

- [ ] **Step 1: Write failing test** `test/unit/syncEngine.pull.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { Outbox } from '../../src/core/outbox'
import { SyncEngine } from '../../src/core/syncEngine'
import { FakeGateway } from '../fakeGateway'
import type { Row } from '../../src/core/types'

async function mk() {
  const db = await openDb('spl-' + Math.random())
  db.registerTable('notes')
  const meta = new MetaStore(db)
  const store = new LocalStore({ db, meta, deviceId: 'dev-A', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  const gateway = new FakeGateway()
  const engine = new SyncEngine({ store, outbox: new Outbox(db), meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {} })
  return { db, meta, store, gateway, engine }
}

describe('SyncEngine pull (spec §5.3)', () => {
  it('catch-up pull applies remote rows and advances watermark', async () => {
    const { store, meta, gateway, engine } = await mk()
    await gateway.upsertRows('notes', [{ id: 'n1', owner_id: 'u-1', seq: 1, device_id: 'dev-B' }])
    await engine.syncOnce()
    expect(await store.get('notes', 'n1')).toBeTruthy()
    const wm = await meta.getWatermark()
    expect(wm).toBe(await gateway.fetchUpdatedSince('notes', '1970-01-01T00:00:00.000Z').then(r => r[0].updated_at))
    await engine.syncOnce()                              // idempotent second pass
    expect(await store.get('notes', 'n1')).toBeTruthy()
  })
  it('realtime event lands in LocalStore without manual sync', async () => {
    const { store, gateway, engine } = await mk()
    engine.start()
    await gateway.upsertRows('notes', [{ id: 'rt1', owner_id: 'u-1', seq: 1, device_id: 'dev-B', title: 'live' }])
    await Promise.resolve()                              // let async subscribe handler run
    const got = await store.get('notes', 'rt1')
    expect(got?.title).toBe('live')
    engine.stop()
  })
  it('watermark makes a second fetch return nothing new', async () => {
    const { meta, gateway, engine } = await mk()
    await gateway.upsertRows('notes', [{ id: 'n1', owner_id: 'u-1', seq: 1, device_id: 'dev-B' }])
    await engine.syncOnce()
    const wm = await meta.getWatermark()
    expect(await gateway.fetchUpdatedSince('notes', wm)).toEqual([])
  })
})
```

- [ ] **Step 2: Run → FAIL** (`syncOnce` missing).
- [ ] **Step 3: Extend** `src/core/syncEngine.ts`:

```ts
import { applyRemoteRows } from './remoteApply'
import { tableNames } from './schema'
// add fields inside class SyncEngine:
  private unsubs: (() => void)[] = []
  private timers: Record<string, unknown> = {}
  async syncOnce(): Promise<void> {
    await this.pullOnce()
    await this.pushOnce()
  }
  async pullOnce(): Promise<void> {
    const gw = this.d.gateway
    if (!gw) return
    const wm = await this.d.meta.getWatermark()
    for (const table of tableNames()) {
      const rows = await gw.fetchUpdatedSince(table, wm)
      await applyRemoteRows(this.d.store, this.d.meta, table, rows)
    }
  }
  private subscribeAll(): void {
    const gw = this.d.gateway
    if (!gw) return
    for (const table of tableNames()) {
      this.unsubs.push(gw.subscribe(table, row => {
        void applyRemoteRows(this.d.store, this.d.meta, table, [row]).then(() => this.emit())
      }))
    }
  }
  private running = false
  private wake: (() => void) | null = null
  start(): void {
    if (this.running) return
    this.running = true
    this.subscribeAll()
    if (typeof window !== 'undefined') {
      this.wake = () => { void this.syncOnce() }
      window.addEventListener('online', this.wake)
      window.addEventListener('focus', this.wake)
      document.addEventListener('visibilitychange', this.wake)
      void this.syncOnce()                                    // startup catch-up (spec §5.3)
      this.armPeriodic()
    } else {
      void this.pushOnce()
    }
  }
  private armPeriodic(): void {
    if (!this.running) return
    this.timers.periodic = this.d.setTimeoutFn(() => { void this.pullOnce().then(() => this.armPeriodic()) }, 60000)
  }
  stop(): void {
    this.running = false
    this.unsubs.forEach(u => u()); this.unsubs = []
    Object.values(this.timers).forEach(h => this.d.clearTimeoutFn(h)); this.timers = {}
    if (typeof window !== 'undefined' && this.wake) {
      window.removeEventListener('online', this.wake)
      window.removeEventListener('focus', this.wake)
      document.removeEventListener('visibilitychange', this.wake)
      this.wake = null
    }
  }
```

Behavior contract (what the tests in Step 1 verify): after `start()`, gateway emissions reach LocalStore; `syncOnce()` = pull-then-push; `pullOnce()` no-ops without a gateway; nothing touches `window` in the vitest node environment (the `typeof window` guard), so the tests call `start()` for subscriptions only.

- [ ] **Step 4: Run `npx vitest run test/unit/syncEngine.pull.spec.ts` and the full suite** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/syncEngine.ts webapp/test/unit/syncEngine.pull.spec.ts && git commit -m "feat(core): catch-up pull, realtime subscription, wake triggers"`

### Task 11: Supabase client, auth wrapper, real gateway adapter (env-gated; live checks 🚫CRED)

**Files:**
- Create: `webapp/src/core/supabaseClient.ts`, `webapp/src/core/auth.ts`, `webapp/src/core/supabaseGateway.ts`, `webapp/test/unit/auth.spec.ts`
- Modify: `webapp/vitest.config.ts` (node 20 has global `fetch`; no config change needed — verify only)

**Interfaces:**
- Consumes: `RemoteGateway` (Task 9), `toRemoteRow`/`fromRemoteRow` (Task 2).
- Produces:
  - `createSupabaseClient(): SupabaseClient | null` — `null` when `import.meta.env.VITE_SUPABASE_URL` or `VITE_SUPABASE_ANON_KEY` missing. **This is the credential gate: everything downstream accepts `null` and runs local-only.**
  - `class Auth` — `constructor(sb: SupabaseClient | null)`; `currentUid(): string | null`; `onChange(cb: (uid: string | null) => void): () => void`; `static local(uid: string): Auth` (fake for tests); `signIn(email, password)`, `signOut()` throw a clear `'未配置 Supabase 凭据'` error when `sb === null`.
  - `class SupabaseGateway implements RemoteGateway` — `constructor(sb: SupabaseClient, bucket: string)`; `upsertRows` maps PostgREST `status 403 / code 42501` errors to `PermissionDeniedError`, everything else to `RetryableError`; `fetchUpdatedSince` uses `.gte('updated_at', watermark).limit(500)`; `subscribe` uses `sb.channel(...).on('postgres_changes', { event: '*', schema: 'public', table }, ...)`; `uploadObject` uses `sb.storage.from(bucket).upload(path, blob, { upsert: true })`.

- [ ] **Step 1: Write failing test** `test/unit/auth.spec.ts` (no network, no instance):

```ts
import { describe, it, expect } from 'vitest'
import { createSupabaseClient } from '../../src/core/supabaseClient'
import { Auth } from '../../src/core/auth'
describe('credential gating (spec §2.1 env-only config)', () => {
  it('returns null client when env vars are absent — app still boots local-only', () => {
    expect(createSupabaseClient()).toBeNull()            // .env not present in CI/tests
  })
  it('local Auth always has the seeded uid and never throws', async () => {
    const a = Auth.local('uid-local')
    expect(a.currentUid()).toBe('uid-local')
    await expect(a.signIn('x', 'y')).rejects.toThrow('未配置')
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the three modules. `supabaseClient.ts`:

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
export function createSupabaseClient(): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key)
}
export function bucketName(): string { return import.meta.env.VITE_SUPABASE_BUCKET || 'album' }
```

`auth.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
export class Auth {
  private uid: string | null = null
  private cbs = new Set<(uid: string | null) => void>()
  private constructor(private sb: SupabaseClient | null, uid: string | null) { this.uid = uid }
  static local(uid: string): Auth { return new Auth(null, uid) }
  static async remote(sb: SupabaseClient): Promise<Auth> {
    const a = new Auth(sb, null)
    const { data } = await sb.auth.getSession()
    a.set(data.session?.user.id ?? null)
    sb.auth.onAuthStateChange((_e, s) => a.set(s?.user.id ?? null))
    return a
  }
  private set(uid: string | null) { this.uid = uid; this.cbs.forEach(cb => cb(uid)) }
  currentUid(): string | null { return this.uid }
  onChange(cb: (uid: string | null) => void): () => void { this.cbs.add(cb); return () => this.cbs.delete(cb) }
  async signIn(email: string, password: string): Promise<void> {
    if (!this.sb) throw new Error('未配置 Supabase 凭据（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
    const { error } = await this.sb.auth.signInWithPassword({ email, password })
    if (error) throw error
  }
  async signOut(): Promise<void> { await this.sb?.auth.signOut() }
}
```

`supabaseGateway.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { RemoteGateway } from './gateway'
import { PermissionDeniedError, RetryableError } from './gateway'
import type { RemoteRow } from './types'
function wrap(err: { code?: string; status?: number } | null, ctx: string): Error {
  if (!err) return new RetryableError(ctx)
  if (err.status === 403 || err.code === '42501') return new PermissionDeniedError(`${ctx}: RLS 拒绝 (${err.code ?? err.status})`)
  return new RetryableError(`${ctx}: ${err.message ?? JSON.stringify(err)}`)
}
export class SupabaseGateway implements RemoteGateway {
  constructor(private sb: SupabaseClient, private bucket: string) {}
  async upsertRows(table: string, rows: RemoteRow[]): Promise<void> {
    const { error } = await this.sb.from(table).upsert(rows, { onConflict: 'id' })
    if (error) throw wrap(error as never, `upsert ${table}`)
  }
  async fetchUpdatedSince(table: string, watermark: string): Promise<RemoteRow[]> {
    const { data, error } = await this.sb.from(table).select('*').gt('updated_at', watermark).limit(500)
    if (error) throw wrap(error as never, `fetch ${table}`)
    return (data ?? []) as RemoteRow[]
  }
  subscribe(table: string, onRow: (row: RemoteRow) => void): () => void {
    const ch = this.sb.channel('rt-' + table)
      .on('postgres_changes', { event: '*', schema: 'public', table }, p => onRow(p.new as RemoteRow))
      .subscribe()
    return () => { void this.sb.removeChannel(ch) }
  }
  async uploadObject(path: string, blob: Blob): Promise<void> {
    const { error } = await this.sb.storage.from(this.bucket).upload(path, blob, { upsert: true })
    if (error) throw wrap(error as never, `upload ${path}`)
  }
}
```

- [ ] **Step 4: Run `npx vitest run test/unit/auth.spec.ts` + full suite** → PASS.
- [ ] **Step 5: 🚫CRED live smoke (deferred).** With credentials in `webapp/.env`: create a test teacher account, `Auth.remote` returns a uid, one manual `upsertRows` against a scratch table lands, `PermissionDeniedError` fires for a row with a foreign `owner_id`. Record results in the task commit message.
- [ ] **Step 6: Commit.** `git add webapp/src/core webapp/test/unit/auth.spec.ts && git commit -m "feat(core): env-gated supabase client, auth wrapper, gateway adapter"`

### Task 12: Image pipeline — offline-first blob store + queued Storage uploads (criterion 4)

**Files:**
- Create: `webapp/src/core/images.ts`, `webapp/test/unit/images.spec.ts`
- Modify: `webapp/src/core/syncEngine.ts` (route `upload_image` entries in `pushOnce`), `webapp/test/unit/syncEngine.push.spec.ts` (add passthrough assertion)

**Interfaces:**
- Consumes: `WbDb.images` + `ImageRecord` (Task 3), `MetaStore.nextSeq` (Task 3), `Outbox` (Task 8), `RemoteGateway.uploadObject` (Task 9).
- Produces:
  - `objectPathFor(imageId: string): string` = `` `albums/${imageId}` `` (bucket name stays in the gateway, never in the row — spec §2.1).
  - `class ImageStore` — `constructor(db: WbDb, meta: MetaStore, deviceId: string, ownerUid: () => string | null)`; `addLocal(imageId: string, blob: Blob): Promise<void>` (one tx: `images.put({ id, blob, ownerId, objectPath, uploaded: false })` + outbox `op:'upload_image'` entry with payload `{ imageId, objectPath, seq, deviceId }`); `getBlob(imageId): Promise<Blob | undefined>`; `isUploaded(imageId): Promise<boolean>`.
  - `quotaNag(thresholdBytes?: number): Promise<string | null>` — spec §7 last row ("存储配额逼近 → 主动提示清理相册原图"): reads `navigator.storage.estimate()`, returns the message `'存储空间接近上限，建议清理相册原图'` when `usage > min(quota * 0.8, thresholdBytes ?? 256MB)`; returns `null` where the API is absent (tests run in node). Called by `StatusBanner.vue` (Task 17) on every state emission — proactive, not after a failed write.
  - `dataUrlToBlob(dataUrl: string): Blob` — pure string decode (no canvas), works in browser and Node.
- Semantics to preserve (spec §5.5): viewing always reads the local blob; the DB row later stores only `objectPath`/`imageId` — this task never puts bytes in a business row. Because the upload entry takes a `seq` at add time, any business row referencing it written afterwards has a higher `seq` and therefore pushes later — the object exists before the row that points at it.

- [ ] **Step 1: Write failing test** `test/unit/images.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { openDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { Outbox } from '../../src/core/outbox'
import { ImageStore, dataUrlToBlob, objectPathFor, quotaNag } from '../../src/core/images'
import { SyncEngine } from '../../src/core/syncEngine'
import { LocalStore } from '../../src/core/localStore'
import { FakeGateway } from '../fakeGateway'
import type { Table } from 'dexie'
import type { Row } from '../../src/core/types'

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

async function mk(withGw: boolean) {
  const db = await openDb('img-' + Math.random())
  db.registerTable('notes')
  const meta = new MetaStore(db)
  const outbox = new Outbox(db)
  const store = new LocalStore({ db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  const images = new ImageStore(db, meta, 'dA', () => 'u-1')
  const gateway = withGw ? new FakeGateway() : null
  const engine = new SyncEngine({ store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {} })
  return { db, meta, outbox, store, images, gateway, engine }
}

describe('image pipeline (spec §5.5)', () => {
  it('dataUrlToBlob decodes without canvas', async () => {
    const b = dataUrlToBlob(PNG_1PX)
    expect(b.size).toBeGreaterThan(50)
    expect(b.type).toBe('image/png')
  })
  it('offline: add succeeds, blob readable, upload queued', async () => {
    const { images, outbox } = await mk(false)
    await images.addLocal('img-1', dataUrlToBlob(PNG_1PX))
    const back = await images.getBlob('img-1')
    expect(back!.size).toBeGreaterThan(50)
    expect(await images.isUploaded('img-1')).toBe(false)
    const ready = await outbox.listReady(0, 10)
    expect(ready[0].op).toBe('upload_image')
    expect((ready[0].payload as Record<string, unknown>).objectPath).toBe(objectPathFor('img-1'))
  })
  it('online: push uploads object, marks uploaded, drains queue; bytes never in upsert payloads', async () => {
    const m = await mk(true); const { images, outbox, store, gateway, engine } = m
    await images.addLocal('img-1', dataUrlToBlob(PNG_1PX))
    await store.put('notes', { id: 'n1', imageIds: ['img-1'] })   // referencing row takes a later seq
    expect(await engine.pushOnce()).toBe(2)
    expect(gateway!.uploadCalls[0].path).toBe(objectPathFor('img-1'))
    expect(await images.isUploaded('img-1')).toBe(true)
    expect(await outbox.count()).toBe(0)
    const rowUpsert = gateway!.upsertCalls[0].rows[0]
    expect(JSON.stringify(rowUpsert)).not.toContain('iVBOR')       // no base64 in the row (spec §5.5)
    // upload ordering: images table upload precedes the row referencing it
    expect(gateway!.uploadCalls.length).toBe(1)
    void m
  })
  it('upload failure keeps the entry queued (no silent loss)', async () => {
    const m = await mk(true); const { images, outbox, engine } = m
    await images.addLocal('img-2', dataUrlToBlob(PNG_1PX))
    m.gateway!.failNextUpsert = new Error('storage down')
    await engine.pushOnce()
    expect(await outbox.count()).toBe(1)
    expect(await images.isUploaded('img-2')).toBe(false)
  })
  it('quotaNag is inert without the storage API and never throws', async () => {
    expect(await quotaNag()).toBeNull()                    // node/vitest: no navigator.storage
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/images.ts` (append the `quotaNag` function shown in Interfaces to this module):

```ts
import type { WbDb, ImageRecord } from './db'
import type { MetaStore } from './meta'
export function objectPathFor(imageId: string): string { return `albums/${imageId}` }
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(',')
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? 'application/octet-stream'
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
export class ImageStore {
  constructor(private db: WbDb, private meta: MetaStore, private deviceId: string, private ownerUid: () => string | null) {}
  async addLocal(imageId: string, blob: Blob): Promise<void> {
    const objectPath = objectPathFor(imageId)
    await this.db.transaction('rw', this.db.images, this.db.outbox, this.db.syncMeta, async () => {
      const seq = await this.meta.nextSeq()
      const rec: ImageRecord = { id: imageId, blob, ownerId: this.ownerUid(), objectPath, uploaded: false }
      await this.db.images.put(rec)
      await this.db.outbox.put({ seq, table: '__image__', recordId: imageId, op: 'upload_image',
        payload: { imageId, objectPath, seq, deviceId: this.deviceId }, attempts: 0, nextAttemptAt: 0, blocked: false })
    })
  }
  async getBlob(imageId: string): Promise<Blob | undefined> { return (await this.db.images.get(imageId))?.blob }
  async isUploaded(imageId: string): Promise<boolean> { return !!(await this.db.images.get(imageId))?.uploaded }
}
export async function quotaNag(thresholdBytes = 256 * 1024 * 1024): Promise<string | null> {
  const storage = (globalThis.navigator as { storage?: { estimate?(): Promise<{ usage?: number; quota?: number }> } } | undefined)?.storage
  if (!storage?.estimate) return null                      // absent in node/vitest, present in Chromium browsers
  const { usage = 0, quota = Number.POSITIVE_INFINITY } = await storage.estimate()
  return usage > Math.min(quota * 0.8, thresholdBytes) ? '存储空间接近上限，建议清理相册原图' : null
}
```

- [ ] **Step 4: Modify `syncEngine.ts`.** Add to `SyncEngineDeps`:

```ts
  images: { getBlob(id: string): Promise<Blob | undefined>; markUploaded(id: string): Promise<void> } | null
```

Then in `pushOnce`, move `let pushed = 0` to just after the `listReady` line and insert the upload stream there; the existing `byTable` grouping then iterates `rest` instead of `ready`:

```ts
    const uploads = ready.filter(e => e.op === 'upload_image')
    const rest = ready.filter(e => e.op !== 'upload_image')
    let pushed = 0
    for (const e of uploads) {
      const p = e.payload as { imageId: string; objectPath: string }
      if (!this.d.images) { await this.d.outbox.markFailed(e.seq, 'no image store', backoffDelay(e.attempts), this.d.now()); continue }
      const blob = await this.d.images.getBlob(p.imageId)
      try {
        if (!blob) throw new PermissionDeniedError('local blob missing for ' + p.imageId) // unrecoverable → blocked + surfaced (spec §7)
        await this.d.gateway.uploadObject(p.objectPath, blob)
        await this.d.images.markUploaded(p.imageId)
        await this.d.outbox.markDone(e.seq)
        pushed++
        this.lastError = null
      } catch (err) {
        if (err instanceof PermissionDeniedError) { await this.d.outbox.markBlocked(e.seq, String(err)); this.lastError = String(err) }
        else { await this.d.outbox.markFailed(e.seq, String(err), backoffDelay(e.attempts), this.d.now()); this.scheduleRetry() }
      }
    }
```

Finally, update the two existing test helpers: in `test/unit/images.spec.ts` pass `images: { getBlob: (id: string) => db.images.get(id).then(r => r?.blob), markUploaded: async (id: string) => { await db.images.update(id, { uploaded: true }) } }` into the `SyncEngine` deps; in `test/unit/syncEngine.push.spec.ts` add `images: null` to its deps object.

- [ ] **Step 5: Run images spec + push spec + full suite** → PASS (`npm run test`).
- [ ] **Step 6: 🚫CRED live check (deferred).** With credentials: one photo added offline → after reconnect, object visible in Storage bucket `album`, row contains only the path, another device can view it after its local blob cache fills from a pull + blob fetch (later subproject UI).
- [ ] **Step 7: Commit.** `git add webapp/src/core/images.ts webapp/src/core/syncEngine.ts webapp/test/unit/images.spec.ts webapp/test/unit/syncEngine.push.spec.ts && git commit -m "feat(core): offline-first blob store with queued storage uploads"`

### Task 13: Repository layer — the only door business code will use

**Files:**
- Create: `webapp/src/core/repository.ts`, `webapp/test/unit/repository.spec.ts`

**Interfaces:**
- Consumes: `LocalStore` (Task 5), `ImageStore` (Task 12), `tableDef` (Task 6).
- Produces: `class Repository<T extends Record<string, unknown>>` — `constructor(table: string, store: LocalStore, images: ImageStore)`; `create(fields: T): Promise<Row>` (id = `crypto.randomUUID()`), `update(id: string, patch: Partial<T>): Promise<Row>`, `remove(id: string): Promise<void>` (soft), `get(id): Promise<Row | undefined>`, `list(): Promise<Row[]>`; `attachImage(recordId: string, field: string, blob: Blob): Promise<{ imageId: string; objectPath: string }>` — adds blob locally (queued upload, Task 12) and merges `{ [field]: objectPath }` into the row via `update`. Business components never import Dexie or Supabase (spec §3 boundary; this is the door subprojects 2–4 will walk through).

- [ ] **Step 1: Write failing test** `test/unit/repository.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import Dexie from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { ImageStore } from '../../src/core/images'
import { Repository } from '../../src/core/repository'
import type { Row } from '../../src/core/types'

let db: WbDb, repo: Repository<{ name: string; group?: number }>
beforeEach(async () => {
  db = await openDb('repo-' + Math.random())
  db.registerTable('students')
  const meta = new MetaStore(db)
  const store = new LocalStore({ db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  const images = new ImageStore(db, meta, 'dA', () => 'u-1')
  repo = new Repository('students', store, images)
})

describe('Repository', () => {
  it('create → uuid id, row in store, outbox entry queued', async () => {
    const r = await repo.create({ name: '小明', group: 3 })
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(await repo.get(r.id)).toMatchObject({ name: '小明' })
    expect(await db.outbox.count()).toBe(1)
  })
  it('update merges patch, remove soft-deletes and disappears from list', async () => {
    const r = await repo.create({ name: 'a' })
    await repo.update(r.id, { name: 'b' })
    expect((await repo.get(r.id))!.name).toBe('b')
    await repo.remove(r.id)
    expect(await repo.list()).toEqual([])
    expect((await repo.get(r.id))!.deletedAt).not.toBeNull()
    const ops = (await db.outbox.toArray()).map(e => e.op)
    expect(ops).toEqual(['upsert', 'upsert', 'delete'])
  })
  it('attachImage: blob stored, row holds objectPath only', async () => {
    const r = await repo.create({ name: 'a' })
    const blob = new Blob(['x'], { type: 'image/png' })
    const { objectPath } = await repo.attachImage(r.id, 'photoPath', blob)
    expect(objectPath).toMatch(/^albums\//)
    expect((await repo.get(r.id))!.photoPath).toBe(objectPath)
    const s = JSON.stringify(await repo.get(r.id))
    expect(s).not.toContain('albums/' + r.id)     // path is image-derived, not record-derived
    const blobs = await db.images.toArray()
    expect(blobs[0].blob.size).toBe(1)
  })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `src/core/repository.ts`:

```ts
import { randomUUID } from 'crypto'   // NOT needed: use globalThis.crypto.randomUUID()
import type { LocalStore } from './localStore'
import type { ImageStore } from './images'
import type { Row } from './types'
export class Repository<T extends Record<string, unknown>> {
  constructor(private table: string, private store: LocalStore, private images: ImageStore) {}
  create(fields: T): Promise<Row> { return this.store.put(this.table, { ...fields, id: crypto.randomUUID() } as T & { id: string }) }
  update(id: string, patch: Partial<T>): Promise<Row> { return this.store.put(this.table, { ...patch, id } as T & { id: string }) }
  remove(id: string): Promise<void> { return this.store.softDelete(this.table, id) }
  get(id: string): Promise<Row | undefined> { return this.store.get(this.table, id) }
  list(): Promise<Row[]> { return this.store.live(this.table) }
  async attachImage(recordId: string, field: string, blob: Blob): Promise<{ imageId: string; objectPath: string }> {
    const imageId = crypto.randomUUID()
    await this.images.addLocal(imageId, blob)
    const objectPath = `albums/${imageId}`
    await this.update(recordId, { [field]: objectPath } as Partial<T>)
    return { imageId, objectPath }
  }
}
```

(Delete the first import line — it is wrong; the global `crypto.randomUUID()` is available in browsers and Node ≥ 19. `attachImage` may import `objectPathFor` from `./images` instead of duplicating the template — do that, keeping one definition of the path convention.)

- [ ] **Step 4: Run `npx vitest run test/unit/repository.spec.ts`** → PASS.
- [ ] **Step 5: Commit.** `git add webapp/src/core/repository.ts webapp/test/unit/repository.spec.ts && git commit -m "feat(core): repository facade — the only door for business modules"`

### Task 14: Migration channel — schema-driven, idempotent, backup-first (criterion 5)

**Files:**
- Create: `webapp/src/core/migration.ts`, `webapp/test/unit/migration.spec.ts`, `webapp/test/fixtures/wb_tw_data.sample.json`

**Interfaces:**
- Consumes: `LocalStore` (Task 5), `MetaStore` (Task 3), `ImageStore` (Task 12), `TABLE_DEFS` + `coveredLegacyKeys()` + `JSON_FK_MAPS` (Task 6), `dataUrlToBlob` (Task 12).
- Produces:
  - `deriveUuid(legacyKey: string, legacyId: string): Promise<string>` — deterministic uuid from SHA-1 of `` `ella-legacy:${legacyKey}:${legacyId}` `` (RFC-4122-shaped, version nibble `5`, variant nibble `8|9|a|b`). Determinism is what makes re-import idempotent (spec §6).
  - `runMigration(deps: { db: WbDb; store: LocalStore; meta: MetaStore; images: ImageStore; ownerUid: () => string | null; json: unknown }): Promise<MigrationReport>`.
  - `interface MigrationReport { backupSaved: boolean; perTable: Record<string, number>; unmappedFields: string[]; skipped: { table: string; reason: string }[] }`.
  - `migrationDone(db: WbDb): Promise<boolean>` / `markMigrationDone(db: WbDb): Promise<void>` (syncMeta key `migrated`; gates the one-shot UI entry).
- Behavior contract:
  - Iterates `TABLE_DEFS` (defs carrying `legacyKey`) — never a hand-written key list, so `exams` cannot be forgotten (spec §6).
  - Backup first: stores the full raw JSON in syncMeta under `backup:legacy-wb_tw_data` before any row write; refuses to run twice unless `{ force: true }` (spec §6 "迁移前做完整 JSON 导出备份并保留").
  - Unknown legacy fields: copied onto the row **and** listed in `unmappedFields` (report, don't silently drop — the report is what would have caught the original `exams` bug class).
  - `dropColumns` (e.g. `idCard`) excluded from rows; they survive only in the backup. `photoColumn` / `imageColumns` decoded from dataURL to blob store with queued upload; the row keeps `photoPath` / `imagePaths` arrays (both are declared columns of the defs — DDL stays in sync).
  - `parentName`/`parentPhone` legacy aliases fold into `guardian1Name`/`guardian1Phone` when those are empty (mirroring `index.html:90`), then are dropped — they never become columns (spec §6).
  - `singleton` defs (seating, settings) → one fixed row per object with deterministic id `deriveUuid(def.name, 'singleton')` and the object's fields spread in.
  - FK remap: values of `fkColumns` and keys of `JSON_FK_MAPS` columns replaced by `deriveUuid('students', oldId)`; students themselves keep `id = deriveUuid('students', s.id)` so the remap needs no pre-pass ordering.
  - Writes go through `LocalStore.put` → each row simultaneously lands in the outbox → normal sync pushes them once credentials arrive (spec §6 "随后由正常同步推送"). Idempotency: re-running with the same JSON upserts identical ids; test asserts row counts unchanged.

- [ ] **Step 1: Create fixture** `test/fixtures/wb_tw_data.sample.json` (shapes mirror `index.html:84` + the push sites at 159/161/172/176/183/197/199/392/574/582/869/936):

```json
{
  "students": [
    { "id": "m3abc01", "name": "张三", "studentNo": "01", "gender": "男", "idCard": "11010120100101001X",
      "primarySchool": "一小", "address": "某路1号", "guardian1Name": "张父", "guardian1Phone": "13800000001",
      "guardian2Name": "张母", "guardian2Phone": "13800000002", "group": 1, "tags": ["学优生"], "notes": "",
      "photo": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
    { "id": "m3abc02", "name": "李四", "studentNo": "02", "gender": "女", "idCard": "",
      "primarySchool": "", "address": "", "guardian1Name": "", "guardian1Phone": "",
      "guardian2Name": "", "guardian2Phone": "", "group": 2, "tags": [], "notes": "", "parentName": "李父", "parentPhone": "13900000002" }
  ],
  "todos": [ { "id": "t1", "title": "交表", "content": "", "deadline": "2026-10-20", "priority": "high", "category": "通知", "completed": false } ],
  "schedule": [ { "id": "sc1", "day": 1, "period": 1, "subject": "语文", "class": "一班", "weekType": "both" } ],
  "seating": { "rows": 5, "cols": 6, "seats": [ { "r": 0, "c": 0, "studentId": "m3abc01" } ] },
  "duty": [ { "id": "d1", "week": "2026-W42", "group": 1, "tasks": [ { "position": "扫地", "assigneeId": "m3abc01", "completed": false } ] } ],
  "violations": [ { "id": "v1", "studentId": "m3abc01", "date": "2026-10-19", "event": "迟到", "action": "提醒" } ],
  "communications": [ { "id": "c1", "studentId": "m3abc02", "date": "2026-10-19", "method": "电话", "content": "反馈", "followUp": "" } ],
  "grades": [ { "id": "g1", "examName": "期中", "subject": "语文", "date": "2026-10-19", "scores": { "m3abc01": 95 } } ],
  "exams": [
    { "id": "e1", "name": "期中考试", "date": "2026-10-19", "subjects": ["语文"], "students": [ { "id": "m3abc01", "total": 95 } ], "stats": { "avg": 95 } },
    { "id": "e2", "name": "月考", "date": "2026-10-01", "subjects": ["语文", "数学"], "students": [], "stats": null }
  ],
  "homework": [ { "id": "h1", "date": "2026-10-19", "subject": "语文", "title": "背诵", "records": { "m3abc01": { "status": "completed" } } } ],
  "points": [ { "id": "p1", "studentId": "m3abc01", "points": 1, "type": "add", "reason": "值日", "date": "2026-10-19" } ],
  "drafts": { "notices": [ { "id": "dn1", "title": "放假", "content": "通知", "date": "2026-10-19" } ], "comments": [] },
  "activities": [ { "id": "a1", "title": "运动会", "date": "2026-10-19", "content": "", "images": ["data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="] } ],
  "behaviors": [ { "id": "b1", "studentId": "m3abc01", "date": "2026-10-19", "type": "good", "level": 1, "title": "助人", "description": "", "images": [] } ],
  "committee": [ { "id": "cm1", "studentId": "m3abc02", "position": "班长" } ],
  "settings": { "subjects": ["语文"], "mySubjects": ["语文"], "tags": ["学优生"], "dutyPositions": ["扫地"], "weekType": "single" }
}
```

- [ ] **Step 2: Write failing test** `test/unit/migration.spec.ts` (add `"resolveJsonModule": true` to `tsconfig.json` compilerOptions first so the fixture import typechecks):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import type { Table } from 'dexie'
import Dexie from 'dexie'
import { openDb, type WbDb } from '../../src/core/db'
import { MetaStore } from '../../src/core/meta'
import { LocalStore } from '../../src/core/localStore'
import { ImageStore } from '../../src/core/images'
import { registerAllTables, TABLE_DEFS } from '../../src/core/schema'
import { runMigration, deriveUuid, migrationDone, markMigrationDone } from '../../src/core/migration'
import type { Row } from '../../src/core/types'
import sample from '../fixtures/wb_tw_data.sample.json'

let db: WbDb, store: LocalStore, meta: MetaStore, images: ImageStore, deps: any
beforeEach(async () => {
  db = await openDb('mig-' + Math.random())
  registerAllTables(db)
  meta = new MetaStore(db)
  store = new LocalStore({ db, meta, deviceId: 'dA', ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  images = new ImageStore(db, meta, 'dA', () => 'u-1')
  deps = { db, store, meta, images, ownerUid: () => 'u-1', json: sample }
})

describe('deriveUuid', () => {
  it('deterministic uuid shape', async () => {
    const a = await deriveUuid('students', 'm3abc01')
    expect(a).toBe(await deriveUuid('students', 'm3abc01'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a).not.toBe(await deriveUuid('todos', 'm3abc01'))
  })
})

describe('runMigration (spec §6)', () => {
  it('imports every legacy table with exact row counts — exams included (criterion 5)', async () => {
    const report = await runMigration(deps)
    expect(report.backupSaved).toBe(true)
    expect(report.unmappedFields).toEqual([])
    expect(report.perTable.exams).toBe(2)
    expect(report.perTable.students).toBe(2)
    expect(report.perTable.todos).toBe(1)
    expect(report.perTable.notices).toBe(1)
    expect(report.perTable.comments).toBe(0)
    expect(report.perTable.settings).toBe(1)
    // structural completeness: every registered legacy table produced a perTable entry
    for (const d of TABLE_DEFS.filter(t => t.legacyKey)) expect(d.name in report.perTable, 'missing perTable for ' + d.name).toBe(true)
  })
  it('field-by-field: students keep all mapped fields, drop idCard, map parentPhone→guardian1Phone, photo→blob path', async () => {
    await runMigration(deps)
    const students = await store.live('students')
    const zs = students.find(s => s.name === '张三')!
    expect(zs.studentNo).toBe('01')
    expect(zs.guardian1Phone).toBe('13800000001')
    expect((zs as Record<string, unknown>).idCard).toBeUndefined()
    expect(zs.photoPath).toMatch(/^albums\//)
    const ls = students.find(s => s.name === '李四')!
    expect(ls.guardian1Phone).toBe('13900000002')          // legacy parentName/parentPhone fallback (index.html:90)
    expect(ls.guardian1Name).toBe('李父')
    expect((ls as Record<string, unknown>).parentPhone).toBeUndefined()
    const blob = await db.images.get(zs.photoPath as string)
    expect(blob!.blob.size).toBeGreaterThan(50)
    const s = JSON.stringify(students)
    expect(s).not.toContain('iVBOR')                        // no base64 left in rows
    expect(s).not.toContain('11010120100101001X')           // idCard never enters the DB (spec §2.1)
  })
  it('FK remap: points.studentId and grades.scores keys follow the derived student uuid', async () => {
    await runMigration(deps)
    const zsNew = await deriveUuid('students', 'm3abc01')
    const pts = await store.live('points')
    expect(pts[0].studentId).toBe(zsNew)
    const gr = await store.live('grades')
    expect(Object.keys(gr[0].scores as object)).toContain(zsNew)
    const hw = await store.live('homework')
    expect(Object.keys(hw[0].records as object)).toContain(zsNew)
  })
  it('idempotent: forced re-run keeps identical rows (spec §6)', async () => {
    await runMigration(deps)
    const before = await store.live('exams')
    const report2 = await runMigration({ ...deps, force: true })
    expect(report2.backupSaved).toBe(true)                  // original backup untouched
    const after = await store.live('exams')
    expect(after.length).toBe(before.length)
    expect(after.map(r => r.id).sort()).toEqual(before.map(r => r.id).sort())
  })
  it('every write lands in the outbox for normal sync afterwards', async () => {
    const report = await runMigration(deps)
    const total = Object.values(report.perTable).reduce((a, b) => a + b, 0)
    expect(await db.outbox.count()).toBeGreaterThanOrEqual(total)
  })
  it('refuses to re-run once migrationDone unless force', async () => {
    await runMigration(deps)
    await markMigrationDone(db)                             // idempotent flag write
    await expect(runMigration(deps)).resolves.toMatchObject({ alreadyDone: true })
  })
})
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** `src/core/migration.ts`:

```ts
import type { WbDb } from './db'
import type { MetaStore } from './meta'
import type { LocalStore } from './localStore'
import type { ImageStore } from './images'
import { objectPathFor, dataUrlToBlob } from './images'
import { TABLE_DEFS, JSON_FK_MAPS, type TableDef } from './schema'

export interface MigrationReport {
  backupSaved: boolean; perTable: Record<string, number>; unmappedFields: string[]
  skipped: { table: string; reason: string }[]; alreadyDone?: boolean
}

export async function deriveUuid(legacyKey: string, legacyId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`ella-legacy:${legacyKey}:${legacyId}`))
  const h = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  return [h.slice(0, 8), h.slice(8, 12), '5' + h.slice(13, 16),
    (parseInt(h.slice(16, 18), 16) & 0x3f | 0x80).toString(16).padStart(2, '0') + h.slice(18, 20), h.slice(20, 32)].join('-')
}

export async function migrationDone(db: WbDb): Promise<boolean> { return !!(await db.syncMeta.get('migrated')) }
export async function markMigrationDone(db: WbDb): Promise<void> { await db.syncMeta.put({ key: 'migrated', value: '1' }) }

export async function runMigration(deps: {
  db: WbDb; store: LocalStore; meta: MetaStore; images: ImageStore;
  ownerUid: () => string | null; json: Record<string, unknown>; force?: boolean;
}): Promise<MigrationReport> {
  const { db, store, meta, images, json } = deps
  if ((await migrationDone(db)) && !deps.force) return { backupSaved: false, perTable: {}, unmappedFields: [], skipped: [], alreadyDone: true }
  await meta.setBackup('legacy-wb_tw_data', JSON.stringify(json))       // backup BEFORE any write (spec §6)
  const report: MigrationReport = { backupSaved: true, perTable: {}, unmappedFields: [], skipped: [] }
  for (const def of TABLE_DEFS) {
    if (!def.legacyKey) continue
    const src = json[def.legacyKey] as Record<string, unknown> | undefined
    const items = def.legacySubKey ? ((src?.[def.legacySubKey] as unknown[]) ?? []) : (src as unknown[] | Record<string, unknown> | undefined)
    if (items === undefined || items === null) { report.skipped.push({ table: def.name, reason: 'absent in legacy json' }); report.perTable[def.name] = 0; continue }
    const rows: Record<string, unknown>[] = def.singleton
      ? [{ id: await deriveUuid(def.name, 'singleton'), ...(items as Record<string, unknown>) }]
      : (items as unknown[]).map(r => r as Record<string, unknown>)
    report.perTable[def.name] = 0
    for (const legacy of rows) report.perTable[def.name] += await migrateRow(def, legacy, store, images, report)
  }
  await markMigrationDone(db)
  return report
}

async function migrateRow(
  def: TableDef, legacy: Record<string, unknown>, store: LocalStore, images: ImageStore, report: MigrationReport,
): Promise<number> {
  legacy = { ...legacy }                                  // never mutate the fixture/sample
  if (def.name === 'students') {                            // legacy alias fold (spec §6, mirrors index.html:90)
    if (legacy.parentName && !legacy.guardian1Name) legacy.guardian1Name = legacy.parentName
    if (legacy.parentPhone && !legacy.guardian1Phone) legacy.guardian1Phone = legacy.parentPhone
    delete legacy.parentName; delete legacy.parentPhone
  }
  const oldId = String(legacy.id ?? '')
  const id = await deriveUuid(def.name, oldId || def.name)
  const drop = new Set([...(def.dropColumns ?? []), ...(def.imageColumns ?? []), ...(def.photoColumn ? [def.photoColumn] : [])])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(legacy)) {
    if (k === 'id' || drop.has(k)) continue
    out[k] = await remapValue(def, k, v)
    if (!def.columns.includes(k)) report.unmappedFields.push(`${def.name}.${k}`)
  }
  if (def.photoColumn && typeof legacy[def.photoColumn] === 'string' && (legacy[def.photoColumn] as string).startsWith('data:')) {
    const blob = dataUrlToBlob(legacy[def.photoColumn] as string)
    await images.addLocal(id + '-photo', blob)
    out.photoPath = objectPathFor(id + '-photo')
  }
  for (const col of def.imageColumns ?? []) {
    const arr = (legacy[col] as string[]) ?? []
    const paths: string[] = []
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'string' || !arr[i].startsWith('data:')) continue
      const imgId = `${id}-${col}-${i}`
      await images.addLocal(imgId, dataUrlToBlob(arr[i]))
      paths.push(objectPathFor(imgId))
    }
    out.imagePaths = paths
  }
  await store.put(def.name, { ...out, id } as Record<string, unknown> & { id: string })
  return 1
}

async function remapValue(def: TableDef, key: string, value: unknown): Promise<unknown> {
  if (def.fkColumns?.includes(key) && typeof value === 'string' && value) return deriveUuid('students', value)
  const jsonFk = JSON_FK_MAPS.find(m => m.table === def.name && m.column === key)
  if (jsonFk && value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[await deriveUuid('students', k)] = v
    return out
  }
  return value
}
```

The seating legacy object's `seats[].studentId` values also need remap: add to `migrateRow`, guarded by `def.name === 'seating'`, a pass over `out.seats` remapping `studentId`; and duty `tasks[].assigneeId` likewise guarded by `def.name === 'duty'`. Both use `deriveUuid('students', x)`.

- [ ] **Step 5: Run `npx vitest run test/unit/migration.spec.ts`** → PASS. Full suite + typecheck clean.
- [ ] **Step 6: Commit.** `git add webapp/src/core/migration.ts webapp/test/unit/migration.spec.ts webapp/test/fixtures/wb_tw_data.sample.json && git commit -m "feat(core): schema-driven idempotent legacy migration with backup-first"`

### Task 15: CSV/XLSX parsing port + contact batch import validation (spec §6)

**Files:**
- Create: `webapp/src/core/legacyParsers.ts`, `webapp/src/core/importContacts.ts`, `webapp/test/unit/importContacts.spec.ts`
- Modify: `webapp/src/core/schema.ts` (append `'guardian1Email'` to the `students` def's `columns` — it is a new column that only contact import writes; keeps registry == DDL == rows), `webapp/test/fixtures/contacts.csv` (new)

**Interfaces:**
- Consumes: `Repository`/`LocalStore` (Tasks 5/13) — contact import updates existing student rows via `repo.update`.
- Produces:
  - `parseCsv(text: string): string[][]` — port of `index.html:106` (identical quote/tab semantics).
  - `xlsxToSheets(buf: ArrayBuffer): Promise<{ name: string; rows: string[][] }[]>` — port of `index.html:107-175` (`colToNum`, `inflateRaw`, `parseXlsx`, sharedStrings) to TS; keep the DecompressionStream fast path + manual inflate fallback exactly as the original; the original returns the first sheet only — this ported version returns ALL sheets (parameter already exists: `allSheets`).
  - `pickRow(headers: string[], row: string[], synonyms: Record<string, string[]>): string` — header-name resolution.
  - `validateContacts(rows: { name: string; studentNo: string; phone: string; email: string }[]): ImportReport` where `interface ImportReport { valid: number; rejected: { row: number; reason: string }[] }` — phone must match `/^1[3-9]\d{9}$/` when non-empty, email must match `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` when non-empty. Failures are **summarized per-row, never silently skipped, never abort the batch** (spec §6).
  - `applyContacts(store: LocalStore, report rows, match: (s) => boolean): Promise<{ updated: number; unmatched: string[] }>` — writes `guardian1Phone`/`guardian1Email` onto matched student rows through `LocalStore.put` (so they enqueue for sync like any edit).

- [ ] **Step 1: Create fixture** `test/fixtures/contacts.csv`:

```csv
姓名,学号,家长电话,邮箱
张三,01,13800000001,zs@example.com
李四,02,1390,li@example.com
王五,03,,not-an-email
```

- [ ] **Step 2: Write failing test** `test/unit/importContacts.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { parseCsv, xlsxToSheets } from '../../src/core/legacyParsers'
import { validateContacts, mapContactRows } from '../../src/core/importContacts'
describe('contact import (spec §6)', () => {
  it('parses the fixture into rows with headers', () => {
    const rows = parseCsv(readFileSync('test/fixtures/contacts.csv', 'utf8'))
    expect(rows[0]).toEqual(['姓名', '学号', '家长电话', '邮箱'])
    expect(rows.length).toBe(4)
  })
  it('maps header synonyms to canonical contact fields', () => {
    const rows = parseCsv(readFileSync('test/fixtures/contacts.csv', 'utf8'))
    const mapped = mapContactRows(rows)
    expect(mapped[0]).toMatchObject({ name: '张三', studentNo: '01', phone: '13800000001', email: 'zs@example.com' })
  })
  it('row-level validation: bad phone/email rejected with reason, good rows kept (no silent skip, no whole-batch abort)', () => {
    const rows = parseCsv(readFileSync('test/fixtures/contacts.csv', 'utf8'))
    const { contacts, report } = validateContacts(mapContactRows(rows))
    expect(contacts.length).toBe(1)
    expect(report.rejected.length).toBe(2)
    expect(report.rejected[0].reason).toContain('电话')
    expect(report.rejected[1].reason).toContain('邮箱')
  })
  it('xlsx port: round-trips a fixture produced at build time', async () => {
    const buf = readFileSync('test/fixtures/contacts.xlsx')
    const sheets = await xlsxToSheets(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    expect(sheets[0].rows[1][0]).toBe('张三')
  })
})
```

For `test/fixtures/contacts.xlsx`: create it once with
`python -c "import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws.append(['姓名','学号','家长电话','邮箱']); ws.append(['张三','01','13800000001','zs@example.com']); ws.append(['李四','02','1390','li@example.com']); ws.append(['王五','03','','not-an-email']); wb.save('webapp/test/fixtures/contacts.xlsx')"`
(run from repo root; python/openpyxl here is only a one-off fixture generator, not part of the app toolchain. If python is unavailable, produce the same 4 rows via LibreOffice headless: `soffice --headless --convert-to xlsx` from a CSV, then fix the headers).

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** `legacyParsers.ts` (CSV port + xlsx port as specified above — the CSV function is short enough to inline here verbatim from `index.html:106`):

```ts
export function parseCsv(text: string): string[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim())
  return lines.map(line => {
    const cells: string[] = []; let cur = '', q = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
      else if ((ch === ',' || ch === '\t') && !q) { cells.push(cur.trim()); cur = '' }
      else cur += ch
    }
    cells.push(cur.trim())
    return cells
  })
}
```

For `xlsxToSheets`, port `index.html` lines 107-175 (`colToNum`, the `lens/lext/dists/dext/fixedLen/fixedDist` tables, `inflateRaw`, `inflateRawBytes`, `parseXlsx`) one-for-one to TS with these signatures — everything else stays byte-identical to the reference:

```ts
export async function xlsxToSheets(buf: ArrayBuffer): Promise<{ name: string; rows: string[][] }[]>
```

`importContacts.ts`:

```ts
import type { LocalStore } from './localStore'
export interface ContactRow { name: string; studentNo: string; phone: string; email: string }
export interface ImportReport { valid: number; rejected: { row: number; reason: string }[] }
const SYN: Record<keyof ContactRow, string[]> = {
  name: ['姓名', '名字', '学生姓名', 'name'],
  studentNo: ['学号', '号', 'studentNo', 'no'],
  phone: ['家长电话', '电话', '手机号', '联系电话', 'phone'],
  email: ['邮箱', '电子邮箱', 'email'],
}
export function mapContactRows(rows: string[][]): ContactRow[] {
  const [header, ...body] = rows
  const idx = (field: keyof ContactRow) => header.findIndex(h => SYN[field].some(s => h.toLowerCase().includes(s.toLowerCase())))
  return body.map(r => ({ name: r[idx('name')] ?? '', studentNo: r[idx('studentNo')] ?? '', phone: r[idx('phone')] ?? '', email: r[idx('email')] ?? '' }))
}
const PHONE = /^1[3-9]\d{9}$/
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export function validateContacts(rows: ContactRow[]): { contacts: ContactRow[]; report: ImportReport } {
  const contacts: ContactRow[] = []; const rejected: ImportReport['rejected'] = []
  rows.forEach((r, i) => {
    const reasons: string[] = []
    if (!r.name) reasons.push('缺少姓名')
    if (r.phone && !PHONE.test(r.phone)) reasons.push('电话位数无效')
    if (r.email && !EMAIL.test(r.email)) reasons.push('邮箱格式无效')
    if (reasons.length) rejected.push({ row: i + 2, reason: reasons.join('；') })     // 1-based incl header
    else contacts.push(r)
  })
  return { contacts, report: { valid: contacts.length, rejected } }
}
export async function applyContacts(store: LocalStore, contacts: ContactRow[]): Promise<{ updated: number; unmatched: string[] }> {
  const students = await store.live('students')
  let updated = 0; const unmatched: string[] = []
  for (const c of contacts) {
    const s = students.find(x => (c.studentNo && x.studentNo === c.studentNo) || x.name === c.name)
    if (!s) { unmatched.push(c.name || c.studentNo); continue }
    await store.put('students', { ...s, guardian1Phone: c.phone || s.guardian1Phone, guardian1Email: c.email } as Record<string, unknown> & { id: string })
    updated++
  }
  return { updated, unmatched }
}
```

- [ ] **Step 5: Run `npx vitest run test/unit/importContacts.spec.ts` + full suite** → PASS.
- [ ] **Step 6: Commit.** `git add webapp/src/core/legacyParsers.ts webapp/src/core/importContacts.ts webapp/test/unit/importContacts.spec.ts webapp/test/fixtures && git commit -m "feat(core): csv/xlsx import channel with per-row validation report"`

### Task 16: SQL DDL generator + migrations (files now; applying is 🚫CRED)

**Files:**
- Create: `webapp/src/tools/genDdl.ts`, `supabase/migrations/202610170001_initial.sql` (generated), `webapp/test/unit/genDdl.spec.ts`
- Modify: `webapp/src/core/schema.ts` (add `sql?: Record<string, 'uuid' | 'jsonb' | 'boolean' | 'timestamptz' | 'double precision'>` per-column type overrides to each `TableDef` — mechanical, see step 1)

**Interfaces:**
- Consumes: `TABLE_DEFS` (Task 6), `tableNames()` (Task 6).
- Produces: `renderDdl(): string` — pure function over the registry; `npm run gen:ddl` writes the generated file only if it does not yet exist (never overwrite: the generated file must be editable once per-column tuning starts in subprojects 2-4 without regenerating). Per-table output: standard audit columns + business columns, `set_updated_at` trigger (spec §5.2), RLS enabled + 4 policies `owner_id = (select auth.uid())` (spec §4), realtime publication add.
- Consumes for verification (🚫CRED): live `supabase db push` + `psql`/SQL editor checks.

- [ ] **Step 1: Extend `TableDef`** with `sql?: Record<string, 'uuid' | 'jsonb' | 'boolean' | 'timestamptz' | 'double precision'>` per business column (default `text`). Annotate from the registry data already proven: `students.tags` jsonb; `seating.rows/cols` double precision, `seats` jsonb; `duty.group` double precision, `tasks` jsonb; `violations/communications/points.studentId` uuid, `grade/exams.subjects/stats/students` jsonb, `exams.students` jsonb, `stats` jsonb, `date` timestamptz for `todos.deadline/grades.date/exams.date` (dates keep `date` name, plain `text` for legacy YYYY-MM-DD fields — do NOT change field names; only `todos.deadline` gets `date`), `schedule.day/period` double precision; `homework.records` jsonb; `activities.imagePaths` jsonb (the migrated field name from Task 14: `images` → `imagePaths` jsonb storing the object paths); `behaviors.images` jsonb; `behaviors.level` double precision; `settings.*` jsonb except `weekType` text; `points.points` double precision; `students.group` double precision.

- [ ] **Step 2: Write failing test** `test/unit/genDdl.spec.ts` (pure string checks, no DB):

```ts
import { describe, it, expect } from 'vitest'
import { renderDdl } from '../../src/tools/genDdl'
import { TABLE_DEFS } from '../../src/core/schema'
const ddl = renderDdl()
describe('ddl generator (spec §4)', () => {
  it('one create table per registered def, ordered', () => {
    for (const d of TABLE_DEFS) expect(ddl).toContain(`create table if not exists public.${d.name} (`)
    const pos = TABLE_DEFS.map(d => ddl.indexOf(`public.${d.name} (`))
    expect([...pos].sort((a, b) => a - b)).toEqual(pos)
  })
  it('audit columns exactly as spec §4', () => {
    expect(ddl).toContain('owner_id uuid not null')
    expect(ddl).toContain('seq bigint not null')
    expect(ddl).toContain('updated_at timestamptz not null default now()')
    expect(ddl).toContain('deleted_at timestamptz')
    expect(ddl).toContain('device_id text not null')
  })
  it('every table gets the updated_at trigger and the 4 RLS policies', () => {
    for (const d of TABLE_DEFS) {
      expect(ddl).toContain(`create trigger trg_${d.name}_updated_at before insert or update on public.${d.name}`)
      for (const cmd of ['select', 'insert', 'update', 'delete'])
        expect(ddl).toContain(`create policy ${cmd}_${d.name} on public.${d.name} for ${cmd} using ((select auth.uid()) = owner_id)`)
    }
  })
  it('no idCard column anywhere (spec §2.1)', () => expect(ddl.toLowerCase()).not.toContain('idcard'))
})
```

- [ ] **Step 3: Run → FAIL**, then **implement** `webapp/src/tools/genDdl.ts`:

```ts
import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { TABLE_DEFS, tableNames, type TableDef } from '../core/schema'
function colType(d: TableDef, c: string): string { return d.sql?.[c] ?? 'text' }
export function renderDdl(): string {
  const out: string[] = [
    '-- GENERATED from webapp/src/core/schema.ts via `npm run gen:ddl` (202610170001).',
    '-- Do not hand-edit column semantics here; edit the registry (subprojects 2-4 may fork this file after creation).',
    `-- tables: ${tableNames().join(', ')}`,
    '',
    'create or replace function public.set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;',
    '',
  ]
  for (const d of TABLE_DEFS) {
    const cols = d.columns.map(c => `  "${c}" ${colType(d, c)}`).join(',\n')
    out.push(
      `create table if not exists public.${d.name} (`,
      '  id uuid primary key,',
      '  owner_id uuid not null references auth.users (id) on delete cascade,',
      '  seq bigint not null,',
      '  updated_at timestamptz not null default now(),',
      '  deleted_at timestamptz,',
      '  device_id text not null,',
      cols,
      ');',
      `drop trigger if exists trg_${d.name}_updated_at on public.${d.name};`,
      `create trigger trg_${d.name}_updated_at before insert or update on public.${d.name} for each row execute function public.set_updated_at();`,
      `alter table public.${d.name} enable row level security;`,
      ...['select', 'insert', 'update', 'delete'].map(cmd =>
        `create policy ${cmd}_${d.name} on public.${d.name} for ${cmd} using ((select auth.uid()) = owner_id) with check ((select auth.uid()) = owner_id);`),
      `alter publication supabase_realtime add table public.${d.name};`,
      '',
    )
  }
  return out.join('\n')
}
if (process.argv[1] && process.argv[1].includes('genDdl')) {
  const dir = new URL('../../../supabase/migrations/', import.meta.url).pathname.replace(/^\//, '')
  mkdirSync(dir, { recursive: true })
  const file = dir + '202610170001_initial.sql'
  if (existsSync(file)) console.log('skip: ' + file + ' already exists (generated files are frozen)')
  else { writeFileSync(file, renderDdl()); console.log('wrote ' + file) }
}
```

(`insert/update/delete` policies need `with check`; `select` policy with `with check` is harmless and keeps the generator uniform — the test's `using (...)` substring assertion passes for all four.)

- [ ] **Step 4: Run `npx vitest run test/unit/genDdl.spec.ts`** → PASS. **Then generate:** `npm run gen:ddl` and visually review `supabase/migrations/202610170001_initial.sql` (columns vs `index.html` shapes; `exams` present).
- [ ] **Step 5: Commit** (files only — nothing was applied to a server): `git add supabase/migrations webapp/src/tools webapp/test/unit/genDdl.spec.ts webapp/src/core/schema.ts && git commit -m "feat(sql): registry-generated DDL with triggers+RLS (not yet applied)"`
- [ ] **Step 6: 🚫CRED — apply & verify (only when the user supplies `SUPABASE_URL` + key).** Set a project `supabase/.env` (gitignored) or use the dashboard SQL editor:
  - [ ] Apply `202610170001_initial.sql` (`supabase db push` or paste into SQL editor) and confirm no errors.
  - [ ] In SQL editor, verify the trigger: insert a row into `exams` with `updated_at` absent from the insert — it comes back non-null and equal to server `now()`; a client-supplied garbage `updated_at` on update is overwritten (spec §5.2: trigger must exist because payload never carries it).
  - [ ] RLS isolation: with two teacher accounts A/B and A's anon+JWT session, B cannot select/insert/update/delete A's rows (all 4 verbs 403/empty).
  - [ ] Confirm realtime events for `exams` fire on `supabase_realtime` publication.

### Task 17: Bootstrap + UI shell — "已保存 ≠ 已同步" status, migration entry, degradation paths

**Files:**
- Create: `webapp/src/bootstrap.ts`, `webapp/src/App.vue` (replace scaffold default), `webapp/src/components/StatusBanner.vue`, `webapp/src/components/LoginForm.vue`, `webapp/test/unit/bootstrap.spec.ts`
- Modify: `webapp/src/main.ts` (mount via bootstrap)

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `bootstrap(): Promise<AppContext>` where `AppContext = { db, store, outbox, meta, images, engine, auth, gateway: RemoteGateway | null, mode: 'online' | 'local-only' }`. Order: `openNativeIdbOrFallback()` → `openDb` → `registerAllTables` → `MetaStore`(deviceId) → `LocalStore` → `Outbox` → `ImageStore` → `createSupabaseClient()`; if client → `Auth.remote` else `Auth.local('local-user')`; gateway only if client; `new SyncEngine(...)`; `engine.start()`. **No step throws when env/credentials are absent** — that is the local-only mode (the current reality).
  - `openNativeIdbOrFallback(): Promise<'native' | 'in-memory-fallback'>` — spec §7 row 4: probe native `indexedDB.open`; on failure `await import('fake-indexeddb/auto')` (in-memory by construction) and report `'in-memory-fallback'`; App.vue must then show a persistent banner "浏览器不支持持久化存储（无痕模式？）——本次会话数据不会保存".
  - `export let lastStorageMode: 'native' | 'in-memory-fallback' | null` — set by the probe above; read by `App.vue` (import it directly, not via dynamic import).
- [ ] **Step 1: Write failing test** `test/unit/bootstrap.spec.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { bootstrap } from '../../src/bootstrap'
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
```

- [ ] **Step 2: Run → FAIL**, implement `bootstrap.ts` per the order above (single `try/catch` around the probe; deterministic db name `wb-app`). Then `App.vue` — keep it tiny, it is scaffolding for subprojects 2-4, not UI design:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { bootstrap, lastStorageMode, type AppContext } from './bootstrap'
import { runMigration, migrationDone } from './core/migration'
import StatusBanner from './components/StatusBanner.vue'
const ctx = ref<AppContext | null>(null)
const showMigrate = ref(false)
onMounted(async () => {
  ctx.value = await bootstrap()
  showMigrate.value = !!localStorage.getItem('wb_tw_data') && !(await migrationDone(ctx.value.db))
})
async function demoSave() { if (ctx.value) await ctx.value.store.put('todos', { id: crypto.randomUUID(), title: 'demo ' + Date.now(), completed: false }) }
async function migrate() {
  if (!ctx.value) return
  const raw = localStorage.getItem('wb_tw_data'); if (!raw) return
  await runMigration({ ...ctx.value, ownerUid: () => ctx.value!.auth.currentUid(), json: JSON.parse(raw) })
  showMigrate.value = false
}
</script>
<template>
  <div v-if="lastStorageMode === 'in-memory-fallback'" class="warn">浏览器不支持持久化存储（无痕模式？）——本次会话数据不会保存</div>
  <h1>Class app (infra only)</h1>
  <StatusBanner v-if="ctx" :engine="ctx.engine" />
  <p v-if="ctx && ctx.mode === 'local-only'">离线模式：未配置 Supabase 凭据，数据只存本地并排队待同步。</p>
  <button @click="demoSave">写入一条（验证 已保存/待同步 分离）</button>
  <button v-if="showMigrate" @click="migrate">导入旧版数据（一次性，先备份）</button>
</template>
```

`StatusBanner.vue` (spec §5.1: separate 已保存 vs 已同步 + pending count, never merged into one toast):

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { SyncEngine } from '../core/syncEngine'
const props = defineProps<{ engine: SyncEngine }>()
const pending = ref(0); const lastError = ref<string | null>(null)
const savedMsg = ref<string | null>(null)
let h: unknown = null
onMounted(() => {
  h = props.engine.onState = s => { pending.value = s.pending; lastError.value = s.lastError }
})
onUnmounted(() => { props.engine.onState = null })
function saved() { savedMsg.value = '已保存（本地）'; clearTimeout(h as never); setTimeout(() => (savedMsg.value = null), 1500) }
defineExpose({ saved })
</script>
<template>
  <div class="status">
    <span v-if="savedMsg">{{ savedMsg }}</span>
    <span v-if="pending > 0">待同步 {{ pending }} 条</span>
    <span v-else>已同步</span>
    <span v-if="lastError" class="error">{{ lastError }}</span>
  </div>
</template>
```

`main.ts`: `import App from './App.vue'; createApp(App).mount('#app')` (unchanged shape; bootstrap now runs inside `App.onMounted`).

Then `components/LoginForm.vue` — spec §7 "认证过期：保留本地数据与队列，跳登录，重登后继续同步". It renders only when a real client exists but no session uid, and re-arms push after sign-in; local data/outbox are never touched by any of its code paths:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import type { Auth } from '../core/auth'
const props = defineProps<{ auth: Auth; onDone?: () => void }>()
const email = ref(''); const password = ref(''); const error = ref<string | null>(null)
async function submit() {
  error.value = null
  try { await props.auth.signIn(email.value, password.value); props.onDone?.() }
  catch (e) { error.value = e instanceof Error ? e.message : String(e) }
}
</script>
<template>
  <form @submit.prevent="submit" class="login">
    <input v-model="email" type="email" placeholder="邮箱" />
    <input v-model="password" type="password" placeholder="密码" />
    <button type="submit">登录</button>
    <span v-if="error" class="error">{{ error }}</span>
  </form>
</template>
```

In `App.vue`'s template add directly beneath the status banner (`<LoginForm v-if="ctx && !ctx.auth.currentUid()" :auth="ctx.auth" :on-done="() => ctx?.engine.syncOnce()" />`) and add `import LoginForm from './components/LoginForm.vue'`. In `StatusBanner.vue`, inside the `onState` handler also run `void quotaNag().then(m => { quotaMsg.value = m })` (new `const quotaMsg = ref<string | null>(null)`, rendered as another `<span class="error">` — spec §7 quota row), importing `quotaNag` from `../core/images`.

- [ ] **Step 3: Run bootstrap test + `npm run build` + `npm run test`** → PASS.
- [ ] **Step 4: Manual browser check (local, no credentials):** `npm run dev`, open page — local-only banner shows; click demoSave: "已保存（本地）" plus "待同步 N 条" both visible; reload: queue persists (pending count unchanged).
- [ ] **Step 5: Commit.** `git add webapp/src webapp/test/unit/bootstrap.spec.ts && git commit -m "feat(app): local-first bootstrap, saved-vs-synced status, idb degradation"`

### Task 18: Local acceptance suite for spec §9 + docs sync

**Files:**
- Create: `webapp/test/acceptance.local.spec.ts`
- Modify: (if any acceptance gap surfaces a bug, fix the module in the same task and note it)

**Interfaces:**
- Consumes: everything (this is the integration harness proving criteria 1–6 locally).
- Produces: `makeDevice(dbName: string, deviceId: string, gateway: FakeGateway | null)` helper returning `{ store, meta, outbox, images, engine, repoOf(table) }` — two "devices" share one `FakeGateway` and a shared monotonic server clock (`fake.clock`).

- [ ] **Step 1: Write the suite.** Key excerpts (author must flesh out all six tests in full before running — every assertion below is mandatory):

```ts
import { describe, it, expect } from 'vitest'
import type { Table } from 'dexie'
import { openDb } from '../src/core/db'
import { MetaStore } from '../src/core/meta'
import { LocalStore } from '../src/core/localStore'
import { Outbox } from '../src/core/outbox'
import { ImageStore } from '../src/core/images'
import { SyncEngine } from '../src/core/syncEngine'
import { Repository } from '../src/core/repository'
import { registerAllTables, addTableDef } from '../src/core/schema'
import { runMigration } from '../src/core/migration'
import { FakeGateway } from './fakeGateway'
import sample from './fixtures/wb_tw_data.sample.json'
import type { Row } from '../src/core/types'

async function makeDevice(name: string, deviceId: string, gateway: FakeGateway | null) {
  const db = await openDb(name)
  registerAllTables(db)
  const meta = new MetaStore(db)
  const store = new LocalStore({ db, meta, deviceId, ownerUid: () => 'u-1',
    table: n => db.business.get(n) as Table<Row, string> })
  const outbox = new Outbox(db)
  const images = new ImageStore(db, meta, deviceId, () => 'u-1')
  const engine = new SyncEngine({ store, outbox, meta, gateway, ownerUid: () => 'u-1',
    now: () => 0, setTimeoutFn: () => 0, clearTimeoutFn: () => {},
    images: { getBlob: id => db.images.get(id).then(r => r?.blob), markUploaded: async id => { await db.images.update(id, { uploaded: true }) } } })
  return { db, meta, store, outbox, images, engine, repoOf: <T extends Record<string, unknown>>(t: string) => new Repository<T>(t, store, images) }
}

describe('spec §9 acceptance, local stand-in', () => {
  it('A1: 30 offline writes → after reconnect, gateway holds exactly 30 rows in seq order', async () => {
    const gw = new FakeGateway()
    const dev = await makeDevice('a1', 'dev-A', null)
    for (let i = 0; i < 30; i++) await dev.store.put('todos', { id: `t${i}`, title: 'T' + i })
    expect(await dev.outbox.count()).toBe(30)
    // "reconnect": swap the engine's gateway (constructor reuse on the same store is fine)
    const dev2 = await makeDevice('a1', 'dev-A', gw)
    expect(await dev2.engine.pushOnce()).toBe(30)
    const remote = [...gw.server.get('todos')!.values()]
    expect(remote.length).toBe(30)
    expect(remote.map(r => r.seq)).toEqual([...remote.map(r => r.seq)].sort((a, b) => (a as number) - (b as number)))
    expect(new Set(remote.map(r => r.id)).size).toBe(30)          // no duplicates
    expect(await dev2.outbox.count()).toBe(0)
  })

  it('A2: two devices edit the same row → converge to one explainable state', async () => {
    const gw = new FakeGateway()
    const A = await makeDevice('a2a', 'dev-A', gw)
    const B = await makeDevice('a2b', 'dev-B', gw)
    await A.store.put('notes', { id: 'x', title: 'base' })
    await A.engine.syncOnce()                                      // row lands server-side
    await B.engine.syncOnce()                                      // B learns base (stamped)
    await A.store.put('notes', { id: 'x', title: 'from-A' })
    await B.store.put('notes', { id: 'x', title: 'from-B' })
    await A.engine.pushOnce(); await B.engine.pushOnce()
    await A.engine.pullOnce(); await B.engine.pullOnce()
    const a = (await A.store.get('notes', 'x'))!.title
    const b = (await B.store.get('notes', 'x'))!.title
    expect(a).toBe(b)                                              // convergence
    expect([a]).toContain('from-B')                               // deterministic: FakeGateway clock stamps later write newer (LWW by server time)
  })

  it('A3: delete on A → B refreshes → tombstone, no resurrection (spec §4)', async () => {
    const gw = new FakeGateway()
    const A = await makeDevice('a3a', 'dev-A', gw)
    const B = await makeDevice('a3b', 'dev-B', gw)
    await A.store.put('notes', { id: 'd', title: 'x' })
    await A.engine.syncOnce(); await B.engine.syncOnce()
    await A.store.softDelete('notes', 'd')
    await A.engine.syncOnce(); await B.engine.syncOnce()
    expect(await B.store.get('notes', 'd')).toBeUndefined()       // hidden
    const raw = await B.db.business.get('notes')!.get('d')         // row still present as tombstone
    expect(raw!.deletedAt).not.toBeNull()
    await A.engine.syncOnce(); await B.engine.syncOnce()          // repeated pulls must not revive it
    expect((await B.db.business.get('notes')!.get('d'))!.deletedAt).not.toBeNull()
  })

  it('A4: album offline add + view works with no gateway at all (spec §5.5)', async () => {
    const dev = await makeDevice('a4', 'dev-A', null)
    const blob = new Blob(['fake-photo'], { type: 'image/png' })
    await dev.images.addLocal('cap1', blob)
    await dev.store.put('activities', { id: 'act1', title: '运动会', imagePaths: ['albums/cap1'] })
    const back = await dev.images.getBlob('cap1')
    expect(back).toBeInstanceOf(Blob)
    expect(back!.size).toBe(10)
    expect(await dev.images.isUploaded('cap1')).toBe(false)     // offline: queued, viewable from local
    expect(await dev.outbox.count()).toBe(2)                     // upload + row entry waiting for reconnect
  })

  it('A5: legacy import — per-table counts and field-level equality incl. exams (spec §6)', async () => {
    const dev = await makeDevice('a5', 'dev-A', null)
    const report = await runMigration({ ...dev, ownerUid: () => 'u-1', json: sample })
    expect(report.perTable.exams).toBe(2)
    expect(report.unmappedFields).toEqual([])
    const ex = await dev.store.live('exams')
    expect(ex.map(e => e.name).sort()).toEqual(['月考', '期中考试'])
  })

  it('A6: new business table needs only schema + registration — zero sync code (spec §9.6)', async () => {
    const gw = new FakeGateway()
    const dev = await makeDevice('a6', 'dev-A', gw)
    addTableDef(dev.db, { name: 'test_notes', columns: ['text'] })     // the ENTIRE integration surface
    await dev.store.put('test_notes', { id: 'z', text: 'hi' })
    await dev.engine.syncOnce()
    expect((await gw.fetchUpdatedSince('test_notes', '1970-01-01T00:00:00.000Z'))[0].text).toBe('hi')
  })
})
```

- [ ] **Step 2: Run `npx vitest run test/acceptance.local.spec.ts`** → all six PASS. Fix any engine/store gaps this surfaces **in the owning module** (that is the point of the acceptance gate), keeping this suite as the contract.
- [ ] **Step 3: Full gates:** `npm run test`, `npm run typecheck`, `npm run build` all clean. `git status --porcelain` shows no changes to `index.html` or the spec file.
- [ ] **Step 4: Commit.** `git add webapp/test/acceptance.local.spec.ts && git commit -m "test: local acceptance suite for spec section 9 criteria 1-6"`
- [ ] **Step 5: 🚫CRED — live acceptance rerun checklist (execute when credentials arrive, in this order):**
  - [ ] Put `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in `webapp/.env` (never commit it). `createSupabaseClient()` returns non-null; app boots in 'online' mode.
  - [ ] `supabase db push` with a real teacher account; create that account in Auth (email+password).
  - [ ] A1 live: devtools offline for 30 writes, go online → `select count(*) from todos` = 30, seq order matches, no dupes.
  - [ ] A2 live: two browsers (normal + private) edit one row → both converge; screenshot the final states for the record.
  - [ ] A3 live: delete in one browser, refresh the other → gone, stays gone.
  - [ ] A4 live: photo added offline → uploads on reconnect; visible on device 2 after pull (`storage.objects` shows `albums/<id>`; DB row has only the path).
  - [ ] A5 live: import a real `wb_tw_data` from the old app's browser → per-table SQL counts equal the old JSON arrays (especially `exams`); trigger-stamped `updated_at` present everywhere.
  - [ ] Verify RLS cross-account isolation as in Task 16 Step 6.
  - [ ] Update this plan's checkboxes + `docs/superpowers/specs/…` status line ONLY if the user asks; otherwise record results in the PR/commit.

## Appendix: blocked-on-credentials register

**Available today (no instance):** everything in Tasks 1–15, Task 16 up to its Step 6, Task 17 entirely, Task 18 Steps 1–4. That is the deliberate center of gravity of this plan: the local-first store, outbox ordering + backoff, conflict matrix, migration mapping, and all six acceptance criteria's local stand-ins run green with zero credentials.

**Blocked until the user provides `SUPABASE_URL` + anon key + instance access (each 🚫CRED step above, consolidated):**

1. Task 11 Step 5 — live auth smoke (login, session uid, 403 mapping against real RLS).
2. Task 10/11 — realtime `postgres_changes` from the real server (interface tested via FakeGateway already).
3. Task 16 Step 6 — apply `202610170001_initial.sql`; verify `set_updated_at` trigger, 4×RLS policies per table, realtime publication.
4. Task 12 Step 6 — Storage bucket `album` creation + real upload round-trip.
5. Task 18 Step 5 — live reruns of acceptance criteria 1–4 (and criterion 5 with real legacy data, 6 with the real instance's schema).

**Also pending user input at that time:** schema export of the existing instance (spec assumed reuse — if the instance already has conflicting table names, rename via the registry in Task 6 and regenerate DDL, do not hand-edit the frozen generated SQL).

**Known follow-ups for subprojects 2–4 (recorded, not planned here):** blob cache-fill from the server for images created on another device (needs a download path in `RemoteGateway`), watermark column typed as `date_trunc('microsecond', now())` if PostgREST truncation causes re-pulls, per-table watermarks if catch-up cost shows, the `parentName/parentPhone` legacy fallback removal once subproject 2 rewrites `students`.

</parameter
</invoke>





