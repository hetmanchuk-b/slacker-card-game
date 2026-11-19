-- Canonical creation identity belongs to an authenticated stable guest, never
-- to a bearer request ID. Retain with membership; expiry/revocation deletes none.
CREATE TABLE penky_lobby_creation_requests (
  session_id text NOT NULL,
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  lobby_id text NOT NULL UNIQUE,
  PRIMARY KEY (session_id, request_id),
  FOREIGN KEY (lobby_id, session_id) REFERENCES penky_lobby_members(lobby_id, session_id)
);
