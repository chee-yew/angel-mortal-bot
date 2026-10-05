# Developer Guide

Contents:
- [Architecture](#architecture)
- [How a message is relayed](#how-a-message-is-relayed)
- [Broadcasts](#broadcasts)
- [Data model](#data-model)
- [Code tour](#code-tour)
- [Local development](#local-development)
- [Deployment](#deployment)
- [Customising for your event](#customising-for-your-event)
- [Operations](#operations)
- [Free-tier limits](#free-tier-limits)
- [Troubleshooting](#troubleshooting)
- [Git workflow](#git-workflow)

---

## Architecture

```
Telegram ──HTTPS POST (webhook)──▶ Cloudflare Worker ──▶ grammY bot ──▶ D1 (SQLite)
   ▲                                     │
   └──────── Bot API calls ◀─────────────┘
              (sendMessage / copyMessage)
```

- **No long-running server.** Telegram POSTs each update to the Worker's `/webhook` URL. The Worker handles it and exits.
- **Webhook security.** Telegram sends the header `X-Telegram-Bot-Api-Secret-Token` with every update. `src/index.ts` returns `401` for any request where it doesn't match `WEBHOOK_SECRET`, **before** creating the bot. Otherwise grammY would call Telegram's `getMe` first, so a random request could make the bot call Telegram.
- **Routes:**

  | Route | Purpose |
  |---|---|
  | `POST /webhook` | Telegram updates |
  | `GET /setup?key=<secret>` | One-click webhook and command-menu setup |
  | `GET /` | Health check ("…is running") |

- **Cron** (`* * * * *` in `wrangler.toml`) calls `scheduled()`, which drains the broadcast queue.
- **Anonymity** comes from `copyMessage`. Unlike `forwardMessage`, it creates a brand-new message from the bot, with no "Forwarded from" header.
- **Never-fail webhook.** The first middleware in `createBot` catches and logs every error. The webhook therefore always returns 200, so Telegram never retries the same update in a loop.

## How a message is relayed

1. `resolve()` identifies the sender:
   - first by Telegram `user_id`, which survives username changes
   - otherwise by `@username`, which is then bound to their `user_id`/`chat_id` on first contact
2. If relaying is paused, the bot stops here and tells the sender.
3. The bot picks the destination:
   - **If the message is a Reply** to a relayed message, it looks up `msg_map` and sends to the original sender. It ignores the mapping if pairings have changed since.
   - **Otherwise** it uses the sender's current `target` (`angel` | `mortal`) and looks up the partner in `pairings`.
4. `deliver()` sends the message with a bold label ("😇 From your Angel" / "🙂 From your Mortal"):

   | Message type | How the label is attached |
   |---|---|
   | Text | Prepended to the text. Entities (bold, links…) are shifted by the label length in UTF-16 units, which is how Telegram counts. |
   | Photo, video, GIF, document, audio, voice | Copied with the label prepended to the caption |
   | Sticker, video note, location, or text/caption over the length limit | Label sent as its own message, then the original copied |

5. Every message id created in the recipient's chat goes into `msg_map`, so replies can be routed back.
6. The bot reacts 👍 on the sender's message.

   | Error | What the sender is told |
   |---|---|
   | 403 (recipient blocked the bot) | "not delivered" |
   | 400 (unsupported message type) | "can't relay this kind of message" |

## Broadcasts

The free Workers plan allows only **50 outgoing requests per invocation**, and each Telegram message is one request. So `/broadcast` can't message 60 people in a single go:

1. `/broadcast` inserts one `broadcast_queue` row per joined participant in a single `INSERT … SELECT`.
2. It immediately drains up to **25** (`BROADCAST_INLINE_BATCH`).
3. The **cron trigger** runs every minute and drains up to **40** (`BROADCAST_CRON_BATCH`), until the queue is empty.

Draining goes through `drainBroadcastQueue()` in `bot.ts`:
- It **claims** rows with `DELETE … RETURNING`, so two drains running at the same moment can never send someone the same message twice.
- On **429** (rate limited), the unsent rows are put back for the next run.
- On any other error (the person blocked the bot, or deleted their account), the row is dropped and the error logged.

## Data model

Defined in [`schema.sql`](https://github.com/chee-yew/angel-mortal-bot/blob/main/schema.sql):

| Table | Purpose |
|---|---|
| `participants` | `handle` (lowercase, PK), `user_id`/`chat_id` (null until /start), `target`, `joined_at` |
| `pairings` | `angel_handle` (PK) → `mortal_handle` (unique) |
| `msg_map` | `(recipient_chat_id, recipient_msg_id)` → original sender, their role relative to the recipient, and the source message, for reply routing |
| `settings` | key/value pairs, currently `paused` |
| `broadcast_queue` | Pending `/broadcast` deliveries, one row per recipient. See [Broadcasts](#broadcasts). |

`participants` is derived from `pairings` on every `/upload`:
- new handles are inserted
- handles no longer on the list are deleted
- existing rows, and therefore join status, are kept

## Code tour

| File | What's in it |
|---|---|
| [`src/pairings.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/pairings.ts) | `parsePairings()` turns raw text into `{pairs, errors, warnings}`. Pure, no I/O, and unit-tested. |
| [`src/db.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/db.ts) | `Db` class. Every SQL query lives here. |
| [`src/bot.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/bot.ts) | `createBot(env)`: participant commands, admin commands, then the relay handler, which **must stay last** because it catches every message. Also `deliver()`. |
| [`src/index.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/index.ts) | Worker entry. `fetch()` handles `/webhook` (secret check, then grammY), `/setup` (webhook and command menus) and `/` (health check); `scheduled()` is the cron that drains broadcasts. The bot instance is cached per isolate, so `getMe` runs once rather than on every update. |

Conventions:
- **Handles:** always lowercase with no `@`. Normalise any input with `normaliseHandle()`.
- **Bot replies:** plain text with no `parse_mode`, so underscores in usernames can't break Markdown.
- **Admin commands:** registered on `pm.filter(isAdmin)`. Non-admins fall through to "Unknown command".
- **D1 limits:** at most **100 bound parameters per statement**, which is why `replacePairings` inserts in chunks of 50. Keep each update to a handful of queries.

## Local development

Prerequisites: Node.js 22.6+ (the tests use its built-in TypeScript support) and a **separate test bot** from @BotFather, so you never test on the live bot.

```bash
npm install
npm test               # pairing parser tests
npm run typecheck      # tsc --noEmit
```

To run the bot locally:
1. Create `.dev.vars`. It's git-ignored.
   ```
   BOT_TOKEN=<test bot token>
   WEBHOOK_SECRET=<any random string>
   ```
2. Create the local database:
   ```bash
   npx wrangler d1 execute angel-mortal --local --file=schema.sql
   ```
3. Start the Worker:
   ```bash
   npm run dev
   ```
4. Expose it publicly so Telegram can reach it:
   ```bash
   npx cloudflared tunnel --url http://localhost:8787
   ```
5. Open `<tunnel-url>/setup?key=<your WEBHOOK_SECRET>` to point the test bot at your machine.

To test the cron locally, run `npx wrangler dev --test-scheduled` and open `http://localhost:8787/__scheduled`.

To test properly you need **at least 3 Telegram accounts** in a cycle A→B→C→A. Ask friends to help, or use the Telegram Desktop multi-account feature.

## Deployment

### 1. Create the bot
In Telegram, open **@BotFather** → `/newbot` → pick a name and a username → copy the **token**. Optional:
- `/setdescription`
- `/setuserpic`
- `/setjoingroups` → **Disable**, since the bot is for private chats only

### 2. Cloudflare account
Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough and no card is needed.

### 3. Get the code and log in
Prerequisite: Node.js 22.6 or newer.
```bash
git clone https://github.com/chee-yew/angel-mortal-bot.git
cd angel-mortal-bot
npm install
npx wrangler login
```

### 4. Create the database
```bash
npx wrangler d1 create angel-mortal
```
Copy **only** the printed `database_id` into `wrangler.toml`. The id isn't secret, so it's fine to commit it. Keep `binding = "DB"`: Wrangler suggests a different binding name (`angel_mortal`), but the code reads `env.DB`. Then create the tables:
```bash
npx wrangler d1 execute angel-mortal --remote --file=schema.sql
```

### 5. Secrets
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```
For `WEBHOOK_SECRET`, generate a random value. It may only contain `A–Z a–z 0–9 _ -`:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 6. Deploy
```bash
npx wrangler deploy
```
Note the URL it prints: `https://angel-mortal-bot.<your-subdomain>.workers.dev`.

### 7. Register the webhook
Open this in a browser, using your Worker URL and your `WEBHOOK_SECRET`:
```
https://angel-mortal-bot.<sub>.workers.dev/setup?key=<WEBHOOK_SECRET>
```
It should print:
- `✅ Webhook set to …/webhook`
- `✅ Participant command menu set`
- `Webhook info: … last error: none`

What it does:
- registers the webhook with the secret, receiving only `message` updates
- sets the `/` command menu for participants
- sets a fuller menu for each admin in `ADMIN_IDS`

It's safe to open again at any time. Anyone without the secret gets `403`.

> The secret ends up in your browser history. That's acceptable for your own machine, but don't open the link on a shared computer.

<details><summary>Manual alternative (without <code>/setup</code>)</summary>

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://angel-mortal-bot.<sub>.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message"]
```
It should return `"ok":true`. Check it any time with `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo`.
</details>

### 8. Make yourself admin
1. Message the bot `/myid` and note the number.
2. Put it in `wrangler.toml`. For several admins, separate the IDs with commas:
   ```toml
   [vars]
   ADMIN_IDS = "123456789"
   ```
3. Run `npx wrangler deploy` again.
4. Open the `/setup` link again, so admins get the admin command menu. Each admin must have sent the bot `/start` first.

### 9. Upload pairings and launch
Follow the launch checklist in the [User Guide](USER_GUIDE.md#suggested-launch-checklist).

## Customising for your event

The code and docs are generic; only `wrangler.toml` holds event-specific values. If you're running your own event, change these before deploying:

| What | Where |
|---|---|
| D1 `database_id` | `wrangler.toml`. **Required:** the committed id belongs to the original author's account, so deploying with it fails. Replace it with yours from [step 4](#deployment). |
| `ADMIN_IDS` | `wrangler.toml`. **Required:** replace the committed ID with your own, from step 8. |
| Event name in the bot's messages | `EVENT_NAME` in `wrangler.toml`, e.g. `"Hall 5 Angel & Mortal"`. It appears at the top of the help message. Leave it empty for plain "Angel & Mortal". |
| Button labels, help and admin text | `BTN_*`, `helpText`, `ADMIN_HELP` and `ANNOUNCEMENT` in `src/bot.ts` |
| `/` menu descriptions | `USER_COMMANDS` and `ADMIN_COMMANDS` in `src/index.ts` |
| Worker name, which sets your URL | `name` in `wrangler.toml`, plus the comment above `workers_dev` that shows the original URL |
| Database name | `database_name` in `wrangler.toml`. If you change it, use the new name in every `wrangler d1` command in this guide. |
| Docs links (optional) | The `github.com/chee-yew/...` and `chee-yew.github.io` links in the README and docs, if you publish your own copy |

The pairing format, commands and relay behaviour don't depend on the event, so nothing else needs changing.

## Operations

| Task | Command |
|---|---|
| Live logs | `npm run logs` (`wrangler tail`) |
| Redeploy after code change | `npx wrangler deploy` |
| Query the DB | `npx wrangler d1 execute angel-mortal --remote --command "SELECT * FROM participants"` |
| Back up the DB | `npx wrangler d1 export angel-mortal --remote --output backup.sql` (git-ignore it, because it contains pairings) |

## Free-tier limits

| Limit | Free plan | Our usage (about 60 users) |
|---|---|---|
| Worker requests | 100,000 / day | ~1 per message, plus 1,440 cron runs |
| CPU time | 10 ms / request | Tiny; network waits don't count |
| Outgoing requests (subrequests) | 50 / request | ~3–6 per message. This is why `/broadcast` uses a queue. |
| D1 queries | 50 / request | ~4–6 per message |
| D1 rows read | 5 million / day | A few per message |
| D1 rows written | 100,000 / day | ~3–4 per message, counting index updates |
| D1 storage | 500 MB per database, 5 GB per account | A few MB |
| Telegram | ~30 messages/sec globally, 1/sec per chat | Fine |

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot doesn't respond at all | `getWebhookInfo`: does the URL end in `/webhook`? Look at `last_error_message`. Is the secret the same as `WEBHOOK_SECRET`? |
| `401` in `getWebhookInfo` | The secret token doesn't match. Open `/setup?key=<WEBHOOK_SECRET>` again. If you changed the secret, redeploy first. |
| `/setup` says `Forbidden` | The `key` doesn't match the `WEBHOOK_SECRET` you set with `wrangler secret put`. |
| `/setup` says "Setup failed … 401 Unauthorized" | `BOT_TOKEN` is wrong. Run `npx wrangler secret put BOT_TOKEN` again. |
| Admin `/` menu missing | Each admin must `/start` the bot, then open `/setup` again |
| Broadcast never finishes | Check that the cron is set: Cloudflare dashboard → Worker → Settings → Triggers. Check `npm run logs` for `broadcast cron:` lines. |
| "isn't on the participant list" | The participant's username doesn't match the upload. Use `/swap @wrong @right`. |
| Admin commands say "Unknown command" | Your ID isn't in `ADMIN_IDS`, or you didn't redeploy after editing it. |
| Errors in the logs | Run `npm run logs` while reproducing. Every failed update is logged as `update <id> failed:`. |

## Docs website

The `docs/` folder is published by **GitHub Pages** using its built-in Jekyll. There's no build step to maintain.

| File | Role |
|---|---|
| `docs/_config.yml` | Site title and theme (`jekyll-theme-cayman`) |
| `docs/index.md` | Landing page |
| `docs/*.md` | Each one becomes a page, e.g. `USER_GUIDE.md` → `/USER_GUIDE.html` |

One-time setup: repo **Settings → Pages → Deploy from a branch → `main` / `/docs`**. After that, every push to `main` redeploys within about a minute. Check progress in the **Actions** tab ("pages build and deployment").

When editing docs:
- **Linking another doc:** use the `.md` name, e.g. `[User Guide](USER_GUIDE.md)`. Pages rewrites it to `.html`, so the link works both on GitHub and on the site.
- **Linking code outside `docs/`:** use a full URL like `https://github.com/chee-yew/angel-mortal-bot/blob/main/src/bot.ts`. A `../` path won't exist on the site.
- **Heading anchors:** don't link to headings that start with a number. Jekyll drops the leading digits, so `#7-foo` breaks.
- **Curly braces:** never write two opening curly braces in a row, or an opening brace followed by a percent sign, anywhere in a doc, including inside code. Jekyll treats them as template tags and the build fails.

The published site is **public**, like the repo. Never put tokens or real pairings in `docs/`.

## Git workflow
- Branch `main`, pushed to `github.com/chee-yew/angel-mortal-bot`, which is **public**. Anyone can read the code, so everything private stays out of the repo (see below).
- Small commits, one logical change each.
- Contributions go through pull requests. See [CONTRIBUTING.md](https://github.com/chee-yew/angel-mortal-bot/blob/main/CONTRIBUTING.md).
- **CI** (`.github/workflows/ci.yml`) runs `npm run typecheck`, `npm test` and a `wrangler deploy --dry-run` build on every push and PR. It never deploys and has no access to Cloudflare secrets; deploying stays a manual `npx wrangler deploy`.
- Never commit:
  - real pairing CSVs
  - `.dev.vars`
  - DB exports
  - tokens

  `.gitignore` already covers CSVs and `.dev.vars`.
