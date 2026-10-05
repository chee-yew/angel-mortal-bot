import { Api, Bot, GrammyError, Keyboard, type Context } from "grammy";
import type { Message, MessageEntity } from "grammy/types";
import { Db, type Participant, type Role } from "./db";

export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  ADMIN_IDS: string;
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

const HELP = `👼 E Block Angel & Mortal bot

You have a Mortal (you know who they are, and you welfare them) and an Angel (they welfare you, and they're a secret!).

• Tap "${BTN_MORTAL}" or "${BTN_ANGEL}" to choose who your messages go to. It stays that way until you switch.
• Then just send anything: text, photos, stickers, voice notes, videos, files.
• To answer a specific message, use Telegram's Reply on it. Your reply goes back to whoever sent it, whichever mode you're in.
• 👍 on your message means it was delivered.

Your identity is never shown, but watch what you write (and your voice in voice notes 😉) if you're the angel!

Note: editing or deleting a message after sending does NOT change the copy the other person got.

Commands: /mortal /angel /whoismymortal /help`;

const flip = (role: Role): Role => (role === "mortal" ? "angel" : "mortal");

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

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN);
  const db = new Db(env.DB);
  const admins = new Set(
    env.ADMIN_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
  const isAdmin = (ctx: Context) => !!ctx.from && admins.has(ctx.from.id);

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
