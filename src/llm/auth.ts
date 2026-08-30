import { DEFAULT_BASE_URL, errorMessage } from './openrouter'

/** Dies with the tab, and survives the cross-origin round trip. See startPkce. */
const VERIFIER_KEY = 'vibe3d.pkce'

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
}

/**
 * The callback is derived, never a constant: one build artifact deploys to a
 * Pages subpath, a custom domain and localhost, and the exchange rejects a
 * callback_url that differs from the one the code was minted for.
 */
function callbackUrl(): string {
  return location.origin + location.pathname
}

/** 32 random bytes → 43 base64url chars, inside RFC 7636's 43–128 window. */
export function newVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/**
 * No Buffer polyfill for the base64 step: OpenRouter's own sample uses one and
 * warns that it needs a bundler shim, while btoa is native and byte-identical.
 */
export async function challengeFor(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await sha256(verifier)))
}

/**
 * Exactly three params. There is no state, no client_id, no response_type and
 * no scope in this protocol, and there is no app to pre-register; the redirect
 * param is `callback_url`, not `redirect_uri`.
 */
export function authUrl(callbackUrl: string, challenge: string): string {
  const url = new URL('https://openrouter.ai/auth')
  url.searchParams.set('callback_url', callbackUrl)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.href
}

/**
 * sessionStorage, because the verifier has to outlive this page unloading and
 * loading again fresh after consent: an in-memory value dies with it and a
 * localStorage one outlives the tab. Same tab, because sessionStorage is
 * copied-then-diverged into anything window.open or target=_blank opens.
 */
export async function startPkce(): Promise<void> {
  const verifier = newVerifier()
  const url = authUrl(callbackUrl(), await challengeFor(verifier))
  sessionStorage.setItem(VERIFIER_KEY, verifier)
  location.assign(url)
}

let pending: Promise<string | null> | null = null

/**
 * Returns the minted key, or null on an ordinary boot with no ?code.
 *
 * Memoised rather than guarded-and-released: React 19's StrictMode invokes the
 * effect that calls this twice, and the code is single-use, so the second call
 * must join the first exchange instead of starting a second one against a
 * verifier that no longer exists.
 */
export function completePkce(): Promise<string | null> {
  return (pending ??= exchange())
}

async function exchange(): Promise<string | null> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code')

  if (!code) {
    // No deny contract is documented, so absence of ?code is simply the boot
    // case. If an ?error ever does appear, it is worth saying out loud.
    const denied = params.get('error')
    if (!denied) return null
    history.replaceState(null, '', callbackUrl())
    throw new Error(`Sign-in was refused: ${denied}`)
  }

  // Read here, not at the top: this runs on every page load, and sessionStorage
  // throws SecurityError outright when a browser is blocking site data. Doing it
  // before the `!code` return above rejected completePkce on an ordinary boot.
  let verifier: string | null = null
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY)
    // Both before the await: codes are single-use and expire in ten minutes, so
    // a reload mid-exchange must not be able to replay one.
    sessionStorage.removeItem(VERIFIER_KEY)
  } catch {
    // A blocked store reads as an absent verifier, and says so below.
  }
  history.replaceState(null, '', callbackUrl())
  if (!verifier) throw new Error('This sign-in was started in another tab. Connect again.')

  const response = await fetch(`${DEFAULT_BASE_URL}/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  })
  // text() then parse: one of the three failure bodies is text/plain, and json()
  // throws on it before anything can read the message.
  const body = await response.text()
  if (!response.ok) throw new Error(exchangeErrorMessage(body))

  let key: unknown
  try {
    key = (JSON.parse(body) as { key?: unknown } | null)?.key
  } catch {
    key = null
  }
  // Trust boundary: this string is about to be stored and sent as a bearer token.
  if (typeof key !== 'string' || !key.startsWith('sk-or-')) {
    throw new Error('Sign-in succeeded but returned no usable key.')
  }
  return key
}

/**
 * The status code is not a discriminator here: the guide documents 403 for a
 * bad code and 405 for a wrong method, and the live endpoint answers 400 and
 * 404. The message text is what is stable.
 */
export function exchangeErrorMessage(bodyText: string): string {
  const message = errorMessage(bodyText)
  return message === 'Invalid code'
    ? 'That sign-in code has expired or was already used. Connect again.'
    : `Sign-in failed: ${message}`
}

/** Revoke deep link. The key itself never leaves the browser to build it. */
export async function revokeUrl(key: string): Promise<string> {
  const hex = [...new Uint8Array(await sha256(key))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `https://openrouter.ai/keys/${hex}`
}

/**
 * http://localhost IS a secure context, but a LAN address like
 * http://192.168.1.5:5173 is not and crypto.subtle is undefined there. Hide the
 * PKCE button when this is false; paste-a-key still works.
 */
export function pkceAvailable(): boolean {
  return !!globalThis.crypto?.subtle
}
