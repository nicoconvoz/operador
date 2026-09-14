# Operador by Open Doors — dashboard

Read-only view of what the engine is doing. Deploys to Vercel's Hobby tier.

## Why it is read-only

It shares a database with the engine and nothing else. There is no write path
in this app at all: no order can be placed from here, no position closed, no
switch thrown. A dashboard that could trade would be a second attack surface on
the money, guarded by a URL people paste into chats.

The kill switch lives in Telegram precisely because that channel is
authenticated to one chat id.

## Setup

Set `DATABASE_URL` in the Vercel project — **the read-only credential**, not
the one the engine uses. Then deploy:

```bash
cd dashboard && vercel
```

## Numbers

Every figure comes from `buildDashboard` in the engine's application layer,
not from queries written here. Two implementations of "how much are we up"
will eventually disagree, and the one on the screen is the one you will
believe.
