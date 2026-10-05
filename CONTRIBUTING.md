# Contributing

Thanks for helping out! Bug reports, fixes, docs improvements and features are all welcome.

## Before you start
- For anything bigger than a small fix, **open an issue first** so we can agree on the approach.
- Security problems: **don't open a public issue**. See [SECURITY.md](SECURITY.md).

## Setting up
You need Node.js 22.6 or newer.

```bash
git clone https://github.com/<your-username>/angel-mortal-bot.git   # your fork
cd angel-mortal-bot
npm install
npm test               # parser, config and tab tests
npm run typecheck      # tsc --noEmit
```

To run the bot against Telegram, follow [Local development](docs/DEVELOPER_GUIDE.md#local-development) in the Developer Guide. Use **your own test bot** from @BotFather and your own Cloudflare account. You never need the maintainer's tokens or database.

## Making a change
1. Fork the repo and create a branch from `main`, e.g. `fix/reply-routing`.
2. Keep each PR to one logical change.
3. Follow the conventions in the [Developer Guide's code tour](docs/DEVELOPER_GUIDE.md#code-tour), in particular:
   - all SQL lives in `src/db.ts`
   - handles are lowercase with no `@`; use `normaliseHandle()`
   - bot replies are plain text, with no `parse_mode`
   - the relay handler in `src/bot.ts` stays registered last
4. If you change behaviour, commands or setup, **update the docs in the same PR**: `README.md`, `docs/USER_GUIDE.md` and/or `docs/DEVELOPER_GUIDE.md`.
5. Add or update tests where it makes sense. `src/pairings.ts` is pure and easy to test.
6. Run `npm test` and `npm run typecheck` before pushing. CI runs both, plus a dry-run build.
7. Open a pull request and fill in the template.

## Never commit
- bot tokens, webhook secrets or `.dev.vars`
- real pairing lists (they reveal who is whose angel)
- database exports

`.gitignore` covers the usual files, but check your diff before pushing.

## Docs site
`docs/` is published with GitHub Pages (Jekyll). Before editing it, read [Docs website](docs/DEVELOPER_GUIDE.md#docs-website) for the link and formatting rules that keep the build working.

## License
By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
