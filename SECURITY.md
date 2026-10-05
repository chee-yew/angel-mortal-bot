# Security policy

## Reporting a vulnerability
Please **don't report security problems in a public issue.**

Report them privately through GitHub: go to the repo's **Security** tab → **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should hear back within a week. Once a fix is deployed, the report can be made public, with credit to you if you'd like.

## What counts
Anything that could:
- reveal who an angel is to their mortal, or otherwise break anonymity
- let someone who isn't an admin run admin commands
- let someone forge updates to the webhook or trigger `/setup` without the secret
- leak pairings, messages, tokens or secrets

## If you run your own copy
Your deployment's security is up to you:
- keep `BOT_TOKEN` and `WEBHOOK_SECRET` only in Cloudflare secrets, never in the repo
- turn on two-factor authentication for your Telegram, Cloudflare and GitHub accounts
- if a token leaks, revoke it in @BotFather (`/revoke`), set the new one with `npx wrangler secret put BOT_TOKEN`, and open `/setup` again
