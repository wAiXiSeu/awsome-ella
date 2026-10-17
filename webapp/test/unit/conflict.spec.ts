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
