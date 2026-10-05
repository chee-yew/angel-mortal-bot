# E Block Angel–Mortal Anonymous Relay Bot — Plan

## Context
The E Block Angel & Mortal event needs a Telegram bot. Each participant should be able to message their **mortal** (whose identity they know) and their **angel** (whose identity they don't) without revealing who they are. The bot relays messages between them and removes the sender's identity. There are about 60 users, it has to go live ASAP, and it needs to run reliably 24/7 for free. The admin (you) supplies the pairings as a list of Telegram handles.

## Decisions
- **Hosting: Cloudflare Workers + D1 (SQLite) on the free tier.** It's always on, has no cold starts or sleeping, and doesn't need a credit card. Free limits are 100k requests/day and 5 GB of D1 storage, which is far more than 60 users will use. The bot uses a Telegram **webhook**, so no server process has to be kept alive.
  - Free options I rejected: Render free (sleeps, and its free database expires after 30 days), Oracle/GCP free VMs (need a card plus Linux upkeep), and PythonAnywhere free (no always-on process).
- **Language:** TypeScript with **grammY**, which has first-class Cloudflare Workers support.
- **Relay method:** Telegram `copyMessage`. It re-sends any message type (text, photo, video, voice, sticker, GIF, document, album item) **without** the "Forwarded from" header, so the sender stays anonymous.

## Project layout (new folder, e.g. `angel-mortal-bot/`)
- `package.json`: deps `grammy`; dev deps `wrangler`, `typescript`
- `wrangler.toml`: the worker name, the D1 binding `DB`, and the var `EVENT_NAME`. `ADMIN_IDS` is a secret, so forks never inherit the author's admins.
- `schema.sql`: D1 tables
- `src/index.ts`: the Worker entry. Checks the webhook secret header, then hands the update to the grammY bot.
- `src/bot.ts`: commands and the relay logic
- `src/db.ts`: small typed query helpers
- `README.md`: overview, features, quick start, and links to the docs
- `docs/USER_GUIDE.md`:
  - Part 1 is for participants, written so you can paste it into the group chat
  - Part 2 is for organisers: the admin commands and a launch checklist
- `docs/DEVELOPER_GUIDE.md`: architecture, relay flow, data model, code tour, local dev, deployment, operations, free-tier limits, troubleshooting
- `docs/PLAN.md`: a copy of this plan, plus the progress tracker
- **Docs website:** GitHub Pages with built-in Jekyll, serving `docs/` from `main` at <https://chee-yew.github.io/angel-mortal-bot/>. The setup files are `docs/_config.yml` (Cayman theme) and `docs/index.md` (landing page). I chose this over MarkBind because it needs no build pipeline and the same `.md` files read correctly on GitHub too. Migrating to MarkBind later is easy.
- **All four docs are kept up to date in every iteration**, whenever a step changes behaviour, commands or setup.

Secrets go in `wrangler secret put` and are never committed: `BOT_TOKEN` and `WEBHOOK_SECRET`.

## Data model (D1)
- `participants(handle TEXT PK lowercase, user_id INT, chat_id INT, target TEXT DEFAULT 'mortal', joined_at)`: `user_id` stays null until the person /start-s the bot
  - **Since step 11:** `angel_thread_id INT` and `mortal_thread_id INT` (each person's two tabs) were added and `target` was dropped. See [Next event: Angel and Mortal tabs](#next-event-angel-and-mortal-tabs).
- `pairings_backup(angel_handle TEXT PK, mortal_handle TEXT UNIQUE)`: the pairings before the last `/upload`, for `/undoupload`
- `pairings(angel_handle TEXT PK, mortal_handle TEXT UNIQUE)`
- `msg_map(recipient_chat_id INT, recipient_msg_id INT, sender_handle TEXT, sender_role TEXT, src_chat_id INT, src_msg_id INT, created_at TEXT, PK(recipient_chat_id, recipient_msg_id))`: lets a recipient use Telegram's *Reply* on a relayed message, and the reply goes back to the right person, threaded under the original
- `settings(key TEXT PK, value TEXT)`: stores the `paused` flag
- `broadcast_queue(id INT PK AUTOINCREMENT, chat_id INT, text TEXT)`: pending `/broadcast` deliveries

## Participant flow
> **Replaced (step 11):** steps 2–4 and 6 below describe the original one-chat design, where you switched modes with buttons. They've been replaced by two tabs. See [Next event: Angel and Mortal tabs](#next-event-angel-and-mortal-tabs).

1. A participant opens the bot and taps **Start**. The bot matches their `@username` (case-insensitive) against the uploaded list, then stores their `user_id`/`chat_id`.
   - **No username set:** the bot tells them how to set one, then to /start again.
   - **Not on the list:** "You're not registered, contact the organiser."
2. A persistent reply keyboard shows: **😇 Chat with Angel**, **🙂 Chat with Mortal**, **❓ Help**. Tapping one sets the *current target* (stored in the DB). The bot confirms, e.g. "Now messaging your Mortal (@xyz)". For the angel it shows "your Angel" only.
3. Every non-command message goes to the current target via `copyMessage`. First, a short label is added:
   - To the mortal: "😇 *From your Angel:*"
   - To the angel: "🙂 *From your Mortal:*"
   - For text and captioned media, the label goes into the text or caption.
   - For stickers, voice notes and video notes, which can't take captions, the bot sends a one-line header first.
4. **Reply routing:** if the user uses Telegram *Reply* on a relayed message, the bot looks it up in `msg_map` and routes to that person, whatever the current target is.
5. A 👍 reaction is set on the sender's own message once it's delivered. If the recipient hasn't started the bot yet, the sender instead gets: "Your angel/mortal hasn't joined the bot yet; message not delivered."
6. Commands: `/angel`, `/mortal` (switch target), `/whoismymortal`, `/help`.

## Next event: Angel and Mortal tabs

### Why
**Feedback from the first event:** people stopped texting their angel, and when they came back they didn't know which mode they were in. The bot keeps a hidden "current target" that's switched with the 😇/🙂 buttons, and nothing in the chat shows it, so it's easy to send something to the wrong person.

### What changes
Telegram now supports **topics in private chats with bots** (Bot API 9.3, Dec 2025, and 9.4, Feb 2026). Each participant gets two tabs inside the bot chat:

| Tab | Typing here | Messages that arrive here |
|---|---|---|
| 😇 **My Angel** | goes to your angel | from your angel |
| 🙂 **My Mortal** | goes to your mortal | from your mortal |

There is no mode to remember, so the switch buttons and the "current target" go away.

- `/start` binds the user as before, creates both tabs, and posts an intro in each:
  - **My Mortal:** "Messages here go to your Mortal @bob, anonymously."
  - **My Angel:** "Messages here go to your Angel."
- Relayed messages arrive in the matching tab **without** a "From your Angel" label, because the tab already says who it's from. `deliver()` becomes a single `copyMessage`.
- A plain message in the main (General) area isn't relayed. The bot replies "Open the 😇 My Angel or 🙂 My Mortal tab to send a message."
- `/angel` and `/mortal` post "👇 Type here…" inside that tab, which takes the user there.
- Broadcasts, admin commands, `/help` and `/whoismymortal` stay in General.
- Reply still works inside a tab. `msg_map` is used only to quote the original message on the other side, not to pick the destination.

### How it works
- **BotFather (once per bot):** enable **Threaded Mode** (topics in private chats) and turn **off** "users can create/delete topics". `/setup` warns if `getMe().has_topics_enabled` is false.
- **Data:** two new columns, `participants.angel_thread_id` and `participants.mortal_thread_id`. A fresh database gets them from `schema.sql`. An existing database runs `migrations/0002_topics.sql` once, and its old `target` column is left unused.
- **Creating tabs:** `ensureTopics()` calls `createForumTopic` for each missing tab (angel yellow `0xFFD67E`, mortal blue `0x6FB9F0`) and saves the ID only if the column is still empty. If two requests race, the loser deletes its duplicate tab. It runs on `/start`, and lazily before delivering to someone whose tabs are missing.
- **Recovering a lost tab:** if a send fails with "thread not found", the bot clears that ID, recreates the tab and retries once.
- **Routing:** the tab a message was sent in decides the destination (`roleForThread()`). A message from my Mortal tab lands in my mortal's Angel tab, and the reverse (`flip()`). All existing handling stays: not joined, paused, 403/400/429, and saving to `msg_map`.
- **Tab names never include handles**, so re-uploading pairings never needs a rename.
- **`/unbind`** also clears both tab IDs, so a newly bound account gets fresh tabs.
- **Pure helpers** in `src/topics.ts` (`roleForThread`, `threadIdFor`, tab names and colours) are unit-tested without grammY.
- **Removed:** the persistent keyboard, `BTN_*`, `setTarget`, the "Now messaging…" confirmations and the label/header logic in `deliver()`.

### Risks
- **Old Telegram apps:** topics in private chats need a 2026 app. The User Guide asks participants to update first, and the pilot covers iOS, Android, Desktop and Web. If someone can't see tabs, the General prompt still tells them what to do, so nothing breaks.
- **Free-plan limits:** `/start` makes about 5 Telegram calls, well under the 50 per request.

## Admin commands (only for user IDs listed in the `ADMIN_IDS` secret)
- `/upload`: send a `.csv` file, or paste lines of `angel_handle,mortal_handle`. The bot validates the list:
  - strips `@` and lowercases handles
  - checks there are no duplicates
  - checks everyone appears exactly once as an angel and once as a mortal
  - checks nobody is paired with themselves

  Then it replaces the pairings and reports any warnings. Existing `user_id`s are kept for handles that are still on the list.
- `/admin`: lists the admin commands.
- `/pairs`: lists every angel→mortal pairing, with ⏳ marking anyone who hasn't joined. Long lists are split across several messages.
- `/status`: shows total participants, how many have joined, and the counts of messages relayed.
- `/missing`: lists the handles that haven't /start-ed yet, so you can chase them.
- `/broadcast <text>`: sends an announcement to every joined participant. The free plan allows 50 outgoing requests per invocation, so the bot queues one row per recipient in `broadcast_queue`, sends 25 straight away, and a cron runs every minute to send 40 more until the queue is empty. Each sender claims its batch with `DELETE … RETURNING`, so nobody gets an announcement twice. If Telegram rate-limits a batch (429), it's put back on the queue.
- `/pause`, `/resume`: stop or start relaying globally (for example, before the event starts).
- `/swap @old @new`: fixes a participant's handle if they change it or it was mistyped.
- `/unbind @handle`: detaches the Telegram account bound to a handle, for when the wrong person joined (binding is by username, so a typo in the list lets whoever owns that username in).
- `/undoupload`: restores the pairings from before the last `/upload`, which are kept in `pairings_backup`.

## Edge cases handled
- A participant changes their username after joining: they're matched by stored `user_id` first, then by handle.
- Someone blocks the bot (403): the error is caught and the sender is told it wasn't delivered.
- Media albums: each item is relayed separately (acceptable).
- Edited and deleted messages are not synced. The help text says so.
- The webhook checks `X-Telegram-Bot-Api-Secret-Token` in `src/index.ts` **before** the bot is created, so nobody else can post fake updates. A forged request gets 401 and never makes the bot call Telegram, whereas grammY's own check would run only after its `getMe` call.
- Errors are caught per update and logged with `console.error`, which shows in `wrangler tail`. The webhook always returns 200 so Telegram doesn't retry-storm.

## Deployment steps (these go in the README; I'll walk you through them)
1. In @BotFather: `/newbot`, then copy the token. Optionally set the description, commands list and profile picture.
2. Create a free Cloudflare account. Install Node.js LTS.
3. `npm install`, then `npx wrangler login`.
4. `npx wrangler d1 create angel-mortal`, and paste the resulting ID into `wrangler.toml`.
5. `npx wrangler d1 execute angel-mortal --remote --file=schema.sql`
6. `npx wrangler secret put BOT_TOKEN`, then `npx wrangler secret put WEBHOOK_SECRET`.
7. `npx wrangler deploy`, which gives you the URL `https://<name>.<subdomain>.workers.dev`.
8. Open `https://<worker-url>/setup?key=<WEBHOOK_SECRET>`. This sets the webhook, using the secret and `allowed_updates: ["message"]`, and the participant command menu. The manual `setWebhook` URL is documented as a fallback.
9. Message the bot `/myid`, run `npx wrangler secret put ADMIN_IDS` with it, then open `/setup` again so admins get the admin command menu.
10. `/upload` the pairing CSV, then share the bot link with participants.

## Version control (git + GitHub)
- Branch `main`, pushed to the **public** repo `https://github.com/chee-yew/angel-mortal-bot`. Being public is safe: anonymity comes from the relay design, not from hiding the code.
- Commits are small and frequent, one logical step each.
- Each iteration ends with a summary (files changed, how it was verified, a suggested commit message), and this plan and its progress tracker are kept up to date.
- `.gitignore` excludes `node_modules/`, `.wrangler/`, `.dev.vars`, DB exports (`backup*.sql`) and `*.csv`, except `pairings.example.csv`. **Real pairings are never committed** because they reveal who is whose angel. The bot token, webhook secret and admin IDs live only in Cloudflare secrets.

### Progress tracker
| # | Step | Status |
|---|------|--------|
| 1 | Scaffold config | ✅ done |
| 2 | Schema + pairing parser + tests | ✅ done |
| 3 | `.gitattributes` (LF) | ✅ done |
| 4 | DB layer `src/db.ts` | ✅ done |
| 5 | Relay core `src/bot.ts` | ✅ done |
| 6 | Reply routing | ✅ done |
| 7 | Admin commands | ✅ done |
| 7b | README + User Guide + Developer Guide | ✅ done |
| 7c | Docs website (GitHub Pages) | ✅ done |
| 8 | `/broadcast` queue (+ docs) | ✅ done |
| 9 | Worker entry: webhook, `/setup` route, cron wiring (+ docs) | ✅ done |
| 10 | Deploy + end-to-end test, final docs pass | ✅ done. Deployed to `https://angel-mortal-bot.chee-yew.workers.dev` with D1, cron and the admin ID configured, and tested end-to-end on Telegram. Docs refreshed for the public repo, with a licence, contributor guide, CI and a configurable `EVENT_NAME`. |
| 10b | Review fixes: `ADMIN_IDS` as a secret, relay failures reported to the sender, `/swap` validation, `/unbind`, `/undoupload` | ✅ done |
| 11a | Tabs: design section in this plan and these tracker rows | ✅ done |
| 11b | Tabs: schema, `migrations/0002_topics.sql`, `src/topics.ts` + tests, `Db` thread-id methods | ✅ done |
| 11c | Tabs: `ensureTopics`, routing by tab, simpler `deliver`, remove modes and keyboard | ✅ done |
| 11d | Tabs: `/setup` Threaded Mode check, command menus, `/unbind` clears tabs | ✅ done |
| 11e | Tabs: User Guide, Developer Guide, README; end-to-end pilot with 3 accounts on iOS, Android, Desktop and Web | 🔄 docs done; pilot on real Telegram still to do |

## Verification
- `npx tsc --noEmit` passes.
- Local run: `npx wrangler dev` with a test bot token, exposed through a `cloudflared` tunnel and set as the webhook.
- End-to-end with 3 Telegram accounts (you plus 2 friends, or test handles) in a cycle A→B→C→A:
  - Check that text, photo, sticker and voice relay both ways, that headers show the right role, and that no "forwarded from" appears.
  - Check that Reply routes correctly.
  - Check the not-joined warning.
  - Check `/pause`, `/missing`, `/broadcast`, and that `/upload` validation rejects a bad list.
- After deploying, check `wrangler tail` while sending messages to confirm there are no errors.
- **Tabs (step 11):** on a test bot with Threaded Mode on, and 3 accounts in a cycle A→B→C→A:
  - `/start` creates both tabs with their intros.
  - Text, photo, sticker and voice sent in the Mortal tab arrive in the recipient's Angel tab, and the reverse. Nothing shows "Forwarded from".
  - Reply inside a tab quotes the original on the other side.
  - A message in General gets the "Open a tab" prompt and isn't relayed.
  - `/broadcast` lands in General. `/unbind`, then `/start` again, gives fresh tabs.
  - `/setup` warns when Threaded Mode is off.
  - Repeat on iOS, Android, Desktop and Web.
  - Apply `schema.sql` to a fresh local D1, and `migrations/0002_topics.sql` to one with the old schema. Both end up with the thread columns.

## What I'll need from you during the build
- The bot token, which you'll set yourself via `wrangler secret put` and never paste in chat.
- Your Telegram user ID, for admin access.
- The pairing CSV, in the format `angel_handle,mortal_handle`.
