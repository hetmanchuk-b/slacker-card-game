CREATE TABLE penky_game_heads (
  game_id text PRIMARY KEY,
  root_branch_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  branch_id text NOT NULL,
  head_version integer NOT NULL DEFAULT 0 CHECK (head_version >= 0)
);

-- Immutable, versioned private frames: events/branches, active snapshot, receipts
-- and runtime metadata commit together. Retention/compaction is explicit later work.
CREATE TABLE penky_game_frames (
  game_id text NOT NULL REFERENCES penky_game_heads(game_id),
  revision bigint NOT NULL CHECK (revision > 0),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  payload jsonb NOT NULL,
  checksum text NOT NULL,
  PRIMARY KEY (game_id, revision)
);
