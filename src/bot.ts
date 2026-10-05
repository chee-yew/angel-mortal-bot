import { Api, Bot, GrammyError, Keyboard, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { parseAdminIds } from "./config";
import { Db, type Participant, type Role } from "./db";
import { normaliseHandle, parsePairings } from "./pairings";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Secret, not a var: comma-separated Telegram user IDs. Unset means no admins. */
  ADMIN_IDS?: string;
  EVENT_NAME?: string;
  DB: D1Database;
}

const BTN_ANGEL = "😇 Chat with Angel";
const BTN_MORTAL = "🙂 Chat with Mortal";
const BTN_HELP = "❓ Help";

const KEYBOARD = new Keyboard().text(BTN_ANGEL).text(BTN_MORTAL).row().text(BTN_HELP).resized().persistent();

/** Header shown to the recipient, keyed by the sender's role relative to them. */
const LABEL: Record<Role, string> = {
  angel: "😇 From your Angel",
  mortal: "🙂 From your Mortal",
};

const helpText = (eventName: string) => `👼 ${eventName} bot

You have a Mortal (you know who they are, and you welfare them) and an Angel (they welfare you, and they're a secret!).

• Tap "${BTN_MORTAL}" or "${BTN_ANGEL}" to choose who your messages go to. It stays that way until you switch.
• Then just send anything: text, photos, stickers, voice notes, videos, files.
• To answer a specific message, use Telegram's Reply on it. Your reply goes back to whoever sent it, whichever mode you're in.
• 👍 on your message means it was delivered.

Your identity is never shown, but watch what you write (and your voice in voice notes 😉) if you're the angel!

Note: editing or deleting a message after sending does NOT change the copy the other person got.

Commands: /mortal /angel /whoismymortal /help`;

const ADMIN_HELP = `🛠 Admin commands

/upload: replace all pairings (paste "angel,mortal" lines after the command, or send a .csv with /upload as caption)
/pairs: list every pairing and who hasn't joined
/status: join and message counts
/missing: handles that haven't started the bot
/broadcast <message>: announce to everyone who has joined
/pause, /resume: stop/start all relaying
/swap @old @new: fix a participant's handle
/myid: show your Telegram ID`;

const flip = (role: Role): Role => (role === "mortal" ? "angel" : "mortal");

/** Joins up to 20 lines, noting how many were left out. */
function clip(lines: string[], max = 20): string {
  const shown = lines.slice(0, max).map((l) => `• ${l}`);
  if (lines.length > max) shown.push(`…and ${lines.length - max} more`);
  return shown.join("\n");
}

/** Splits lines into messages under Telegram's 4096-character limit. */
function chunkLines(lines: string[], limit = 4000): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    if (current && current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line;
  }
  if (current) chunks.push(current);
  return chunks;
}

function shift(entities: MessageEntity[] | undefined, by: number): MessageEntity[] {
  return (entities ?? []).map((e) => ({ ...e, offset: e.offset + by }));
}

/**
 * Re-sends `msg` to `chatId` without any trace of the original sender, prefixed with `label`.
 * Returns the ids of every message created in the recipient's chat.
 */
async function deliver(api: Api, msg: Message, chatId: number, label: string, replyTo?: number): Promise<number[]> {
  const header = `${label}:\n`;
  const bold: MessageEntity = { type: "bold", offset: 0, length: label.length + 1 };
  const reply_parameters = replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;

  if (msg.text !== undefined && header.length + msg.text.length <= 4096) {
    const sent = await api.sendMessage(chatId, header + msg.text, {
      entities: [bold, ...shift(msg.entities, header.length)],
      link_preview_options: msg.link_preview_options,
      reply_parameters,
    });
    return [sent.message_id];
  }

  const captionable = !!(msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice);
  const caption = msg.caption ?? "";
  if (captionable && header.length + caption.length <= 1024) {
    const sent = await api.copyMessage(chatId, msg.chat.id, msg.message_id, {
      caption: header + caption,
      caption_entities: [bold, ...shift(msg.caption_entities, header.length)],
      show_caption_above_media: msg.show_caption_above_media,
      reply_parameters,
    });
    return [sent.message_id];
  }

  // Stickers, video notes, locations, over-long text... send the label separately.
  const head = await api.sendMessage(chatId, label, {
    entities: [{ type: "bold", offset: 0, length: label.length }],
    reply_parameters,
  });
  const sent = await api.copyMessage(chatId, msg.chat.id, msg.message_id);
  return [head.message_id, sent.message_id];
}

const ANNOUNCEMENT = "📢 Announcement from the organisers";

// Each send is one outgoing request; stay well under the free plan's 50 per invocation.
const BROADCAST_INLINE_BATCH = 25;
export const BROADCAST_CRON_BATCH = 40;

/**
 * Sends up to `limit` queued broadcast messages. Called inline by /broadcast and every minute by
 * the cron trigger. The free Workers plan allows only 50 outgoing requests per invocation, so a
 * broadcast to ~60 people has to be spread across invocations.
 */
export async function drainBroadcastQueue(api: Api, db: Db, limit: number) {
  const batch = await db.claimBroadcasts(limit);
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < batch.length; i++) {
    const { chat_id, text } = batch[i];
    try {
      await api.sendMessage(chat_id, `${ANNOUNCEMENT}\n\n${text}`, {
        entities: [{ type: "bold", offset: 0, length: ANNOUNCEMENT.length }],
      });
      sent++;
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        // Rate limited: put this and the rest back for the next cron run.
        await db.requeueBroadcasts(batch.slice(i));
        break;
      }
      // Blocked the bot, deleted account, etc. Retrying won't help.
      console.error(`broadcast to ${chat_id} failed:`, err);
      failed++;
    }
  }
  return { sent, failed };
}

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  const db = new Db(env.DB);
  const admins = new Set(parseAdminIds(env.ADMIN_IDS).ids);
  const isAdmin = (ctx: Context) => !!ctx.from && admins.has(ctx.from.id);
  const HELP = helpText(env.EVENT_NAME?.trim() || "Angel & Mortal");

  // Never let one bad update fail the webhook (Telegram would retry it forever).
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error(`update ${ctx.update.update_id} failed:`, err);
    }
  });

  const pm = bot.chatType("private");

  /** Finds the sender's participant record, binding their Telegram account on first contact. */
  async function resolve(ctx: Context): Promise<Participant | null> {
    const from = ctx.from!;
    const known = await db.byUserId(from.id);
    if (known) return known;

    const username = from.username?.toLowerCase();
    if (!username) return null;
    const p = await db.byHandle(username);
    if (!p || (p.user_id !== null && p.user_id !== from.id)) return null;

    await db.bindUser(p.handle, from.id, ctx.chat!.id);
    return { ...p, user_id: from.id, chat_id: ctx.chat!.id };
  }

  async function requireParticipant(ctx: Context): Promise<Participant | null> {
    const p = await resolve(ctx);
    if (p) return p;
    const from = ctx.from!;
    if (!from.username) {
      await ctx.reply(
        "You don't have a Telegram username yet, so I can't match you to the participant list.\n\n" +
          "Set one in Telegram Settings → Username, make sure the organiser has it, then send /start again.",
      );
    } else if (!isAdmin(ctx)) {
      await ctx.reply(
        `@${from.username} isn't on the participant list. If you think this is a mistake, contact the organiser.\n\n(Your Telegram ID: ${from.id})`,
      );
    } else {
      await ctx.reply("You're an admin but not a participant. Send /admin for admin commands.");
    }
    return null;
  }

  async function chooseTarget(ctx: Context, role: Role) {
    const me = await requireParticipant(ctx);
    if (!me) return;
    const partner = await db.partner(me.handle, role);
    if (!partner) {
      await ctx.reply(`You don't have ${role === "angel" ? "an angel" : "a mortal"} assigned. Contact the organiser.`);
      return;
    }
    await db.setTarget(me.handle, role);
    let text =
      role === "mortal"
        ? `🙂 Now messaging your Mortal (@${partner.handle}). Everything you send goes to them anonymously.`
        : "😇 Now messaging your Angel. Everything you send goes to them.";
    if (partner.chat_id === null) {
      text += `\n\n⚠️ Your ${role} hasn't started the bot yet, so messages can't be delivered until they do.`;
    }
    await ctx.reply(text, { reply_markup: KEYBOARD });
  }

  pm.command("start", async (ctx) => {
    const me = await requireParticipant(ctx);
    if (!me) return;
    const mortal = await db.partner(me.handle, "mortal");
    const target = me.target === "angel" ? "your Angel 😇" : "your Mortal 🙂";
    await ctx.reply(
      `Welcome, @${me.handle}! 🎉\n\n` +
        (mortal ? `Your Mortal is @${mortal.handle}. Take good care of them!\n\n` : "") +
        `Messages you send right now go to ${target}. Use the buttons below to switch.\n\n${HELP}`,
      { reply_markup: KEYBOARD },
    );
  });

  pm.command("help", (ctx) => ctx.reply(HELP, { reply_markup: KEYBOARD }));
  pm.hears(BTN_HELP, (ctx) => ctx.reply(HELP, { reply_markup: KEYBOARD }));
  pm.command("myid", (ctx) => ctx.reply(`Your Telegram ID: ${ctx.from.id}`));

  pm.command("mortal", (ctx) => chooseTarget(ctx, "mortal"));
  pm.hears(BTN_MORTAL, (ctx) => chooseTarget(ctx, "mortal"));
  pm.command("angel", (ctx) => chooseTarget(ctx, "angel"));
  pm.hears(BTN_ANGEL, (ctx) => chooseTarget(ctx, "angel"));

  pm.command("whoismymortal", async (ctx) => {
    const me = await requireParticipant(ctx);
    if (!me) return;
    const mortal = await db.partner(me.handle, "mortal");
    await ctx.reply(mortal ? `Your Mortal is @${mortal.handle} 🙂` : "You don't have a mortal assigned.");
  });

  // ---- admin commands (non-admins fall through to "Unknown command") ----

  const admin = pm.filter(isAdmin);

  admin.command("admin", (ctx) => ctx.reply(ADMIN_HELP));

  admin.command("upload", (ctx) => handleUpload(ctx, ctx.match));

  // grammY only matches commands in message text, so catch "/upload" as a file caption here.
  admin
    .on("message:document")
    .filter((ctx) => /^\/upload\b/.test(ctx.msg.caption ?? ""))
    .use(async (ctx) => {
      const file = await ctx.api.getFile(ctx.msg.document.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`);
      await handleUpload(ctx, await res.text());
    });

  async function handleUpload(ctx: Context, text: string) {
    if (!text.trim()) {
      await ctx.reply(
        "Send /upload followed by one pairing per line:\n\n/upload\nangel_handle,mortal_handle\nangel_handle,mortal_handle\n\n" +
          "Or send a .csv file with /upload as its caption.",
      );
      return;
    }

    const { pairs, errors, warnings } = parsePairings(text);
    if (errors.length) {
      await ctx.reply(`❌ Nothing saved. Fix these and upload again:\n\n${clip(errors)}`);
      return;
    }
    await db.replacePairings(pairs);
    const { total, joined } = await db.stats();
    let reply = `✅ Saved ${pairs.length} pairings (${total} participants, ${joined} already joined).`;
    if (warnings.length) reply += `\n\n⚠️ Warnings:\n${clip(warnings)}`;
    await ctx.reply(reply);
  }

  admin.command("status", async (ctx) => {
    const s = await db.stats();
    await ctx.reply(
      `📊 Status\n\nParticipants: ${s.total}\nJoined the bot: ${s.joined}/${s.total}\n` +
        `Messages relayed: ${s.relayed}\nBroadcasts queued: ${s.queued}\n` +
        `Relay: ${(await db.isPaused()) ? "⏸ paused" : "▶️ running"}`,
    );
  });

  admin.command("missing", async (ctx) => {
    const handles = await db.missing();
    await ctx.reply(
      handles.length
        ? `${handles.length} haven't started the bot yet:\n\n${handles.map((h) => `@${h}`).join("\n")}`
        : "🎉 Everyone has started the bot!",
    );
  });

  admin.command("pairs", async (ctx) => {
    const rows = await db.allPairs();
    if (!rows.length) {
      await ctx.reply("No pairings uploaded yet. Use /upload.");
      return;
    }
    const mark = (joined: number) => (joined ? "" : " ⏳");
    const lines = rows.map((r) => `@${r.angel_handle}${mark(r.angel_joined)} → @${r.mortal_handle}${mark(r.mortal_joined)}`);
    for (const chunk of chunkLines(["Angel → Mortal (⏳ = not joined)", "", ...lines])) await ctx.reply(chunk);
  });

  admin.command("pause", async (ctx) => {
    await db.setPaused(true);
    await ctx.reply("⏸ Relay paused. Participants will be told to try later. /resume to restart.");
  });

  admin.command("resume", async (ctx) => {
    await db.setPaused(false);
    await ctx.reply("▶️ Relay resumed.");
  });

  admin.command("broadcast", async (ctx) => {
    const text = ctx.match.trim();
    if (!text) {
      await ctx.reply("Usage: /broadcast <message>\n\nSends the message to everyone who has started the bot.");
      return;
    }
    const queued = await db.queueBroadcast(text);
    if (queued === 0) {
      await ctx.reply("Nobody has started the bot yet, so there's no one to send to.");
      return;
    }
    // Send the first batch now; the cron trigger delivers the rest within a minute or two.
    const { sent, failed } = await drainBroadcastQueue(ctx.api, db, BROADCAST_INLINE_BATCH);
    const remaining = queued - sent - failed;
    let reply = `📢 Broadcast to ${queued} people: ${sent} sent now`;
    if (failed) reply += `, ${failed} failed (they blocked the bot)`;
    reply += remaining > 0 ? `, ${remaining} more within ~${Math.ceil(remaining / BROADCAST_CRON_BATCH)} min.` : ".";
    await ctx.reply(reply);
  });

  admin.command("swap", async (ctx) => {
    const [oldHandle, newHandle] = ctx.match.split(/\s+/).map(normaliseHandle);
    if (!oldHandle || !newHandle) {
      await ctx.reply("Usage: /swap @old_handle @new_handle");
      return;
    }
    if (!(await db.byHandle(oldHandle))) {
      await ctx.reply(`@${oldHandle} isn't a participant.`);
      return;
    }
    if (!(await db.swapHandle(oldHandle, newHandle))) {
      await ctx.reply(`@${newHandle} is already a participant.`);
      return;
    }
    await ctx.reply(`✅ @${oldHandle} is now @${newHandle}. Their pairings are unchanged.`);
  });

  // ---- relay: must be registered last ----

  pm.on("message", async (ctx) => {
    const msg = ctx.msg;
    if (msg.text?.startsWith("/")) {
      await ctx.reply("Unknown command. Send /help to see what I can do.");
      return;
    }

    const me = await requireParticipant(ctx);
    if (!me) return;
    if (await db.isPaused()) {
      await ctx.reply("⏸ Messaging is paused by the organisers right now. Please try again later.");
      return;
    }

    // A Telegram "Reply" to a relayed message goes back to whoever sent it, whatever the current mode.
    let role = me.target;
    let replyTo: number | undefined;
    let dest: Participant | null = null;
    if (msg.reply_to_message) {
      const origin = await db.getMap(ctx.chat.id, msg.reply_to_message.message_id);
      if (origin) {
        const candidate = await db.partner(me.handle, origin.sender_role);
        // Ignore stale mappings if the pairings were re-uploaded since.
        if (candidate?.handle === origin.sender_handle) {
          role = origin.sender_role;
          dest = candidate;
          replyTo = origin.src_msg_id;
        }
      }
    }
    dest ??= await db.partner(me.handle, role);
    if (!dest) {
      await ctx.reply(`You don't have ${role === "angel" ? "an angel" : "a mortal"} assigned. Contact the organiser.`);
      return;
    }
    if (dest.chat_id === null) {
      await ctx.reply(`⚠️ Your ${role} hasn't started the bot yet, so this message was NOT delivered. Try again later.`);
      return;
    }

    let sentIds: number[];
    try {
      sentIds = await deliver(ctx.api, msg, dest.chat_id, LABEL[flip(role)], replyTo);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 403) {
        await ctx.reply(`⚠️ Not delivered: your ${role} has blocked or stopped the bot.`);
        return;
      }
      if (err instanceof GrammyError && err.error_code === 400) {
        await ctx.reply("⚠️ Sorry, I can't relay this kind of message.");
        return;
      }
      throw err;
    }

    await db.saveMap(dest.chat_id, sentIds, {
      sender_handle: me.handle,
      sender_role: flip(role),
      src_chat_id: ctx.chat.id,
      src_msg_id: msg.message_id,
    });
    await ctx.react("👍").catch(() => {});
  });

  return bot;
}
