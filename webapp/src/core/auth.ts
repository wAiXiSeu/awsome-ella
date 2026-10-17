import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Session uid cache. `Auth.local()` is the no-credentials path (spec §2.1), `Auth.remote()` the
 * Supabase path. Business code only ever asks for `currentUid()`.
 */
export class Auth {
  private uid: string | null = null
  private cbs = new Set<(uid: string | null) => void>()

  private constructor(private sb: SupabaseClient | null, uid: string | null) { this.uid = uid }

  static local(uid: string): Auth { return new Auth(null, uid) }

  static async remote(sb: SupabaseClient): Promise<Auth> {
    const a = new Auth(sb, null)
    const { data } = await sb.auth.getSession()
    a.set(data.session?.user.id ?? null)
    sb.auth.onAuthStateChange((_event, session) => a.set(session?.user.id ?? null))
    return a
  }

  private set(uid: string | null) { this.uid = uid; this.cbs.forEach(cb => cb(uid)) }

  currentUid(): string | null { return this.uid }

  onChange(cb: (uid: string | null) => void): () => void {
    this.cbs.add(cb)
    return () => { this.cbs.delete(cb) }
  }

  async signIn(email: string, password: string): Promise<void> {
    if (!this.sb) throw new Error('未配置 Supabase 凭据（VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY）')
    const { error } = await this.sb.auth.signInWithPassword({ email, password })
    if (error) throw error
  }

  async signOut(): Promise<void> { await this.sb?.auth.signOut() }
}
