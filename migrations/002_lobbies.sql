CREATE TABLE penky_lobbies (
  lobby_id text PRIMARY KEY,
  owner_session_id text NOT NULL,
  owner_seat_id text NOT NULL,
  current_game_id text REFERENCES penky_game_heads(game_id)
);

CREATE TABLE penky_lobby_chat (
  sequence bigserial PRIMARY KEY,
  lobby_id text NOT NULL REFERENCES penky_lobbies(lobby_id),
  message_id text NOT NULL,
  author_session_id text NOT NULL,
  author_seat_id text,
  body text NOT NULL,
  at_ms bigint NOT NULL CHECK (at_ms >= 0),
  context jsonb NOT NULL,
  UNIQUE (lobby_id, message_id)
);
CREATE INDEX penky_lobby_chat_page ON penky_lobby_chat(lobby_id, sequence);

CREATE TABLE penky_match_starts (
  lobby_id text NOT NULL REFERENCES penky_lobbies(lobby_id),
  command_id text NOT NULL,
  request jsonb NOT NULL,
  game_id text NOT NULL UNIQUE REFERENCES penky_game_heads(game_id),
  PRIMARY KEY (lobby_id, command_id)
);
