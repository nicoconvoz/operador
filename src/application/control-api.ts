/**
 * Authorisation for the one write path in the whole system.
 *
 * The dashboard is read-only by design: no order can be placed from it, no
 * position closed. The single exception is the kill switch, and it earns that
 * exception by only ever making the system SAFER — it stops new positions and
 * can never open one. A control surface that could trade would be a second
 * attack surface on the money, guarded by a URL people paste into chats.
 *
 * Every rule here fails closed. An unconfigured token refuses rather than
 * allows, because "we forgot to set it" and "anyone may stop the engine" must
 * not be the same state.
 */

/** Short enough to type once into a phone, long enough not to be guessed. */
export const MIN_TOKEN_LENGTH = 24

export type ControlVerdict = { readonly ok: true } | { readonly ok: false; readonly status: 401 | 503; readonly reason: string }

const DENIED: ControlVerdict = { ok: false, status: 401, reason: 'not authorised' }

/**
 * Constant-time for equal-length strings, and length is compared separately —
 * a plain `===` on a secret returns as soon as it finds a differing byte,
 * which over enough requests tells an attacker how much of the prefix is right.
 */
const secretsMatch = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export function authoriseControl(
  configured: string | undefined,
  presented: string | null,
  options: { readonly fromHeader?: boolean } = {},
): ControlVerdict {
  if (!configured || configured.length < MIN_TOKEN_LENGTH) {
    return { ok: false, status: 503, reason: 'control token is not configured' }
  }
  if (presented === null) return DENIED

  const offered = options.fromHeader ? bearer(presented) : presented
  if (offered === null) return DENIED

  return secretsMatch(configured, offered) ? { ok: true } : DENIED
}

/** `Authorization: Bearer <token>` — anything else is not a credential. */
const bearer = (header: string): string | null => {
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match ? match[1]! : null
}
