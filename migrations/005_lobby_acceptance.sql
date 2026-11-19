-- Acceptance epoch changes only when prior consent is invalidated, never on an
-- individual member's acceptance update. Existing members are NOT auto-accepted.
ALTER TABLE penky_lobbies
  ADD COLUMN agreement_text text NOT NULL DEFAULT '' CHECK (octet_length(agreement_text) <= 4096),
  ADD COLUMN agreement_revision bigint NOT NULL DEFAULT 0 CHECK (agreement_revision >= 0);
ALTER TABLE penky_lobby_members ADD COLUMN accepted boolean NOT NULL DEFAULT false;

-- Immutable-by-adapter match binding, independent of later lobby edits/rollback.
-- Historical matches intentionally have no fabricated binding.
CREATE TABLE penky_match_agreements (
  game_id text PRIMARY KEY REFERENCES penky_game_heads(game_id),
  lobby_id text NOT NULL REFERENCES penky_lobbies(lobby_id),
  agreement_revision bigint NOT NULL CHECK (agreement_revision >= 0),
  agreement_text text NOT NULL CHECK (octet_length(agreement_text) <= 4096)
);
