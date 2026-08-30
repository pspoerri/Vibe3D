import { expect, test } from 'vitest'
import {
  authUrl,
  challengeFor,
  exchangeErrorMessage,
  newVerifier,
  pkceAvailable,
  revokeUrl,
} from './auth'

/**
 * RFC 7636 Appendix B's vector, which is also OpenRouter's own OpenAPI example.
 * One pair pins the whole S256 chain: UTF-8 bytes, SHA-256, base64url.
 */
test('derives the RFC 7636 Appendix B challenge', async () => {
  expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  )
})

/**
 * A `+`, `/` or `=` reaching the wire is rejected by the authorize endpoint, and
 * a `=` is silently eaten by a query string. 32 samples make the two byte
 * patterns that produce `+` and `/` a near-certainty rather than a coin flip.
 */
test('emits only the base64url alphabet, never padded base64', async () => {
  const seen = new Set<string>()
  for (let i = 0; i < 32; i++) {
    const verifier = newVerifier()
    seen.add(verifier)
    // Also RFC 7636's unreserved charset and its 43–128 length window.
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/)
    expect(await challengeFor(verifier)).toMatch(/^[A-Za-z0-9\-_]{43}$/)
  }
  expect(seen.size).toBe(32)
})

test('builds the auth URL with exactly the three params the protocol has', () => {
  const url = new URL(authUrl('https://app.example/modeller/', 'CHALLENGE'))
  expect(url.origin + url.pathname).toBe('https://openrouter.ai/auth')
  // No state, no client_id, no response_type, no scope: none exist here, and the
  // redirect param is callback_url, not redirect_uri.
  expect([...url.searchParams.keys()]).toEqual([
    'callback_url',
    'code_challenge',
    'code_challenge_method',
  ])
  expect(url.searchParams.get('callback_url')).toBe('https://app.example/modeller/')
  expect(url.searchParams.get('code_challenge')).toBe('CHALLENGE')
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
})

/**
 * The three bodies below are what the exchange endpoint really answers, pasted
 * verbatim. The status codes it pairs them with are NOT the documented ones
 * (400 and 404, not 403 and 405), which is why the text is the discriminator.
 */
test('turns the "Invalid code" body into an instruction the user can act on', () => {
  expect(exchangeErrorMessage('{"error":{"message":"Invalid code","code":400}}')).toBe(
    'That sign-in code has expired or was already used. Connect again.',
  )
})

test('unwraps the ZodError envelope instead of showing the raw issue array', () => {
  const body =
    '{"success":false,"error":{"name":"ZodError","message":"[\\n  {\\n    \\"expected\\": \\"string\\",\\n    \\"code\\": \\"invalid_type\\",\\n    \\"path\\": [\\n      \\"code\\"\\n    ],\\n    \\"message\\": \\"Invalid input: expected string, received undefined\\"\\n  }\\n]"}}'
  expect(exchangeErrorMessage(body)).toBe(
    'Sign-in failed: Invalid input: expected string, received undefined',
  )
})

test('survives the text/plain body that response.json() would throw on', () => {
  expect(exchangeErrorMessage('Malformed JSON in request body')).toBe(
    'Sign-in failed: Malformed JSON in request body',
  )
})

test('deep-links to the key page by lowercase sha256 hex', async () => {
  expect(await revokeUrl('sk-or-v1-test')).toBe(
    'https://openrouter.ai/keys/ea3c6d86042520298bfbda076e3abd13fc98b17835dd1dabd43f83bcff4f9971',
  )
})

/** http://localhost is a secure context; http://192.168.1.5:5173 is not. */
test('reports the capability an insecure origin is missing', () => {
  expect(pkceAvailable()).toBe(true)
})
