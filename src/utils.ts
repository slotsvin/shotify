/**
 * Pure utility functions used by the app (PKCE, formatting, shuffle).
 * Kept in a separate module for unit testing.
 */

/** Generate a random alphanumeric string of given length (for PKCE code_verifier). */
export function generateRandomString(length: number): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let text = ''
  for (let i = 0; i < length; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}

/** SHA-256 hash of a string (for PKCE code_challenge). */
export async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder()
  const data = encoder.encode(plain)
  return crypto.subtle.digest('SHA-256', data)
}

/** Base64url-encode an ArrayBuffer (no +, /, or = padding; for PKCE). */
export function base64UrlEncode(input: ArrayBuffer): string {
  const bytes = new Uint8Array(input)
  let binary = ''
  bytes.forEach((b) => {
    binary += String.fromCharCode(b)
  })
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Format an ISO date string for display (e.g. "Jan 15, 2024"). Returns iso if invalid. */
export function formatAddedAt(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

/** Fisher–Yates shuffle; returns a new array, does not mutate the original. */
export function shuffle<T>(array: T[]): T[] {
  const out = [...array]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
