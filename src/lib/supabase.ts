/**
 * Supabase client.
 *
 * The app is designed to boot and explain itself when Supabase is NOT yet
 * configured, rather than crashing on a missing env var. Until keys are set,
 * `supabase` is null and the UI shows a setup screen -- which is the honest
 * state of a fresh install, not an error.
 *
 * Only the anon/publishable key belongs here. It is safe in the browser
 * precisely because row-level security, not key secrecy, is what protects the
 * data. The service-role key must never appear in this file or any other file
 * under src/.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * `import.meta.env` only exists inside a Vite build. Reading it directly
 * makes this module — and therefore every module that imports it, which is
 * most of the app — throw when loaded from a plain Node context such as the
 * render smoke test. Defaulting to an empty object costs nothing and keeps
 * the whole dependency graph importable outside the browser.
 */
const env: Record<string, string | undefined> =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {};

const url = env.VITE_SUPABASE_URL?.trim();
const anonKey = env.VITE_SUPABASE_ANON_KEY?.trim();

export const PHOTO_BUCKET = 'card-photos';

function looksValid(u?: string, k?: string): boolean {
  if (!u || !k) return false;
  if (u.includes('YOUR_') || k.includes('YOUR_')) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export const isSupabaseConfigured = looksValid(url, anonKey);

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

/** Narrow the nullable client at call sites that require it. */
export function requireSupabase(): SupabaseClient {
  if (!supabase) {
    throw new Error(
      'Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env.local.'
    );
  }
  return supabase;
}

/** Diagnostics shown on the setup screen. */
export const supabaseDiagnostics = {
  urlPresent: Boolean(url),
  keyPresent: Boolean(anonKey),
  urlValue: url ? `${url.slice(0, 32)}${url.length > 32 ? '…' : ''}` : null,
};
