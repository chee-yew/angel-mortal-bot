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
- `wrangler.toml`: the worker name, the D1 binding `DB`, and the vars `ADMIN_IDS`
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
- `pairings(angel_handle TEXT PK, mortal_handle TEXT UNIQUE)`
- `msg_map(recipient_chat_id INT, recipient_msg_id INT, sender_handle TEXT, sender_role TEXT, PK(recipient_chat_id, recipient_msg_id))`: lets a recipient use Telegram's *Reply* on a relayed message, and the reply goes back to the right person
- `settings(key TEXT PK, value TEXT)`: stores the `paused` flag

## Participant flow
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
5. A ✅ reaction is set on the sender's own message once it's delivered. If the recipient hasn't started the bot yet, the sender instead gets: "Your angel/mortal hasn't joined the bot yet; message not delivered."
6. Commands: `/angel`, `/mortal` (switch target), `/whoismymortal`, `/help`.

## Admin commands (only for user IDs listed in `ADMIN_IDS`)
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

## Edge cases handled
- A participant changes their username after joining: they're matched by stored `user_id` first, then by handle.
- Someone blocks the bot (403): the error is caught and the sender is told it wasn't delivered.
- Media albums: each item is relayed separately (acceptable).
- Edited and deleted messages are not synced. The help text says so.
- The webhook checks `X-Telegram-Bot-Api-Secret-Token` in `src/index.ts` **before** the bot is created, so nobody else can post fake updates. A forged request gets 401 and never makes the bot call Telegram, whereas grammY's own check would run only after its `getMe` call.
- Errors are caught per update and logged with `console.log`, which shows in `wrangler tail`. The webhook always returns 200 so Telegram doesn't retry-storm.

## Deployment steps (these go in the README; I'll walk you through them)
1. In @BotFather: `/newbot`, then copy the token. Optionally set the description, commands list and profile picture.
2. Create a free Cloudflare account. Install Node.js LTS.
3. `npm install`, then `npx wrangler login`.
4. `npx wrangler d1 create angel-mortal`, and paste the resulting ID into `wrangler.toml`.
5. `npx wrangler d1 execute angel-mortal --remote --file=schema.sql`
6. `npx wrangler secret put BOT_TOKEN`, then `npx wrangler secret put WEBHOOK_SECRET`.
7. `npx wrangler deploy`, which gives you the URL `https://<name>.<subdomain>.workers.dev`.
8. Open `https://<worker-url>/setup?key=<WEBHOOK_SECRET>`. This sets the webhook, using the secret and `allowed_updates: ["message"]`, and the participant command menu. The manual `setWebhook` URL is documented as a fallback.
9. Message the bot `/myid`, put the ID in `ADMIN_IDS`, redeploy, then open `/setup` again so admins get the admin command menu.
10. `/upload` the pairing CSV, then share the bot link with participants.

## Version control (git + GitHub)
- Local folder: `C:\Users\wongc\angel-mortal-bot` (git repo, branch `main`). Remote: `https://github.com/chee-yew/angel-mortal-bot.git`. The remote already has 1 commit, probably a README or licence, so its history has to be merged once.
- **Division of work:** Claude writes the code for one step, then **stops**. It leaves the changes uncommitted, says what changed, and suggests a commit message. **You** review, `git add`, `git commit` with your own message, and `git push`, then tell Claude to continue. Claude never commits, pushes or runs `gh`.
- **Every iteration ends with a summary:**
  - files changed and what each change does
  - how it was verified
  - a suggested commit message

  Claude also updates the progress tracker below and keeps `docs/PLAN.md` in sync with this plan.

### Progress tracker
| # | Step | Status |
|---|------|--------|
| 1 | Scaffold config | ✅ pushed |
| 2 | Schema + pairing parser + tests | ✅ pushed |
| 3 | `.gitattributes` (LF) | ✅ pushed |
| 4 | DB layer `src/db.ts` | ✅ pushed |
| 5 | Relay core `src/bot.ts` | ✅ pushed |
| — | Plan copied to `docs/PLAN.md` | ✅ pushed |
| 6 | Reply routing | ✅ pushed |
| 7 | Admin commands | ✅ committed |
| 7b | README + User Guide + Developer Guide | ✅ committed |
| 7c | Docs website (GitHub Pages) | ✅ pushed |
| 8 | `/broadcast` queue (+ docs) | ✅ committed |
| 9 | Worker entry: webhook, `/setup` route, cron wiring (+ docs) | ✅ pushed |
| 10 | Deploy + end-to-end test, final docs pass | 🟡 in progress. Deployed to `https://angel-mortal-bot.chee-yew.workers.dev` with D1 and cron live. Waiting on the TLS cert for the new subdomain, then `/setup`, admin, and E2E tests. |
- Commits are small and frequent, one logical step each. Already done:
  1. Scaffold config
  2. Schema + pairing parser + tests

  Still to do:
  3. `.gitattributes` (LF line endings)
  4. DB layer (`src/db.ts`)
  5. Relay core (`src/bot.ts` participant flow + `copyMessage` delivery)
  6. Reply routing
  7. Admin commands
  8. Broadcast queue + cron
  9. Worker entry + `/setup` route (`src/index.ts`)
  10. README + participant guide

  After each one I tell you it's ready, and you push it with `git push`.
- `.gitignore` already excludes `node_modules/`, `.wrangler/`, `.dev.vars` and `*.csv`, except `pairings.example.csv`. **Real pairings are never committed** because they reveal who is whose angel. The bot token and webhook secret live only in Cloudflare secrets.

### One-time guide for you: link this folder to GitHub
Run these in `C:\Users\wongc\angel-mortal-bot`:
```
git remote add origin https://github.com/chee-yew/angel-mortal-bot.git
git pull origin main --allow-unrelated-histories --no-rebase
git push -u origin main
```
- The `git pull` merges the repo's existing first commit into the local history.
  - If it opens an editor for the merge message, save and close it.
  - If it reports a conflict (for example in `.gitignore` or `README.md`), keep both sides' lines, then run `git add <file>` and `git commit`.
- After that, every later push is just `git push`.
- Check the result with `git log --oneline --graph` and on the repo page on GitHub. Keep the repo **private** (Settings → General → Danger Zone → Change visibility), so participants can't read the code.

## Verification
- `npx tsc --noEmit` passes.
- Local run: `npx wrangler dev` with a test bot token, exposed through a `cloudflared` tunnel and set as the webhook.
- End-to-end with 3 Telegram accounts (you plus 2 friends, or test handles) in a cycle A→B→C→A:
  - Check that text, photo, sticker and voice relay both ways, that headers show the right role, and that no "forwarded from" appears.
  - Check that Reply routes correctly.
  - Check the not-joined warning.
  - Check `/pause`, `/missing`, `/broadcast`, and that `/upload` validation rejects a bad list.
- After deploying, check `wrangler tail` while sending messages to confirm there are no errors.

## What I'll need from you during the build
- The bot token, which you'll set yourself via `wrangler secret put` and never paste in chat.
- Your Telegram user ID, for admin access.
- The pairing CSV, in the format `angel_handle,mortal_handle`.
