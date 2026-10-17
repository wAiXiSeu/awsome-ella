import type { WbDb } from './db'
import type { OutboxEntry } from './types'

/** Exponential retry spacing, capped (spec §7 「指数退避重试」). */
export function backoffDelay(attempts: number, baseMs = 2000, maxMs = 300000): number {
  return Math.min(baseMs * 2 ** attempts, maxMs)
}

export class Outbox {
  constructor(private db: WbDb) {}

  /** Ready = not blocked by a 403 and its backoff has elapsed; always ascending `seq` (spec §5.2). */
  async listReady(now: number, limit: number): Promise<OutboxEntry[]> {
    const all = await this.db.outbox.orderBy('seq').toArray()
    return all.filter(e => !e.blocked && e.nextAttemptAt <= now).slice(0, limit)
  }

  async markDone(seq: number): Promise<void> { await this.db.outbox.delete(seq) }

  async markFailed(seq: number, error: string, retryInMs: number, now: number): Promise<void> {
    const e = await this.db.outbox.get(seq)
    if (!e) return
    await this.db.outbox.put({ ...e, attempts: e.attempts + 1, nextAttemptAt: now + retryInMs, lastError: error })
  }

  /** RLS 403: treated as a program defect — stop retrying, but keep the entry and surface it (spec §7). */
  async markBlocked(seq: number, error: string): Promise<void> {
    const e = await this.db.outbox.get(seq)
    if (!e) return
    await this.db.outbox.put({ ...e, blocked: true, lastError: error })
  }

  count(): Promise<number> { return this.db.outbox.count() }

  async earliestNextAttempt(now: number): Promise<number | null> {
    const all = (await this.db.outbox.toArray()).filter(e => !e.blocked)
    if (!all.length) return null
    return Math.min(...all.map(e => Math.max(e.nextAttemptAt, now + 50)))
  }

  /** Distinct tables with pending entries — drives the sync-state UI. */
  async tables(): Promise<string[]> { return [...new Set((await this.db.outbox.toArray()).map(e => e.table))] }
}
