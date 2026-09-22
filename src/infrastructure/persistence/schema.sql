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
  last_price_usd NUMERIC,
  -- Orders decided but not yet confirmed. The field recovery depends on.
  pending_orders JSONB       NOT NULL DEFAULT '[]'::jsonb,
  opened_at      BIGINT      NOT NULL,
  updated_at     BIGINT      NOT NULL
);

CREATE INDEX IF NOT EXISTS positions_token_idx ON positions (chain, token_address);

-- The break-even ratchet: this position has been at its profit target, so it
-- may never close at a loss again. Added to a table that already holds money,
-- hence ADD COLUMN IF NOT EXISTS rather than a column in the CREATE above —
-- it has to land on a live database without a truncate, and run as a no-op on
-- every boot after that. The upsert keeps it with OR, so once true it stays.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS break_even_armed BOOLEAN NOT NULL DEFAULT false;

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

-- The alert log — what replaced the Telegram pipe.
--
-- A pipe delivers to whoever is listening and forgets the rest; a phone that
-- was off missed the death exit entirely. A LOG lets a client read from a
-- cursor and catch up, so being asleep costs latency rather than the message.
--
-- `seq` is a BIGSERIAL and not the timestamp, because two alerts can share a
-- millisecond and a timestamp cursor would then have to choose between
-- skipping one and replaying it forever.
CREATE TABLE IF NOT EXISTS alerts (
  seq   BIGSERIAL PRIMARY KEY,
  kind  TEXT   NOT NULL,
  level TEXT   NOT NULL CHECK (level IN ('info', 'warn', 'critical')),
  at    BIGINT NOT NULL,
  title TEXT   NOT NULL,
  body  TEXT   NOT NULL,
  data  JSONB
);

CREATE INDEX IF NOT EXISTS alerts_level_idx ON alerts (level, seq);

-- How much history a pool has, so we stop asking.
--
-- Counting a pool's bars costs a full candle download — a thousand rows to
-- learn one integer — and it was 80% of a cycle's wall time in rate-limit
-- backoff. What makes caching it CORRECT rather than merely convenient is that
-- a pool cannot lose candles: once it has enough for the strategy, it has
-- enough forever. Only a short count can change, so only a short count expires.
-- Which pools exist on a chain, so discovery stops running every hour.
--
-- Ten throttled GeckoTerminal calls per chain, and after the candle downloads
-- were cached it became most of what a scan costs — about half an hour, during
-- which the engine is not watching the positions that already hold money.
--
-- Unlike a candle count a discovery list genuinely changes, so it expires. The
-- window is not a guess about how fast the market moves: a pool younger than it
-- CANNOT clear the history gate anyway, which wants 250 bars — 2.6 days at 15m.
CREATE TABLE IF NOT EXISTS pool_discovery (
  chain         TEXT   PRIMARY KEY,
  pools         JSONB  NOT NULL,
  discovered_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS pool_history (
  chain        TEXT   NOT NULL,
  pool_address TEXT   NOT NULL,
  bars         INT    NOT NULL,
  measured_at  BIGINT NOT NULL,
  PRIMARY KEY (chain, pool_address)
);

-- Pools this engine could not see trading. Only the NEGATIVE verdict is kept:
-- caching "alive" would cache the one answer that can turn between the scan and
-- the moment capital moves, while caching "dead" risks a missed opportunity —
-- and the entry confirmation asks again, live, before anything is bought.
CREATE TABLE IF NOT EXISTS pool_quiet (
  chain        TEXT   NOT NULL,
  pool_address TEXT   NOT NULL,
  measured_at  BIGINT NOT NULL,
  PRIMARY KEY (chain, pool_address)
);

-- What the expensive security pass found, so the budget can rotate.
--
-- Each examined token costs five throttled network calls, so a cycle can only
-- afford a couple of dozen. Without a memory the same highest-scoring tokens
-- were re-examined every fifteen minutes and everything below the cut waited
-- forever: 106 tokens sat permanently "sin revisar" in production.
--
-- Short-lived on purpose. The honeypot answer inside a report is the one that
-- ages worst, which is why a cached report keeps a token ELIGIBLE but never
-- gets it traded: the sell path is re-confirmed before a position opens.
CREATE TABLE IF NOT EXISTS token_security (
  chain        TEXT   NOT NULL,
  address      TEXT   NOT NULL,
  security     JSONB  NOT NULL,
  slippage_pct NUMERIC,
  measured_at  BIGINT NOT NULL,
  PRIMARY KEY (chain, address)
);

-- Every token this engine has ever priced, kept FOREVER.
--
-- The operator's idea, and it answers the constraint the whole scanner ran
-- into: the free providers cap discovery at about 570 tokens a sweep, and no
-- threshold can widen that. Ten pages is GeckoTerminal's ceiling (page eleven
-- answers 401), Jupiter's lists cap at 100 each, and DexScreener's boosts are
-- paid promotions. The only lever left is TIME — a registry accumulates what
-- every sweep found, so a week of scans knows far more than any one of them.
--
-- NEVER PRUNED, and that is the operator's instruction in as many words. Every
-- other cache in this file expires or is truncated because it is an
-- optimisation; this one is the memory the discovery providers do not have.
--
-- The market columns are the snapshot as last seen. They are NOT read as
-- current — every scan re-prices what it intends to examine — they are here so
-- the registry can be ORDERED by last-known activity, because reading it whole
-- would cost one DexScreener call per thirty rows and the point is to reach
-- further, not to spend more.
CREATE TABLE IF NOT EXISTS solana_cache (
  contract     TEXT   NOT NULL PRIMARY KEY,
  token        TEXT   NOT NULL,
  pool         TEXT,
  price        NUMERIC,
  volume24h    NUMERIC,
  liquidity    NUMERIC,
  market_cap   NUMERIC,
  txns         INTEGER,
  last_update  BIGINT NOT NULL
);

-- Ordered by what was moving, so a bounded read reaches the ones worth
-- re-pricing first rather than whichever row the table happens to return.
CREATE INDEX IF NOT EXISTS solana_cache_activity ON solana_cache (volume24h DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS solana_cache_seen ON solana_cache (last_update DESC);
