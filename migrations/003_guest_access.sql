-- Stable identity is retained after credential revocation/expiry. Never store
-- plaintext cookie tokens or cascade credential loss into lobby membership.
CREATE TABLE penky_guest_sessions (
  session_id text PRIMARY KEY CHECK (length(session_id) > 0),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  last_seen_at_ms bigint NOT NULL CHECK (last_seen_at_ms >= created_at_ms),
  expires_at_ms bigint NOT NULL CHECK (expires_at_ms > last_seen_at_ms AND expires_at_ms <= 9007199254740991),
  revoked_at_ms bigint CHECK (revoked_at_ms >= created_at_ms)
);

CREATE TABLE penky_lobby_members (
  lobby_id text NOT NULL REFERENCES penky_lobbies(lobby_id),
  session_id text NOT NULL REFERENCES penky_guest_sessions(session_id),
  seat_id text NOT NULL CHECK (length(seat_id) > 0),
  seat_index smallint NOT NULL CHECK (seat_index BETWEEN 0 AND 7),
  PRIMARY KEY (lobby_id, session_id),
  UNIQUE (lobby_id, seat_id),
  UNIQUE (lobby_id, seat_index)
);
