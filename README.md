# Operador by Open Doors

Automated DCA trading over small-cap crypto on Solana.

> **It runs in PAPER mode today, and only paper mode.** Live trading is
> refused by `loadConfig`, not by convention: no wallet adapter exists, and
> nothing in this repository can sign a transaction or move a token. You can
> run it for weeks without a cent at risk.

## What is real in paper mode, and what is not

| | Real | Simulated |
|---|---|---|
| Token discovery | ✅ Jupiter + DexScreener, live | |
| Safety gates | ✅ GoPlus + Jupiter audit, live | |
| **Honeypot test** | ✅ a real sell quote against the pool | |
| Price candles | ✅ GeckoTerminal 1H, live | |
| Strategy decisions | ✅ the same code that reproduces your TradingView backtest | |
| Death watch | ✅ real sell probes against real pools | |
| Fills | | ⚠️ simulated, paying real spread + measured impact + gas |
| Money | | ⚠️ none. No wallet is ever touched |

Everything that DECIDES is real. Only the part that SPENDS is simulated — and
it is simulated pessimistically: a round trip at a flat price loses money,
because on a real chain it would.

## Run it

```bash
cp .env.example .env        # fill in DATABASE_URL and the Telegram pair
docker compose up -d --build
```

You need three free things:

1. **Postgres** — [Supabase](https://supabase.com) or [Neon](https://neon.tech), free tier.
2. **A Telegram bot** — talk to `@BotFather`, then get your chat id from
   `@userinfobot`. That chat id is the ONLY one the bot will obey.
3. **A box** — Oracle Cloud Always Free (ARM), or anything that runs Docker.
   Your own machine is fine for a first run.

Nothing else needs an API key. DexScreener, GoPlus, Jupiter and GeckoTerminal
are all used through their public endpoints.

## Watching it

- **Telegram** — `/status`, `/positions`, `/stop`, `/start`
- **Dashboard** — `cd dashboard && vercel`, read-only
- **Alerts** — death exits, halted positions and the kill switch arrive
  unthrottled; everything else is rate-limited so the ones that matter are not
  buried

## Before any real money

The engine refuses live mode until a wallet adapter is built AND reviewed. When
that day comes, the order is: paper for weeks → read the numbers → a small
amount → scale. Not the other way around.

Two measured facts worth knowing first:

- **Below roughly $50 the system cannot trade at all.** Not "does badly" —
  places zero orders, because the ladder cannot clear the gas floor.
- **Above a pool's capacity, more capital does nothing.** Scale comes from more
  positions, not bigger ones.

See `CLAUDE.md` for the full design, the measurements behind those numbers, and
the decisions they came from.
