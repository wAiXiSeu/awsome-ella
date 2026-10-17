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
