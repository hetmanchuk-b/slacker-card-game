import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  createGuestToken,
  guestTokenHash,
  guestCookie,
  clearGuestCookie,
  readGuestCookie,
  allowedGuestOrigin,
  GUEST_COOKIE_NAME,
  GUEST_TTL_MS,
} from './guest-session.ts';

test('guest credentials contain 256 random bits independently of stable identities and store a verifier only', () => {
  const tokens = Array.from({ length: 100 }, () => createGuestToken());
  assert.equal(new Set(tokens).size, 100);
  for (const token of tokens) {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(token, 'base64url').length, 32);
    assert.equal(guestTokenHash(token), createHash('sha256').update(token).digest('hex'));
    assert.notEqual(guestTokenHash(token), token);
  }
  for (const token of [
    undefined,
    null,
    '',
    'session-id',
    'A'.repeat(44),
    'A'.repeat(42) + 'B',
    'A'.repeat(42) + '\0',
  ]) {
    assert.equal(guestTokenHash(token), null);
  }
});

test('persistent guest cookie is host-only Secure HttpOnly SameSite=Lax for exactly thirty days', () => {
  const token = createGuestToken();
  assert.equal(GUEST_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  assert.equal(
    guestCookie(token),
    `${GUEST_COOKIE_NAME}=${token}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.equal(
    clearGuestCookie(),
    `${GUEST_COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
  );
  assert.throws(() => guestCookie('SECRET\r\nInjected: yes'), {
    message: 'Invalid guest credential',
  });
});

test('cookie parsing accepts one exact canonical token and rejects duplicate/tossed or malformed credentials', () => {
  const token = createGuestToken();
  assert.equal(readGuestCookie(`other=value; ${GUEST_COOKIE_NAME}=${token}; another=x`), token);
  for (const header of [
    undefined,
    [],
    '',
    `${GUEST_COOKIE_NAME}=session-id`,
    `${GUEST_COOKIE_NAME}="${token}"`,
    `${GUEST_COOKIE_NAME}=${token}; ${GUEST_COOKIE_NAME}=${token}`,
    `${GUEST_COOKIE_NAME}=${token}\r\nX: secret`,
    'x'.repeat(8193),
  ]) {
    assert.equal(readGuestCookie(header), null);
  }
  assert.equal(readGuestCookie(`forged${GUEST_COOKIE_NAME}=${token}`), null);
});

test('origin validation is an exact configured HTTPS-origin check, not a wildcard or cookie substitute', () => {
  const origins = ['https://penky.example', 'https://localhost:8443'];
  for (const origin of origins) assert.equal(allowedGuestOrigin(origin, origins), true);
  for (const origin of [
    undefined,
    'null',
    'http://penky.example',
    'https://penky.example.evil',
    'https://penky.example/',
    'https://user@penky.example',
    'https://penky.example/path',
    'https://penky.example\r\nX: secret',
    '*',
  ]) {
    assert.equal(allowedGuestOrigin(origin, origins), false);
  }
  assert.equal(allowedGuestOrigin('http://localhost:8080', ['http://localhost:8080']), false);
});
