import type { Env } from "./types";
import { api } from "./api";
import { handleWebhook, sendDigest } from "./telegram";
import { collect } from "./jobs/collect";
import { silpoSource } from "./silpo";
import { getSetting, setSetting } from "./db";
import { hourIn, todayIn } from "./util/time";
import { finishAuth, recordAuthError } from "./silpo/oauth";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/telegram/webhook" && req.method === "POST") return handleWebhook(env, req);
    // Повернення зі сторінки входу Сільпо. Захищено одноразовим state, збереженим на сервері.
    if (url.pathname === "/oauth/callback") {
      try {
        await finishAuth(env, url);
        return Response.redirect(`${url.origin}/?silpo=ok#/settings`, 302);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await recordAuthError(env, msg);
        return Response.redirect(`${url.origin}/?silpo=error#/settings`, 302);
      }
    }
    if (url.pathname.startsWith("/api/")) return api.fetch(req, env, ctx);
    return env.ASSETS.fetch(req);
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (event.cron === "5 * * * *") {
      // Ранковий дайджест: cron у UTC, тому перевіряємо годину за Києвом (враховує перехід на літній час).
      const today = todayIn(env.TIMEZONE);
      if (hourIn(env.TIMEZONE) !== Number(env.DIGEST_HOUR)) return;
      if ((await getSetting(env.DB, "digest_last_day")) === today) return;
      const r = await sendDigest(env);
      if (r !== "no_chat") await setSetting(env.DB, "digest_last_day", today);
      return;
    }
    ctx.waitUntil(
      collect(env, silpoSource(env)).then(
        (r) => console.log("collect", JSON.stringify(r)),
        (e) => console.error("collect error", e),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
