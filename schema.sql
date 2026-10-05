-- One row per participant. user_id/chat_id stay NULL until they /start the bot.
CREATE TABLE IF NOT EXISTS participants (
  handle    TEXT PRIMARY KEY,                 -- lowercase Telegram username, no "@"
  user_id   INTEGER UNIQUE,
  chat_id   INTEGER,
  joined_at TEXT,
  angel_thread_id  INTEGER,                   -- their "😇 My Angel" tab (topic) in the bot chat
  mortal_thread_id INTEGER,                   -- their "🙂 Mortal" tab
  angel_tab_name   TEXT,                      -- the name each tab currently has, so it can be
  mortal_tab_name  TEXT                       -- renamed when the pairings change
);

-- angel_handle welfares mortal_handle.
CREATE TABLE IF NOT EXISTS pairings (
  angel_handle  TEXT PRIMARY KEY,
  mortal_handle TEXT NOT NULL UNIQUE
);

-- The pairings before the last /upload, so /undoupload can restore them.
CREATE TABLE IF NOT EXISTS pairings_backup (
  angel_handle  TEXT PRIMARY KEY,
  mortal_handle TEXT NOT NULL UNIQUE
);

-- Every relayed message, so a Telegram "Reply" routes back to the right person.
CREATE TABLE IF NOT EXISTS msg_map (
  recipient_chat_id INTEGER NOT NULL,
  recipient_msg_id  INTEGER NOT NULL,
  sender_handle     TEXT NOT NULL,
  sender_role       TEXT NOT NULL,            -- sender's role relative to the recipient
  src_chat_id       INTEGER NOT NULL,
  src_msg_id        INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (recipient_chat_id, recipient_msg_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Pending /broadcast deliveries, drained in batches by the cron trigger.
CREATE TABLE IF NOT EXISTS broadcast_queue (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  text    TEXT NOT NULL
);
