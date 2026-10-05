import { Api, webhookCallback, type Bot } from "grammy";
import { BROADCAST_CRON_BATCH, createBot, drainBroadcastQueue, type Env } from "./bot";
import { parseAdminIds } from "./config";
import { Db } from "./db";

const USER_COMMANDS = [
  { command: "start", description: "Join and see who your Mortal is" },
  { command: "mortal", description: "Send messages to your Mortal" },
  { command: "angel", description: "Send messages to your Angel" },
  { command: "whoismymortal", description: "Remind me who my Mortal is" },
  { command: "help", description: "How this bot works" },
];

const ADMIN_COMMANDS = [
  ...USER_COMMANDS,
  { command: "admin", description: "List admin commands" },
  { command: "upload", description: "Replace all pairings" },
  { command: "pairs", description: "List all pairings" },
  { command: "status", description: "Join and message counts" },
  { command: "missing", description: "Who hasn't started the bot" },
  { command: "broadcast", description: "Announce to everyone" },
  { command: "pause", description: "Pause all relaying" },
  { command: "resume", description: "Resume relaying" },
  { command: "swap", description: "Fix a participant's handle" },
  { command: "myid", description: "Show your Telegram ID" },
];

// Reuse the bot across requests in the same isolate, so grammY's getMe runs once, not per update.
let cached: { env: Env; bot: Bot } | undefined;
function getBot(env: Env): Bot {
  if (cached?.env !== env) cached = { env, bot: createBot(env) };
  return cached.bot;
}

/** Points Telegram at this Worker and sets the command menus. Protected by WEBHOOK_SECRET. */
async function setup(url: URL, env: Env): Promise<Response> {
  if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });

  const api = new Api(env.BOT_TOKEN);
  const webhookUrl = `${url.origin}/webhook`;
  const log: string[] = [];

  await api.setWebhook(webhookUrl, { secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message"] });
  log.push(`✅ Webhook set to ${webhookUrl}`);

  await api.setMyCommands(USER_COMMANDS);
  log.push("✅ Participant command menu set");

  const { ids: adminIds, invalid } = parseAdminIds(env.ADMIN_IDS);
  for (const bad of invalid) log.push(`⚠️ Ignoring "${bad}" in ADMIN_IDS: not a Telegram user ID`);
  for (const id of adminIds) {
    try {
      await api.setMyCommands(ADMIN_COMMANDS, { scope: { type: "chat", chat_id: id } });
      log.push(`✅ Admin command menu set for ${id}`);
    } catch (err) {
      log.push(`⚠️ Admin menu for ${id} failed (have they sent /start to the bot?): ${err}`);
    }
  }
  if (adminIds.length === 0) {
    log.push("ℹ️ No admins: send /myid to the bot, run `npx wrangler secret put ADMIN_IDS` with it, then open /setup again");
  }

  const info = await api.getWebhookInfo();
  log.push("", `Webhook info: pending updates ${info.pending_update_count}, last error: ${info.last_error_message ?? "none"}`);
  return new Response(log.join("\n"), { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhook") {
      // Reject anything not from Telegram before touching the bot: grammY would call getMe first.
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      return webhookCallback(getBot(env), "cloudflare-mod", {
        timeoutMilliseconds: 25_000,
        onTimeout: "return",
      })(request);
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      try {
        return await setup(url, env);
      } catch (err) {
        return new Response(`❌ Setup failed: ${err}`, { status: 500 });
      }
    }

    return new Response("Angel & Mortal bot is running.");
  },

  // Cron trigger (every minute, see wrangler.toml): deliver queued /broadcast messages.
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      drainBroadcastQueue(new Api(env.BOT_TOKEN), new Db(env.DB), BROADCAST_CRON_BATCH).then(({ sent, failed }) => {
        if (sent || failed) console.log(`broadcast cron: ${sent} sent, ${failed} failed`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
