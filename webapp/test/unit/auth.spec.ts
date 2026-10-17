import { describe, it, expect } from 'vitest'
import { createSupabaseClient, bucketName } from '../../src/core/supabaseClient'
import { Auth } from '../../src/core/auth'

describe('credential gating (spec §2.1 env-only config)', () => {
  it('returns null client when env vars are absent — app still boots local-only', () => {
    expect(createSupabaseClient()).toBeNull()            // .env not present in tests
    expect(bucketName()).toBe('album')                     // documented default
  })
  it('local Auth always has the seeded uid and never throws', async () => {
    const a = Auth.local('uid-local')
    expect(a.currentUid()).toBe('uid-local')
    await expect(a.signIn('x', 'y')).rejects.toThrow('未配置')
  })
  it('local Auth notifies subscribers and can be unsubscribed', () => {
    const a = Auth.local('uid-local')
    const seen: (string | null)[] = []
    const off = a.onChange(uid => { seen.push(uid) })
    off()
    expect(seen).toEqual([])                              // no changes fired for a local auth
    expect(a.currentUid()).toBe('uid-local')
  })
})
