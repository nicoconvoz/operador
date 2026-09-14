-- Operador by Open Doors — durable state.
--
-- Runs on any Postgres (Supabase and Neon free tiers included). Designed so a
-- restart can reconstruct the engine exactly, and so no retry can ever write
-- the same thing twice.

CREATE TABLE IF NOT EXISTS positions (
  id             TEXT PRIMARY KEY,
  chain          TEXT        NOT NULL,
  token_address  TEXT        NOT NULL,
  pair_address   TEXT        NOT NULL,
  symbol         TEXT        NOT NULL,
  -- The state machine, the death watch and the market quality, verbatim.
  -- Stored as JSON on purpose: these are domain types that will keep evolving,
  -- and a column per field would turn every strategy change into a migration.
  cascade        JSONB       NOT NULL,
  death_watch    JSONB       NOT NULL,
  quality        JSONB       NOT NULL,
  capital_usd    NUMERIC     NOT NULL,
  last_bar_time  BIGINT      NOT NULL,
  -- Orders decided but not yet confirmed. The field recovery depends on.
  pending_orders JSONB       NOT NULL DEFAULT '[]'::jsonb,
  opened_at      BIGINT      NOT NULL,
  updated_at     BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS positions_token_idx ON positions (chain, token_address);

-- Fills are keyed by the CLIENT's idempotency key, not by a serial id.
-- That primary key is what makes a retry after an ambiguous network failure
-- safe: the second write collides instead of buying twice.
CREATE TABLE IF NOT EXISTS fills (
  idempotency_key TEXT PRIMARY KEY,
  position_id     TEXT    NOT NULL,
  order_id        TEXT    NOT NULL,
  side            TEXT    NOT NULL CHECK (side IN ('buy', 'sell')),
  time            BIGINT  NOT NULL,
  price           NUMERIC NOT NULL,
  qty             NUMERIC NOT NULL,
  cost_usd        NUMERIC NOT NULL,
  comment         TEXT    NOT NULL
);

-- Deliberately NOT a foreign key to positions: fills outlive the position they
-- belong to. A closed position is removed from the working set, and its trade
-- history has to survive that.
CREATE INDEX IF NOT EXISTS fills_position_idx ON fills (position_id, time);

CREATE TABLE IF NOT EXISTS scans (
  scanned_at BIGINT PRIMARY KEY,
  chain      TEXT   NOT NULL,
  snapshots  JSONB  NOT NULL
);

-- One row, always. `singleton` exists so an UPSERT can target it by name and
-- there is no way to end up with two disagreeing checkpoints.
CREATE TABLE IF NOT EXISTS checkpoint (
  singleton           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  saved_at            BIGINT  NOT NULL,
  last_completed_bar  BIGINT  NOT NULL,
  kill_switch_engaged BOOLEAN NOT NULL DEFAULT FALSE
);

-- A death exit is terminal, so this table is append-only by convention and the
-- writer never updates an existing row: the FIRST verdict is the one kept.
CREATE TABLE IF NOT EXISTS blacklist (
  chain         TEXT   NOT NULL,
  token_address TEXT   NOT NULL,
  reason        TEXT   NOT NULL,
  at            BIGINT NOT NULL,
  PRIMARY KEY (chain, token_address)
);
