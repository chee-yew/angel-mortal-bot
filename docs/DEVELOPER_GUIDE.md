# Developer Guide

Contents:
- [Architecture](#architecture)
- [How a message is relayed](#how-a-message-is-relayed)
- [Broadcasts](#broadcasts)
- [Data model](#data-model)
- [Tabs](#tabs)
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
- **Tabs.** Each participant's "😇 My Angel" and "🙂 My Mortal" tabs are forum topics in their private chat with the bot (Bot API 9.3+). The bot creates them with `createForumTopic`, which only works when **Threaded Mode** is on in BotFather.
- **Anonymity** comes from `copyMessage`. Unlike `forwardMessage`, it creates a brand-new message from the bot, with no "Forwarded from" header.
- **Never-fail webhook.** The first middleware in `createBot` catches and logs every error. The webhook therefore always returns 200, so Telegram never retries the same update in a loop.

## How a message is relayed

1. `resolve()` identifies the sender:
   - first by Telegram `user_id`, which survives username changes
   - otherwise by `@username`, which is then bound to their `user_id`/`chat_id` on first contact
2. **The tab decides the destination.** `roleForThread()` maps the message's `message_thread_id` to `angel` or `mortal`. A message typed outside both tabs (in General) isn't relayed: the bot creates the tabs if they're missing and tells the sender to open one.
3. If relaying is paused, the bot stops here and tells the sender.
4. The partner is looked up in `pairings`. If the message is a Reply to a relayed message, `msg_map` supplies the original message so it's quoted on the other side. The mapping is ignored if the pairings have changed since.
5. `deliverToTab()` sends it into the partner's matching tab: my Mortal tab → my mortal's **Angel** tab, and the reverse (`flip()`).
   - `ensureTabs()` creates any missing tab first.
   - `deliver()` is a single `copyMessage` with `message_thread_id`. There's no label, because the tab already says who it's from.
   - If Telegram says the thread no longer exists, the tab ID is cleared, the tab recreated and the send retried once.
6. Every message id created in the recipient's chat goes into `msg_map`, so replies can be quoted.
7. The bot reacts 👍 on the sender's message.

   | Error | What the sender is told |
   |---|---|
   | 403 (recipient blocked the bot) | "not delivered" |
   | 400 (unsupported message type) | "can't relay this kind of message" |
   | 429 (sending too fast) | "not delivered", wait N seconds and resend |
   | Anything else | "not delivered because of a temporary error", resend |

   Once `deliver()` has succeeded, the sender always gets 👍. If saving to `msg_map` fails at that point, the error is only logged: a Reply to that message just won't show as a reply on the other side. Telling the sender it failed would make them send a duplicate. Errors anywhere else in an update are caught by the first middleware, which logs them and tells the user to try again.

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
| `participants` | `handle` (lowercase, PK), `user_id`/`chat_id` (null until /start), `joined_at`, `angel_thread_id`/`mortal_thread_id` (their two tabs, null until created) |
| `pairings` | `angel_handle` (PK) → `mortal_handle` (unique) |
| `pairings_backup` | The pairings as they were before the last `/upload` or `/undoupload`, so `/undoupload` can restore them |
| `msg_map` | `(recipient_chat_id, recipient_msg_id)` → original sender, their role relative to the recipient, and the source message, for reply routing |
| `settings` | key/value pairs, currently `paused` |
| `broadcast_queue` | Pending `/broadcast` deliveries, one row per recipient. See [Broadcasts](#broadcasts). |

`participants` is derived from `pairings` on every `/upload`:
- new handles are inserted
- handles no longer on the list are deleted
- existing rows, and therefore join status, are kept

Before replacing, `/upload` copies the current pairings to `pairings_backup` in the same atomic batch. `/undoupload` simply calls `replacePairings()` with the backup, so the two lists swap places and a second `/undoupload` redoes the upload.

`/unbind @handle` clears `user_id`, `chat_id`, `joined_at` and both tab IDs for that handle, and deletes the `msg_map` rows for messages the bound account sent or received, so replies to them can't route to whoever joins next.

## Tabs
- `ensureTabs()` creates each missing tab and saves its ID with `Db.setThreadId()`, which only writes if the column is still empty. If two requests create the same tab at once, the loser deletes its duplicate.
- Tabs are created by `/start`, by `/angel` and `/mortal`, when someone types in General, and before delivering to someone whose tab is missing.
- Tab names never contain handles, so re-uploading pairings never needs a rename. The mortal's handle appears in the intro message that `/start` posts.

## Code tour

| File | What's in it |
|---|---|
| [`src/pairings.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/pairings.ts) | `parsePairings()` turns raw text into `{pairs, errors, warnings}`. Pure, no I/O, and unit-tested. |
| [`src/db.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/db.ts) | `Db` class. Every SQL query lives here. |
| [`src/bot.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/bot.ts) | `createBot(env)`: participant commands, admin commands, then the relay handler, which **must stay last** because it catches every message. Also `ensureTabs()`, `deliverToTab()` and `deliver()`. |
| [`src/topics.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/topics.ts) | Tab names and colours, `roleForThread()` (which tab a message was sent in) and `threadIdFor()` (which tab to deliver to). Pure and unit-tested. |
| [`src/config.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/config.ts) | `parseAdminIds()` reads the `ADMIN_IDS` secret, ignoring and reporting entries that aren't numeric IDs. Pure and unit-tested. |
| [`src/index.ts`](https://github.com/chee-yew/angel-mortal-bot/blob/main/src/index.ts) | Worker entry. `fetch()` handles `/webhook` (secret check, then grammY), `/setup` (Threaded Mode check, webhook and command menus) and `/` (health check); `scheduled()` is the cron that drains broadcasts. The bot instance is cached per isolate, so `getMe` runs once rather than on every update. |

Conventions:
- **Handles:** always lowercase with no `@`. Normalise any input with `normaliseHandle()`.
- **Bot replies:** plain text with no `parse_mode`, so underscores in usernames can't break Markdown.
- **Admin commands:** registered on `pm.filter(isAdmin)`. Non-admins fall through to "Unknown command".
- **D1 limits:** at most **100 bound parameters per statement**, which is why `replacePairings` inserts in chunks of 50. Keep each update to a handful of queries.

## Local development

Prerequisites: Node.js 22.6+ (the tests use its built-in TypeScript support) and a **separate test bot** from @BotFather with **Threaded Mode** on (see [Deployment](#deployment)), so you never test on the live bot.

```bash
npm install
npm test               # parser, config and tab tests
npm run typecheck      # tsc --noEmit
```

To run the bot locally:
1. Create `.dev.vars`. It's git-ignored.
   ```
   BOT_TOKEN=<test bot token>
   WEBHOOK_SECRET=<any random string>
   ADMIN_IDS=<your Telegram ID>
   ```
   Locally these stand in for the Cloudflare secrets.
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
In Telegram, open **@BotFather** → `/newbot` → pick a name and a username → copy the **token**.

**Required:** in BotFather, open your bot's settings and turn **Threaded Mode** (topics in private chats) **on**, and turn **off** letting users create and delete topics. Without Threaded Mode the bot can't create anyone's Angel and Mortal tabs, and `/start` tells them so.

Optional:
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

While `wrangler.toml` is open, set the event name under `[vars]`:
```toml
EVENT_NAME = "Your Event Angel & Mortal"   # shown at the top of the bot's help message
```
Admins are **not** set in `wrangler.toml`: `ADMIN_IDS` is a secret you add in step 8, so a fork never inherits anyone else's admins. See [Customising for your event](#customising-for-your-event) for everything else you might change.

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
Note the URL it prints: `https://angel-mortal-bot.<your-subdomain>.workers.dev`. On a brand-new Cloudflare account, Wrangler first asks you to choose a `workers.dev` subdomain.

### 7. Register the webhook
Open this in a browser, using your Worker URL and your `WEBHOOK_SECRET`:
```
https://angel-mortal-bot.<sub>.workers.dev/setup?key=<WEBHOOK_SECRET>
```
It should print:
- `✅ Threaded Mode is on…` (if it says ❌, fix it in BotFather and open the link again)
- `✅ Webhook set to …/webhook`
- `✅ Participant command menu set`
- `Webhook info: … last error: none`

What it does:
- checks that Threaded Mode is on, and warns if users can create their own topics
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
2. Save it as a secret. For several admins, enter the IDs separated by commas, e.g. `123456789,987654321`:
   ```bash
   npx wrangler secret put ADMIN_IDS
   ```
   This takes effect immediately; there's no need to redeploy. Run it again to change the list.
3. Open the `/setup` link again, so admins get the admin command menu. Each admin must have sent the bot `/start` first.

### 9. Upload pairings and launch
Follow the launch checklist in the [User Guide](USER_GUIDE.md#suggested-launch-checklist).

## Customising for your event

The code and docs are generic; only `wrangler.toml` holds event-specific values. If you're running your own event, change these before deploying:

| What | Where |
|---|---|
| D1 `database_id` | `wrangler.toml`. **Required:** the committed id belongs to the original author's account, so deploying with it fails. Replace it with yours from [step 4](#deployment). |
| `ADMIN_IDS` | A secret, set with `npx wrangler secret put ADMIN_IDS` in [step 8](#deployment). Nothing to change in the repo. |
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
| Apply schema changes after pulling a new version | `npx wrangler d1 execute angel-mortal --remote --file=schema.sql`. It only creates missing tables, so it's safe to re-run and keeps your data. |
| Upgrade a database created before tabs existed | `npx wrangler d1 execute angel-mortal --remote --file=migrations/0002_topics.sql`, once. A database created from the current `schema.sql` doesn't need it. |
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
| `/start` says "couldn't set up your Angel and Mortal tabs" | Threaded Mode is off in BotFather (open `/setup` to check), or the participant's Telegram app is too old to support it. |
| Participant can't see the tabs | Telegram Desktop and Web don't show bot tabs reliably yet (seen in the pilot: Web showed them, then didn't). Have them use the phone app, updated. If the tabs are missing on the phone too, send `/start` again. |
| "no such column: angel_thread_id" in the logs | The database predates tabs. Run `migrations/0002_topics.sql` (see [Operations](#operations)). |
| The wrong person joined as someone | `/unbind @handle`, then `/swap @handle @real_username` if they still own that username. |
| `/upload` or `/undoupload` fails with "no such table: pairings_backup" | Your database predates the backup table. Re-run `schema.sql` (see [Operations](#operations)). |
| "isn't on the participant list" | The participant's username doesn't match the upload. Use `/swap @wrong @right`. |
| Admin commands say "Unknown command" | Your ID isn't in the `ADMIN_IDS` secret. Check with `npx wrangler secret list`, and set it with `npx wrangler secret put ADMIN_IDS`. `/setup` also warns about entries that aren't numeric IDs. |
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
