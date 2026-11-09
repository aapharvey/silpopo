import type { Env } from "./types";
import { getSetting, setSetting } from "./db";

/**
 * АТБ через «збирач» на iPhone (застосунок «Команди»).
 *
 * Сайт АТБ блокує серверні адреси, тому сторінки завантажує телефон (домашня/мобільна адреса),
 * а весь розбір відбувається тут. Збирач «тупий»: питає адресу → завантажує → надсилає назад.
 *
 *   GET  /atb/next?key=…    → адреса сторінки АТБ, яку треба завантажити (text/plain)
 *   POST /atb/ingest?key=…  ← сирий HTML цієї сторінки
 *
 * Зараз (етап 0) це перевірка: чи віддає АТБ справжню сторінку і як вона влаштована.
 */

const KEY = "atb_key";
const LAST = "atb_last_probe";
const NEXT = "atb_next_url";

// Що завантажити під час перевірки: пошук АТБ (якщо адреса неточна, сторінка все одно покаже, чи пускає сайт).
const PROBE_URL = "https://www.atbmarket.com/sch?lang=uk&query=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE";

export async function atbKey(env: Env, rotate = false): Promise<string> {
  let k = rotate ? null : await getSetting(env.DB, KEY);
  if (!k) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    k = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    await setSetting(env.DB, KEY, k);
  }
  return k;
}

async function keyOk(env: Env, url: URL): Promise<boolean> {
  const k = await getSetting(env.DB, KEY);
  const given = url.searchParams.get("key") ?? "";
  if (!k || given.length !== k.length) return false;
  let r = 0;
  for (let i = 0; i < k.length; i++) r |= k.charCodeAt(i) ^ given.charCodeAt(i);
  return r === 0;
}

export interface ProbeResult {
  at: string;
  url: string;
  bytes: number;
  verdict: "ok" | "challenge" | "blocked" | "empty" | "unknown";
  title: string | null;
  productLinks: number;
  priceMarks: number;
  jsonLd: boolean;
  sampleLinks: string[];
  message: string;
}

/** Швидкий аналіз сторінки: чи це перевірка Cloudflare, чи справжній каталог. */
export function analyzeAtbHtml(html: string, url: string): ProbeResult {
  const lower = html.slice(0, 200_000).toLowerCase();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim() || null;
  const isChallenge =
    /just a moment|checking your browser|cf-chl|challenge-platform|cf_chl_opt|turnstile/.test(lower) && !/product/.test(lower.slice(0, 50_000));
  const isBlocked = /attention required|access denied|error 1020|you have been blocked|sorry, you have been blocked/.test(lower);

  const links = [...html.matchAll(/href="(\/product\/[^"?#]+)"/g)].map((m) => m[1]!);
  const uniq = [...new Set(links)];
  const priceMarks = (html.match(/₴|грн/g) ?? []).length;
  const jsonLd = /application\/ld\+json/i.test(html);

  let verdict: ProbeResult["verdict"] = "unknown";
  if (html.length < 500) verdict = "empty";
  else if (isBlocked) verdict = "blocked";
  else if (isChallenge) verdict = "challenge";
  else if (uniq.length > 0 || priceMarks > 5) verdict = "ok";

  const kb = Math.round(html.length / 1024);
  const message =
    verdict === "ok"
      ? `✅ АТБ віддав справжню сторінку (${kb} КБ): ${uniq.length} посилань на товари, ${priceMarks} цін. Збирач на iPhone працюватиме!`
      : verdict === "challenge"
        ? `⚠️ АТБ показав перевірку «я не робот» (${kb} КБ). Завантаження без браузера не проходить — спробуємо інший спосіб.`
        : verdict === "blocked"
          ? `⛔ АТБ заблокував запит (${kb} КБ).`
          : verdict === "empty"
            ? `⚠️ Прийшла порожня відповідь (${html.length} байт). Перевірте третій крок команди: тіло запиту має бути «Файл» з результатом другого кроку.`
            : `❓ Сторінка отримана (${kb} КБ, «${title ?? "без заголовка"}»), але товарів не знайдено — розберу її вручну.`;

  return { at: new Date().toISOString(), url, bytes: html.length, verdict, title, productLinks: uniq.length, priceMarks, jsonLd, sampleLinks: uniq.slice(0, 8), message };
}

/** Надсилає сторінку файлом у Telegram, щоб її можна було передати на розбір. */
async function sendToTelegram(env: Env, html: string, r: ProbeResult) {
  const chat = await getSetting(env.DB, "tg_chat_id");
  if (!chat || !env.TELEGRAM_BOT_TOKEN) return;
  const form = new FormData();
  form.set("chat_id", chat);
  form.set("caption", `АТБ, перевірка збирача\n${r.message}\n${r.url}`.slice(0, 1000));
  form.set("document", new Blob([html], { type: "text/html" }), `atb-${r.at.slice(0, 16).replace(/[:T]/g, "-")}.html`);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form }).catch(() => {});
}

export async function handleAtb(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const text = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!(await keyOk(env, url))) return text("Невірний ключ. Скопіюйте адреси заново з Налаштувань Silpopo → АТБ.", 403);

  if (url.pathname === "/atb/next" && req.method === "GET") {
    const next = PROBE_URL;
    await setSetting(env.DB, NEXT, next);
    return text(next);
  }

  if (url.pathname === "/atb/ingest" && req.method === "POST") {
    const html = await req.text();
    const target = (await getSetting(env.DB, NEXT)) ?? PROBE_URL;
    const r = analyzeAtbHtml(html, target);
    await setSetting(env.DB, LAST, JSON.stringify(r));
    ctx.waitUntil(sendToTelegram(env, html, r));
    return text(r.message);
  }

  return text("Not found", 404);
}

export async function atbStatus(env: Env) {
  const last = await getSetting(env.DB, LAST);
  return { key: await atbKey(env), last: last ? (JSON.parse(last) as ProbeResult) : null };
}
