import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/**
 * The credential gate (spec §2.1: connection strings come from env only).
 * Returning `null` is not an error — it is local-only mode, and every downstream component
 * (Auth, gateway, bootstrap) accepts it.
 */
export function createSupabaseClient(): SupabaseClient | null {
  const url = import.meta.env.VITE_SUPABASE_URL
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

export function bucketName(): string { return import.meta.env.VITE_SUPABASE_BUCKET || 'album' }
