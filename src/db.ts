import type { Pair } from "./pairings";

export type Role = "angel" | "mortal";

export interface Participant {
  handle: string;
  user_id: number | null;
  chat_id: number | null;
  target: Role;
  joined_at: string | null;
  angel_thread_id: number | null;
  mortal_thread_id: number | null;
}

const THREAD_COLUMN: Record<Role, string> = {
  angel: "angel_thread_id",
  mortal: "mortal_thread_id",
};

export interface MsgMapRow {
  sender_handle: string;
  sender_role: Role;
  src_chat_id: number;
  src_msg_id: number;
}

export interface PairRow {
  angel_handle: string;
  mortal_handle: string;
  angel_joined: number;
  mortal_joined: number;
}

export interface QueuedBroadcast {
  id: number;
  chat_id: number;
  text: string;
}

// D1 allows at most 100 bound parameters per statement.
const PAIRS_PER_INSERT = 50;

export class Db {
  constructor(private readonly d1: D1Database) {}

  // ---- participants ----

  byUserId(userId: number) {
    return this.d1.prepare("SELECT * FROM participants WHERE user_id = ?").bind(userId).first<Participant>();
  }

  byHandle(handle: string) {
    return this.d1.prepare("SELECT * FROM participants WHERE handle = ?").bind(handle).first<Participant>();
  }

  async bindUser(handle: string, userId: number, chatId: number) {
    await this.d1
      .prepare(
        "UPDATE participants SET user_id = ?, chat_id = ?, joined_at = COALESCE(joined_at, datetime('now')) WHERE handle = ?",
      )
      .bind(userId, chatId, handle)
      .run();
  }

  async setTarget(handle: string, target: Role) {
    await this.d1.prepare("UPDATE participants SET target = ? WHERE handle = ?").bind(target, handle).run();
  }

  /**
   * Saves the thread id of `handle`'s tab for their `role`, unless one is already saved.
   * Returns false if another request saved one first (the caller should delete its duplicate tab).
   */
  async setThreadId(handle: string, role: Role, threadId: number) {
    const col = THREAD_COLUMN[role];
    const res = await this.d1
      .prepare(`UPDATE participants SET ${col} = ? WHERE handle = ? AND ${col} IS NULL`)
      .bind(threadId, handle)
      .run();
    return res.meta.changes === 1;
  }

  /** Forgets a tab that no longer exists, if it's still the saved one, so it can be recreated. */
  async clearThreadId(handle: string, role: Role, staleThreadId: number) {
    const col = THREAD_COLUMN[role];
    await this.d1
      .prepare(`UPDATE participants SET ${col} = NULL WHERE handle = ? AND ${col} = ?`)
      .bind(handle, staleThreadId)
      .run();
  }

  /** The participant who is `handle`'s angel or mortal. */
  partner(handle: string, role: Role) {
    const sql =
      role === "mortal"
        ? "SELECT p.* FROM pairings x JOIN participants p ON p.handle = x.mortal_handle WHERE x.angel_handle = ?"
        : "SELECT p.* FROM pairings x JOIN participants p ON p.handle = x.angel_handle WHERE x.mortal_handle = ?";
    return this.d1.prepare(sql).bind(handle).first<Participant>();
  }

  // ---- reply routing ----

  async saveMap(recipientChatId: number, recipientMsgIds: number[], row: MsgMapRow) {
    const stmt = this.d1.prepare(
      "INSERT OR REPLACE INTO msg_map (recipient_chat_id, recipient_msg_id, sender_handle, sender_role, src_chat_id, src_msg_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    await this.d1.batch(
      recipientMsgIds.map((id) =>
        stmt.bind(recipientChatId, id, row.sender_handle, row.sender_role, row.src_chat_id, row.src_msg_id),
      ),
    );
  }

  getMap(recipientChatId: number, recipientMsgId: number) {
    return this.d1
      .prepare(
        "SELECT sender_handle, sender_role, src_chat_id, src_msg_id FROM msg_map WHERE recipient_chat_id = ? AND recipient_msg_id = ?",
      )
      .bind(recipientChatId, recipientMsgId)
      .first<MsgMapRow>();
  }

  // ---- settings ----

  async isPaused() {
    const row = await this.d1.prepare("SELECT value FROM settings WHERE key = 'paused'").first<{ value: string }>();
    return row?.value === "1";
  }

  async setPaused(paused: boolean) {
    await this.d1
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('paused', ?)")
      .bind(paused ? "1" : "0")
      .run();
  }

  // ---- admin ----

  /**
   * Replaces all pairings atomically; keeps join info for handles still on the list.
   * The current pairings are copied to `pairings_backup` first, so /undoupload can restore them.
   */
  async replacePairings(pairs: Pair[]) {
    const stmts: D1PreparedStatement[] = [
      this.d1.prepare("DELETE FROM pairings_backup"),
      this.d1.prepare("INSERT INTO pairings_backup (angel_handle, mortal_handle) SELECT angel_handle, mortal_handle FROM pairings"),
      this.d1.prepare("DELETE FROM pairings"),
    ];
    for (let i = 0; i < pairs.length; i += PAIRS_PER_INSERT) {
      const chunk = pairs.slice(i, i + PAIRS_PER_INSERT);
      const placeholders = chunk.map(() => "(?, ?)").join(", ");
      stmts.push(
        this.d1.prepare(`INSERT INTO pairings (angel_handle, mortal_handle) VALUES ${placeholders}`).bind(...chunk.flat()),
      );
    }
    stmts.push(
      this.d1.prepare(
        "INSERT OR IGNORE INTO participants (handle) SELECT angel_handle FROM pairings UNION SELECT mortal_handle FROM pairings",
      ),
      this.d1.prepare(
        "DELETE FROM participants WHERE handle NOT IN (SELECT angel_handle FROM pairings UNION SELECT mortal_handle FROM pairings)",
      ),
    );
    await this.d1.batch(stmts);
  }

  /** The pairings as they were before the last /upload or /undoupload. */
  async backupPairs(): Promise<Pair[]> {
    const { results } = await this.d1
      .prepare("SELECT angel_handle, mortal_handle FROM pairings_backup ORDER BY angel_handle")
      .all<{ angel_handle: string; mortal_handle: string }>();
    return results.map((r) => [r.angel_handle, r.mortal_handle]);
  }

  async allPairs() {
    const { results } = await this.d1
      .prepare(
        `SELECT x.angel_handle, x.mortal_handle,
                a.user_id IS NOT NULL AS angel_joined, m.user_id IS NOT NULL AS mortal_joined
         FROM pairings x
         JOIN participants a ON a.handle = x.angel_handle
         JOIN participants m ON m.handle = x.mortal_handle
         ORDER BY x.angel_handle`,
      )
      .all<PairRow>();
    return results;
  }

  async stats() {
    const row = await this.d1
      .prepare(
        `SELECT (SELECT COUNT(*) FROM participants) AS total,
                (SELECT COUNT(user_id) FROM participants) AS joined,
                (SELECT COUNT(DISTINCT src_chat_id || ':' || src_msg_id) FROM msg_map) AS relayed,
                (SELECT COUNT(*) FROM broadcast_queue) AS queued`,
      )
      .first<{ total: number; joined: number; relayed: number; queued: number }>();
    return row!;
  }

  async missing() {
    const { results } = await this.d1
      .prepare("SELECT handle FROM participants WHERE user_id IS NULL ORDER BY handle")
      .all<{ handle: string }>();
    return results.map((r) => r.handle);
  }

  /** Renames a handle everywhere. Returns false if `newHandle` is already taken. */
  async swapHandle(oldHandle: string, newHandle: string) {
    if (await this.byHandle(newHandle)) return false;
    await this.d1.batch([
      this.d1.prepare("UPDATE participants SET handle = ? WHERE handle = ?").bind(newHandle, oldHandle),
      this.d1.prepare("UPDATE pairings SET angel_handle = ? WHERE angel_handle = ?").bind(newHandle, oldHandle),
      this.d1.prepare("UPDATE pairings SET mortal_handle = ? WHERE mortal_handle = ?").bind(newHandle, oldHandle),
      this.d1.prepare("UPDATE msg_map SET sender_handle = ? WHERE sender_handle = ?").bind(newHandle, oldHandle),
    ]);
    return true;
  }

  /**
   * Detaches the Telegram account bound to `handle`, so the next account with that username can join.
   * Also forgets reply routing for messages that account sent or received.
   */
  async unbind(handle: string) {
    const p = await this.byHandle(handle);
    if (!p || p.user_id === null) return;
    await this.d1.batch([
      this.d1.prepare("DELETE FROM msg_map WHERE sender_handle = ? OR recipient_chat_id = ?").bind(handle, p.chat_id),
      this.d1
        .prepare("UPDATE participants SET user_id = NULL, chat_id = NULL, joined_at = NULL, target = 'mortal' WHERE handle = ?")
        .bind(handle),
    ]);
  }

  // ---- broadcast queue ----

  /** Queues `text` for every joined participant; returns how many were queued. */
  async queueBroadcast(text: string) {
    const res = await this.d1
      .prepare("INSERT INTO broadcast_queue (chat_id, text) SELECT chat_id, ? FROM participants WHERE chat_id IS NOT NULL")
      .bind(text)
      .run();
    return res.meta.changes;
  }

  /**
   * Atomically removes and returns the next `limit` queued deliveries, so the cron and an
   * in-request drain can never both send the same message.
   */
  async claimBroadcasts(limit: number) {
    const { results } = await this.d1
      .prepare(
        "DELETE FROM broadcast_queue WHERE id IN (SELECT id FROM broadcast_queue ORDER BY id LIMIT ?) RETURNING id, chat_id, text",
      )
      .bind(limit)
      .all<QueuedBroadcast>();
    return results.sort((a, b) => a.id - b.id);
  }

  /** Puts claimed-but-unsent deliveries back (e.g. after Telegram rate-limits us). */
  async requeueBroadcasts(items: QueuedBroadcast[]) {
    if (items.length === 0) return;
    const stmt = this.d1.prepare("INSERT INTO broadcast_queue (id, chat_id, text) VALUES (?, ?, ?)");
    await this.d1.batch(items.map((b) => stmt.bind(b.id, b.chat_id, b.text)));
  }
}
