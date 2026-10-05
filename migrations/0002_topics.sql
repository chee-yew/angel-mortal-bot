-- Adds each participant's two tabs (topics in the private bot chat) to a database created
-- before tabs existed. Run once:
--   npx wrangler d1 execute angel-mortal --remote --file=migrations/0002_topics.sql
-- A database created from the current schema.sql already has these columns; running this
-- against it (or twice) fails with "duplicate column name", which is harmless.
ALTER TABLE participants ADD COLUMN angel_thread_id INTEGER;
ALTER TABLE participants ADD COLUMN mortal_thread_id INTEGER;
