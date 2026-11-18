import { createHash, randomBytes } from 'node:crypto';

export const GUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_COOKIE_NAME = '__Host-penky_guest';

/** Server-issued bearer secret, unrelated to stable SessionId or SeatId. */
export function createGuestToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Canonical encoding avoids alternate strings for the same secret. Null is a
 * technical authentication failure, never an invitation to adopt a session ID.
 */
export function guestTokenHash(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    return null;
  return createHash('sha256').update(value).digest('hex');
}

/** Secret belongs only in Set-Cookie over TLS, never a generic JSON payload. */
export function guestCookie(token: string): string {
  if (guestTokenHash(token) === null) throw new Error('Invalid guest credential');
  return `${GUEST_COOKIE_NAME}=${token}; Path=/; Max-Age=${GUEST_TTL_MS / 1000}; Secure; HttpOnly; SameSite=Lax`;
}
export function clearGuestCookie(): string {
  return `${GUEST_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
export function readGuestCookie(header: unknown): string | null {
  if (typeof header !== 'string' || header.length > 8192) return null;
  for (const character of header) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  let found: string | null = null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 0 || part.slice(0, equals).trim() !== GUEST_COOKIE_NAME) continue;
    if (found !== null) return null;
    const value = part.slice(equals + 1).trim();
    if (guestTokenHash(value) === null) return null;
    found = value;
  }
  return found;
}

/** Strict browser-origin admission helper, not authentication. Configuration is
 * server-owned. No wildcard, forwarded-header inference, or insecure cookie mode.
 */
export function allowedGuestOrigin(origin: unknown, configured: readonly string[]): boolean {
  if (typeof origin !== 'string' || origin.length > 2048 || !configured.includes(origin))
    return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.origin === origin;
  } catch {
    return false;
  }
}
