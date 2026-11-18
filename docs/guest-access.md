# Guest authentication and durable membership — Stage 8.5

D004 records the approved policy. These are **server-side libraries**, not running HTTP/Socket.IO endpoints. Existing lobby/storage APIs remain trusted internals; knowing a session ID, seat ID, display name or lobby code is not an authentication credential.

## Credential and cookie policy

`src/server/guest-session.ts` generates 32 random bytes using Node's CSPRNG, encoded as a canonical 43-character base64url bearer token. It is independent of the stable UUID `SessionId` and each lobby's seat IDs. PostgreSQL stores only SHA-256(token), not the raw token. A fast hash is appropriate for a random 256-bit secret; it is not password hashing. The hash itself is not an accepted cookie credential.

`guestCookie(token)` produces a persistent `__Host-penky_guest` cookie with `Path=/`, `Max-Age=2592000`, `Secure`, `HttpOnly` and `SameSite=Lax`, without Domain. `clearGuestCookie()` uses the same scope with Max-Age=0. Raw tokens belong only in Set-Cookie and incoming Cookie headers, never URLs, browser storage, logs or generic JSON/client/bot payloads. The returned issuance grant is server-private.

`readGuestCookie(header)` accepts exactly one canonical token under the exact cookie name, rejects duplicates/tossed cookies, controls and oversized headers, and never treats a stable session ID as a token. `allowedGuestOrigin(origin, configuredOrigins)` checks exact canonical HTTPS origins against a server-owned allowlist; missing/null, wildcard, credentials/path and insecure origins fail closed. SameSite is defense in depth, not a substitute for origin/CSRF protection. The later browser transport must apply origin checks to handshakes and state-changing cookie-authenticated requests, use no state-changing GET routes and enforce TLS; no insecure-cookie mode or forwarded-header trust is introduced here.

This follows the random-token, server-side verifier, Secure/HttpOnly/host-only cookie guidance in the [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The 30-day sliding lifetime is the approved Penky guest policy, not a recommendation for unrelated account/security contexts.

## Durable service

`PostgresGuestAccess(pool)` uses explicit pg/SQL, no ORM or new dependency. Call migrations explicitly before use:

- `issue(nowMs)` creates a fresh identity and commits a token hash before returning the private `{ token, expiresAtMs }` grant. It never adopts a supplied identity/credential.
- `authenticate(token, nowMs)` returns a server-private `{ sessionId, expiresAtMs }` binding or null. Successful authentication slides expiry by 30 days; exactly-expired or revoked credentials fail and cannot be refreshed. Concurrent older requests cannot shorten an already-extended expiry.
- `revoke(token, nowMs)` invalidates the credential durably. It does not delete its stable identity or membership, release seats, transfer ownership, or provide recovery/credential rotation for that identity. Clear the browser cookie separately.
- `createLobby(token, lobbyId, nowMs)` atomically creates the lobby's immutable owner binding and index-0 owner membership. The creation lobby ID is generated/canonicalized by the trusted host; a retry by that authenticated owner returns the original seat. An existing different owner is never overwritten.
- `joinLobby(token, lobbyId, nowMs)` authenticates, locks the lobby, returns an existing membership unchanged or appends the next clockwise seat. No caller-selected actor/owner/seat index is accepted.
- `membership(token, lobbyId, nowMs)` and `requireOwner(...)` reauthenticate and resolve membership/privilege from server records on every call. Their private context contains the session/seat binding, ordered seat roster, current game pointer and refreshed expiry. Never use a previously returned context as an enduring authorization capability or send it generically to clients.

Time is injected trusted **server wall time**, not a client timestamp or paused/rollbackable game clock. It must be a nonnegative safe millisecond integer with room for the expiry duration. Refresh and membership mutations commit together; rejected/failed operations do not publish a refresh, binding or partial membership. Issuance/auth storage failures and access failures use fixed errors without raw SQL, credentials or diagnostic causes. Hosts must attach a redacted pool error handler.

Authentication/identity loss is deliberately irreversible in this increment: losing or expiring a cookie loses that seat/owner access. A new credential is a new guest and cannot reclaim the old identity by name/code. Revoked/expired seats remain occupied. There is no implicit owner transfer, spectator admission, kicking, reassignment, recovery or account system.

## Admission and transaction ordering

`003_guest_access.sql` adds `penky_guest_sessions` and `penky_lobby_members`. Membership references stable identity and is unique per lobby/session, lobby/seat and lobby/index; indexes are constrained to 0–7. Owner is first, and later joins append in clockwise order. Index 0 is only seat ordering/identity, not the first dealing recipient or a turn hint; random dealing is unchanged. Credential loss does not cascade into membership removal.

Access transactions lock the credential row (shared with revocation), then the lobby row. New seats are allowed before any match is assigned, or after the current game is durably verified finished. Existing members may authenticate/reconnect while a game runs or the lobby is full. All other current-game states, including suspension and rollback before creation, keep the assigned match's admission gate closed; missing/corrupt/unknown durable state fails conservatively. Actual minigame gating remains Stage 11a work.

For a current game, new admission locks its game-head row, then reads that exact revision's frame on the same connection and validates checksum/recovered state/head consistency. The lobby→game-head order matches match transitions. This prevents a join from reading an old finished frame while a prior rollback is committing. Never wait for a runtime queue while holding these SQL locks.

A join that completes **before** a later rollback is a valid lobby admission, but it does not alter the old match's immutable roster. Transport/viewer binding must check current game participation as well as lobby membership; a newly joined lobby seat is not automatically a player or spectator in a restored old match.

Match preparation happens before its final lobby lock. `PostgresSession` therefore rechecks an authenticated lobby's ordered durable roster under the transition's lobby lock; a changed roster aborts the whole start transaction rather than silently omitting a member. It does not regenerate canonical start configuration. Existing start failure/recovery behavior remains: discard faulted drafts and recover the unchanged durable old game after a failed handoff transaction; do not reuse a failed prepared runtime/session. Legacy trusted lobbies with no membership rows retain their existing internal start behavior.

## Legacy data and later transport

No credentials or memberships are fabricated for old Stage 7 owner-session strings. Their trusted history/storage recovery still works, but the authenticated membership service does not adopt those lobbies by code or a newly issued token. Migrating such data requires a separately approved ownership/credential workflow.

No game/runtime/frame/receipt schema changes are introduced. Existing `PostgresLobby` methods still accept trusted server-owned identities and are **not authenticated public endpoints**. Future handlers must validate payloads, extract the cookie, check origin/session/membership and game participation, enforce owner privilege per administrative operation, and serialize evidence/selector/start admission with the appropriate authoritative queue/transaction. Revalidate credentials for subsequent operations and handle revocation/expiry for live sockets; this library does not close sockets, change runtime presence or cancel already-admitted work. Do not hold access transactions across queued runtime calls.

Cookie refresh must be emitted only after successful authentication/access; no raw issuance grant or private binding goes into `ServerMessage`. Stage 8.6 supplies a separate server-private committed subscription seam, not network delivery. Readiness/house rules, lobby UI, authenticated command routing, canonical creation/start retries, rate limits and committed network publication remain later work.

## Verification

- `src/server/guest-session.test.ts`: credential entropy/format/verifier, cookie flags/expiry, strict parsing and exact HTTPS-origin helpers. These do not prove browser cookie behavior.
- `src/server/guest-access.postgres.test.ts`: real disposable PostgreSQL, independent service instances and fresh Node recovery; concurrent capacity/uniqueness, expiry/revocation without seat release, original owner checks, creation failure atomicity, running/finished/pre-creation admission, durable rollback locking, stale-roster start rejection and corrupt-frame denial.
- `npm run test:postgres` now includes this suite alongside durable-runtime and lobby suites. Only run it on a confirmed disposable database; see `docs/postgres.md`.

No browser, TLS handshake or Socket.IO verification is claimed.
