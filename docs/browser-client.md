# Browser client — Stage 9.1

## Implemented boundary

React/React DOM with Vite supplies a small English-language, client-rendered shell: explicit guest session confirmation, canonical lobby creation and own lobby/seat/owner identity. There is no joining, agreements UI, application Socket.IO connection, game start/table, chat, procedure/history UI, bot or Three.js implementation yet. The approved later increments are recorded in `IMPLEMENTATION_PLAN.md`.

The browser calls only existing same-origin HTTPS POST endpoints: empty-body guest refresh/issuance, then `/api/lobbies` with the exact creation key. `LobbyCreation` is the tested HTTP/storage seam; React handlers own user interaction rather than mount effects that could duplicate mutations. Its single-flight operation coalesces concurrent submits, while explicit subsequent confirmation reuses the original key.

Cookie credentials stay Secure/HttpOnly/SameSite=Lax in the browser cookie jar, never JavaScript storage or request identity fields. `sessionStorage` stores **only** `{ version: 1, requestId }` under `penky.lobby-creation.v1`. It contains no token, trusted seat, game state or observations. The key is saved after session authorization and before lobby dispatch, retained even after success so reload can explicitly confirm the original lobby. It is not a credential; cookie authentication still governs every request. Losing tab storage loses this retry locator; there is no discovery/recovery promise.

Fresh explicit creation refreshes first; only a 401 with **no saved lobby request** permits issuance. A named invalid cookie yields issuance conflict, not overwrite. A saved creation with missing/expired credentials never issues another guest to replay that reference under a new identity. Transport/network/timeout failures keep the key and expose fixed safe errors. Requests have a 15-second deadline, no automatic retry and no redirect following. Storage failure prevents an unrepeatable lobby dispatch. Unknown/extra membership response fields, invalid references and non-owner/nonzero creation identities are rejected, never displayed or logged raw.

## Loopback HTTPS development

The source-only development launcher composes:

```text
browser -> loopback HTTPS front door + Vite assets
        -> certificate-verified loopback HTTPS PenkyTransport for /api/
        -> existing PostgresGuestAccess/PostgresGameHost
```

The upstream preserves the browser's exact Origin and cookie; it does not enable forwarded-header trust, rewrite authorization, terminate into HTTP, disable upstream certificate validation or change existing business routes. Vite filesystem serving is restricted to client sources/node_modules; server sources are denied and no server environment variables are exposed by the frontend configuration. This is **not** a production proxy/deployment mode. Application Socket.IO proxying is deferred to 9.4; the development HMR socket is not game transport.

Requirements: Node 24+, npm, a separately migrated development PostgreSQL database, and developer-owned local TLS key/certificate with a SAN for `127.0.0.1`. Supply a CA chain when needed; for self-signed local certificates the same certificate is the default upstream CA. Do not put TLS keys or database credentials in client source or public environment variables.

Example in a shell with these environment variables already set:

```sh
# DATABASE_URL points to your intended development database.
# PENKY_DEV_TLS_KEY / PENKY_DEV_TLS_CERT point to your private local TLS files.
# PENKY_DEV_TLS_CA is optional for the upstream CA chain.
# PENKY_DEV_PORT is optional, defaults to 5173.
npm run db:migrate  # explicit operator action, never automatic in npm run dev
npm run dev
```

The launcher prints `https://127.0.0.1:5173` (or the configured port), uses bounded pool connection/statement timeouts, logs fixed errors without SQL/credentials and drains frontend/transport/host/pool on shutdown. It never installs certificates or runs migrations itself. Public test fixtures are **not** development credentials for valuable data or production.

## Build, typing and linting

`npm run build` preserves server JS/declarations in `dist/` and additionally builds browser assets in `dist/client/`. Development sources and client sources are excluded from server emission. Vite is not a production asset-hosting policy. No new server API, schema or persistence format is introduced.

`tsconfig.client.json` checks JSX/DOM code separately. Shared protocol DTO type references currently traverse server source types, so Node ambient declarations are available for type checking only; imports into the runtime browser bundle remain type-only. Client lint rules prohibit runtime imports of Node/server/runtime/persistence/engine/projector/message-builder implementations. No Redux/query framework or React refresh plugin is required by this slice. Format/lint/type gates include TSX, CSS, HTML, root browser configs and browser tests, not merely existing Node TS files.

## Verification

```sh
npm run check  # formatting, lint, server+client types, Node tests, both builds
# Confirm this is a disposable *_test database; suites may inject DB failures.
PENKY_TEST_DATABASE_URL=postgresql://.../penky_test npm run test:postgres
npx playwright install chromium
PENKY_TEST_DATABASE_URL=postgresql://.../penky_test npm run test:browser
```

Browser tests fail rather than silently skip if the disposable database variable is absent or lacks `_test`. The fixture uses real migrations, real PostgreSQL and actual HTTPS frontend/backend. Only its isolated headless browser contexts accept the public localhost test certificate; the upstream verifies its CA and global TLS verification/OS trust are never disabled. A server-injected clock tests expiry without a production time-control endpoint. Every test receives its own composition and isolated browser context; no private grants, SQL identity fixtures or cached seat authority drive the UI.

Six Node client tests cover canonical retry/reload, guest issuance conflict/error handling, lost original session, concurrent submissions, storage safety and response allowlisting. Nine Chromium tests cover real cookie flags/JavaScript invisibility, committed-response loss and reload, independent guests, server-side expiry, invalid retained cookie, storage denial, actual credential rate limits, exact Origin rejection/private source denial, keyboard activation and 360px layout. Explicit screenshots contain only own lobby identity; HTTP traces are off, cookie values are excluded from assertion diagnostics. CI's disposable PostgreSQL jobs install Chromium and run this separate browser gate after the existing checks.

These checks are not human assistive-technology acceptance, native mobile Safari/Firefox coverage, manual multiplayer play, browser game completion or production/security/load certification. The next increment is joining/restoring own membership (9.2), not agreements/gameplay or polished 3D.
