-- Records the name each tab currently has, so the bot can rename a tab when the pairings change.
-- Run once, after 0002_topics.sql:
--   npx wrangler d1 execute angel-mortal --remote --file=migrations/0003_tab_names.sql
-- Existing tabs start with no recorded name, so the bot renames them the next time it touches them.
-- A database created from the current schema.sql already has these columns; running this
-- against it (or twice) fails with "duplicate column name", which is harmless.
ALTER TABLE participants ADD COLUMN angel_tab_name TEXT;
ALTER TABLE participants ADD COLUMN mortal_tab_name TEXT;
