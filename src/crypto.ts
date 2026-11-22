// WebCrypto helpers (Workers and Node 20+).

const encoder = new TextEncoder()

/** Hex HMAC-SHA256 of `message` under `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
  let out = ''
  for (const b of sig) out += b.toString(16).padStart(2, '0')
  return out
}

/** Compare two strings in time independent of where they differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  let diff = x.length ^ y.length
  const n = Math.max(x.length, y.length)
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function randomId(): string {
  return crypto.randomUUID()
}
