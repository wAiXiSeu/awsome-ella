import type { LocalStore } from './localStore'
import type { Outbox } from './outbox'
import { backoffDelay } from './outbox'
import type { MetaStore } from './meta'
import type { RemoteGateway } from './gateway'
import { PermissionDeniedError } from './gateway'
import { toRemoteRow } from './case'
import { applyRemoteRows } from './remoteApply'
import { tableNames } from './schema'
import type { OutboxEntry, Row } from './types'

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

/**
 * The only component allowed to talk to the remote (spec §3). Everything it does is driven by the
 * outbox; it never writes business rows directly.
 */
export class SyncEngine {
  /** Status surface for the UI: 待同步 N 条 / 最后一次错误 (spec §5.1). */
  onState: ((s: SyncState) => void) | null = null
  private lastError: string | null = null

  constructor(private d: SyncEngineDeps) {}

  private emit(): Promise<void> {
    return this.d.outbox.count().then(pending => { this.onState?.({ pending, lastError: this.lastError, running: false }) })
  }

  /** Push ready entries in `seq` order, batched per table (spec §5.2). Returns rows pushed. */
  async pushOnce(): Promise<number> {
    if (!this.d.gateway) return 0                       // local-only mode (no credentials yet)
    const uid = this.d.ownerUid()
    if (!uid) return 0                                  // auth expired: keep the queue (spec §7)
    const now = this.d.now()
    const ready = await this.d.outbox.listReady(now, BATCH)
    if (!ready.length) return 0

    let pushed = 0
    const byTable = new Map<string, OutboxEntry[]>()
    for (const e of ready) {
      const arr = byTable.get(e.table) ?? []
      arr.push(e)
      byTable.set(e.table, arr)
    }

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
            await this.d.outbox.markFailed(e.seq, msg, backoffDelay(e.attempts), this.d.now())
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

  /** Pull (catch-up) first, then push — spec §5.3 then §5.2. */
  async syncOnce(): Promise<void> {
    await this.pullOnce()
    await this.pushOnce()
  }

  async pullOnce(): Promise<void> {
    const gw = this.d.gateway
    if (!gw) return                                       // local-only: nothing to pull
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
  private unsubs: (() => void)[] = []
  private timers: Record<string, unknown> = {}

  start(): void {
    if (this.running) return
    this.running = true
    this.subscribeAll()
    // Wake triggers touch window/document, so the node test env only gets subscriptions (plan Task 10).
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

  /** Periodic catch-up covers realtime events missed while the socket was down (spec §5.3). */
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
}
