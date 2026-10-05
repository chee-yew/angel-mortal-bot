# Developer Guide

Contents:
- [Architecture](#architecture)
- [How a message is relayed](#how-a-message-is-relayed)
- [Data model](#data-model)
- [Code tour](#code-tour)
- [Local development](#local-development)
- [Deployment](#deployment)
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
- **Webhook security.** Telegram sends the header `X-Telegram-Bot-Api-Secret-Token`. grammY rejects any request whose header doesn't match `WEBHOOK_SECRET`.
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

## Data model

Defined in [`schema.sql`](https://github.com/chee-yew/angel-mortal-bot/blob/main/schema.sql):

| Table | Purpose |
|---|---|
| `participants` | `handle` (lowercase, PK), `user_id`/`chat_id` (null until /start), `target`, `joined_at` |
| `pairings` | `angel_handle` (PK) → `mortal_handle` (unique) |
| `msg_map` | `(recipient_chat_id, recipient_msg_id)` → original sender, their role relative to the recipient, and the source message, for reply routing |
| `settings` | key/value pairs, currently `paused` |
| `broadcast_queue` | pending `/broadcast` deliveries (coming in step 8) |

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
| `src/index.ts` | Worker entry: `/webhook`, `/setup`, cron (coming in step 9) |

Conventions:
- **Handles:** always lowercase with no `@`. Normalise any input with `normaliseHandle()`.
- **Bot replies:** plain text with no `parse_mode`, so underscores in usernames can't break Markdown.
- **Admin commands:** registered on `pm.filter(isAdmin)`. Non-admins fall through to "Unknown command".
- **D1 limits:** at most **100 bound parameters per statement**, which is why `replacePairings` inserts in chunks of 50. Keep each update to a handful of queries.

## Local development

Prerequisites: Node.js 20+ and a **separate test bot** from @BotFather, so you never test on the live bot.

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
5. Point the test bot at the tunnel URL (see step 7 of [Deployment](#deployment)).

To test properly you need **at least 3 Telegram accounts** in a cycle A→B→C→A. Ask friends to help, or use the Telegram Desktop multi-account feature.

## Deployment

### 1. Create the bot
In Telegram, open **@BotFather** → `/newbot` → pick a name and a username → copy the **token**. Optional:
- `/setdescription`
- `/setuserpic`
- `/setjoingroups` → **Disable**, since the bot is for private chats only

### 2. Cloudflare account
Sign up at <https://dash.cloudflare.com/sign-up>. The free plan is enough and no card is needed.

### 3. Install and log in
```bash
npm install
npx wrangler login
```

### 4. Create the database
```bash
npx wrangler d1 create angel-mortal
```
Copy the printed `database_id` into `wrangler.toml`. The id isn't secret, so it's fine to commit it. Then create the tables:
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
Open this in a browser, after replacing the placeholders:
```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://angel-mortal-bot.<sub>.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=["message"]
```
It should return `"ok":true`. Check it any time with `.../bot<BOT_TOKEN>/getWebhookInfo`.

*(Step 9 will add a `/setup` route that does this, and also sets the bot's command menu, for you.)*

### 8. Make yourself admin
Message the bot `/myid`. Put the number in `wrangler.toml`; for several admins, separate the IDs with commas:
```toml
[vars]
ADMIN_IDS = "123456789"
```
Then run `npx wrangler deploy` again.

### 9. Upload pairings and launch
Follow the launch checklist in the [User Guide](USER_GUIDE.md#suggested-launch-checklist).

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
| D1 storage | 5 GB | A few MB |
| Telegram | ~30 messages/sec globally, 1/sec per chat | Fine |

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot doesn't respond at all | `getWebhookInfo`: does the URL end in `/webhook`? Look at `last_error_message`. Is the secret the same as `WEBHOOK_SECRET`? |
| `401` in `getWebhookInfo` | The secret token doesn't match. Re-run `setWebhook` with the right secret. |
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

The published site is **public**, even if the repo is private. Never put tokens or real pairings in `docs/`.

## Git workflow
- Branch `main`, pushed to `github.com/chee-yew/angel-mortal-bot`, which stays **private**.
- Small commits, one logical change each.
- Never commit:
  - real pairing CSVs
  - `.dev.vars`
  - DB exports
  - tokens

  `.gitignore` already covers CSVs and `.dev.vars`.
