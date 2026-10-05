# angel-mortal-bot

An anonymous relay Telegram bot for the **E Block Angel & Mortal** event.

Every participant has:
- a **Mortal**: someone they know, and secretly welfare
- an **Angel**: someone secret, who welfares them

The bot lets each participant chat with both through one bot. Messages are re-sent by the bot itself, so **the angel's identity is never revealed**.

> **Status:** in development, not yet deployable. See the progress tracker in [docs/PLAN.md](docs/PLAN.md).

## Features
- Anonymous two-way chat with your Angel and your Mortal, switched with a single button
- All message types: text, photos, videos, GIFs, stickers, voice notes, files, locations
- Telegram **Reply** works. A reply goes back to whoever sent that message, and both sides see it threaded.
- A 👍 reaction confirms delivery, and you get a clear warning when the other person hasn't joined yet
- Admin tools:
  - upload and validate the pairings list
  - see who hasn't joined
  - check status
  - pause or resume relaying
  - fix a participant's handle

## Tech stack
| Part | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (free tier) | Always on, no cold starts, no credit card needed |
| Database | Cloudflare D1 (SQLite) | Free, built in, and plenty for about 60 users |
| Bot framework | [grammY](https://grammy.dev) (TypeScript) | First-class Workers support |
| Telegram delivery | Webhook | No server process to keep alive |

## Documentation
📖 **Docs website:** <https://chee-yew.github.io/angel-mortal-bot/> (GitHub Pages, built from `docs/`)

| Doc | For |
|---|---|
| [User Guide](docs/USER_GUIDE.md) | Participants (how to chat) and organisers (admin commands) |
| [Developer Guide](docs/DEVELOPER_GUIDE.md) | Architecture, local setup, deployment, troubleshooting |
| [Plan](docs/PLAN.md) | Design decisions and build progress |

## Quick start (deploy)
The [Developer Guide](docs/DEVELOPER_GUIDE.md#deployment) has every step explained. In short:
```bash
npm install
npx wrangler login
npx wrangler d1 create angel-mortal          # paste the id into wrangler.toml
npx wrangler d1 execute angel-mortal --remote --file=schema.sql
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler deploy
```
Then register the webhook. Message the bot `/myid`, put your ID in `ADMIN_IDS` in `wrangler.toml` and redeploy. Finally, `/upload` the pairings.

## Project structure
```
src/
  index.ts      Worker entry: webhook + cron           (coming in step 9)
  bot.ts        Commands, admin tools, relay logic
  db.ts         Typed D1 queries
  pairings.ts   Pairing list parser + validation
test/           Node tests (npm test)
schema.sql      D1 tables
wrangler.toml   Cloudflare config
docs/           Plan, user guide, developer guide
```

## Privacy
- Real pairing lists are **never committed**: `*.csv` is git-ignored, except `pairings.example.csv`.
- The bot token and webhook secret are stored only as Cloudflare secrets.
- Keep this repository **private**.
