import type { Env } from "./types";
import { getSetting, saveOffers, setSetting, deleteSetting } from "./db";
import { silpoSource } from "./silpo";
import { buildItems, isDeal, summarizeDeals, type ItemView } from "./deals";
import { addItem, defaultListId, primaryStoreId } from "./service";
import { todayIn } from "./util/time";
import { atbServerRun } from "./atb/server";

/* ───────────── Telegram API ───────────── */

export async function tg(env: Env, method: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не налаштований");
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`Telegram ${method}: ${json.description}`);
  return json.result;
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number) => `${n.toFixed(2).replace(".", ",")} ₴`;

async function send(env: Env, chatId: number | string, text: string, extra: Record<string, unknown> = {}) {
  return tg(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });
}

/* ───────────── Дайджест ───────────── */

function dealLine(i: ItemView): string {
  const o = i.main!.offers.find(isDeal)!;
  const old = o.analysis.typical ?? o.regularPrice;
  const badge = o.analysis.verdict === "record" ? "🔥" : o.analysis.verdict === "great" ? "🟢" : "🟡";
  const until = o.promoUntil ? `, до ${o.promoUntil.slice(8, 10)}.${o.promoUntil.slice(5, 7)}` : "";
  const where = i.main!.offers.filter(isDeal).length > 1 ? "" : ` · ${esc(o.storeName)}`;
  return `${badge} <b>${esc(i.main!.product.name)}</b> — ${money(o.price)}${old && old > o.price ? ` <s>${money(old)}</s>` : ""}${until}${where}`;
}

/** «(45,90 ₴/кг замість 62,00)» — порівняння аналога АТБ за ціною за одиницю, без відсотків. */
function analogPer(i: ItemView): string {
  const a = i.atb?.analog?.unit;
  const s = i.main?.best?.unit;
  return a && s && a.unit === s.unit ? ` (${money(a.value)}/${a.unit} замість ${money(s.value)})` : "";
}

/** Позиції, які в АТБ помітно дешевші, ніж у Сільпо. */
export function atbCheaper(items: ItemView[]) {
  const out: { item: ItemView; name: string; atb: number; silpo: number; diff: number; same: boolean }[] = [];
  for (const i of items) {
    if (i.checked || !i.atb || !i.main?.best) continue;
    const best = i.main.best;
    if (i.atb.same) {
      const diff = 1 - i.atb.same.price / best.price;
      if (diff >= 0.05) out.push({ item: i, name: i.atb.same.name, atb: i.atb.same.price, silpo: best.price, diff, same: true });
    } else if (i.atb.analog?.unit && best.unit && i.atb.analog.unit.unit === best.unit.unit) {
      const diff = 1 - i.atb.analog.unit.value / best.unit.value;
      if (diff >= 0.15) out.push({ item: i, name: i.atb.analog.name, atb: i.atb.analog.price, silpo: best.price, diff, same: false });
    }
  }
  return out.sort((a, b) => b.diff - a.diff);
}

export function formatDigest(items: ItemView[], today: string, appUrl?: string): string | null {
  const s = summarizeDeals(items, today);
  const atb = atbCheaper(items);
  if (!s.deals.length && !s.alternatives.length && !atb.length) return null;
  const parts: string[] = ["☀️ <b>Доброго ранку! Що вигідно сьогодні</b>"];

  if (s.deals.length) {
    parts.push("", `<b>З твоїх списків в акції (${s.deals.length}):</b>`, ...s.deals.slice(0, 15).map(dealLine));
    if (s.deals.length > 15) parts.push(`…і ще ${s.deals.length - 15}`);
  }
  const advice = s.deals
    .map((i) => ({ i, a: i.main!.best?.analysis.advice }))
    .filter((x) => x.a && /запас/.test(x.a))
    .slice(0, 3);
  if (advice.length) parts.push("", "<b>Варто запастися:</b>", ...advice.map((x) => `📦 ${esc(x.i.main!.product.name)}`));

  if (s.alternatives.length) {
    parts.push("", "<b>Схожі товари дешевше:</b>");
    for (const i of s.alternatives.slice(0, 5)) {
      const a = i.alternatives.find((x) => isDeal(x.best))!;
      const u = a.best!.unit;
      const mu = i.main?.best?.unit;
      const per = u && mu && u.unit === mu.unit ? ` (${money(u.value)}/${u.unit} замість ${money(mu.value)})` : "";
      parts.push(`🔄 замість «${esc(i.title)}» — ${esc(a.product.name)}, ${money(a.best!.price)}${per}`);
    }
  }
  if (atb.length) {
    parts.push("", `<b>В АТБ дешевше (${atb.length}):</b>`);
    for (const x of atb.slice(0, 6)) {
      parts.push(
        x.same
          ? `🔴 ${esc(x.item.title)} — ${money(x.atb)} в АТБ (у Сільпо ${money(x.silpo)})`
          : `🔴 ${esc(x.item.title)}: аналог ${esc(x.name)} — ${money(x.atb)}${analogPer(x.item)}`,
      );
    }
  }
  if (s.endingSoon.length) parts.push("", `⏰ Закінчуються сьогодні-завтра: ${s.endingSoon.map((i) => esc(i.title)).join(", ")}`);

  const stores = s.storeScores.filter((x) => x.deals > 0);
  if (stores.length > 1) {
    parts.push("", "<b>Де вигідніше:</b>", ...stores.slice(0, 3).map((x) => `🏬 ${esc(x.storeName)}: ${x.deals} акц., економія ~${x.saving} ₴`));
  }
  if (appUrl) parts.push("", `<a href="${appUrl}">Відкрити списки</a>`);
  return parts.join("\n");
}

export async function sendDigest(env: Env, opts: { force?: boolean; appUrl?: string } = {}): Promise<"sent" | "nothing" | "no_chat"> {
  const chatId = await getSetting(env.DB, "tg_chat_id");
  if (!chatId) return "no_chat";
  const items = await buildItems(env);
  const text = formatDigest(items, todayIn(env.TIMEZONE), opts.appUrl ?? (await getSetting(env.DB, "app_url")) ?? undefined);
  if (!text) {
    if (opts.force) await send(env, chatId, "Сьогодні вигідних акцій на товари з твоїх списків немає 🤷‍♀️");
    return "nothing";
  }
  await send(env, chatId, text);
  return "sent";
}

/* ───────────── Вебхук ───────────── */

interface TgUpdate {
  message?: { chat: { id: number }; text?: string; from?: { first_name?: string } };
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } };
}

/** Витягає пошуковий запит із посилання на silpo.ua (наприклад, .../product/moloko-galychyna-2-5-900ml-12345). */
export function queryFromSilpoUrl(text: string): string | null {
  const m = text.match(/https?:\/\/(?:www\.)?silpo\.ua\/\S+/i);
  if (!m) return null;
  try {
    const path = new URL(m[0]).pathname.split("/").filter(Boolean);
    const slug = decodeURIComponent(path.at(-1) ?? "");
    const words = slug.split("-").filter((w) => w && !/^\d{4,}$/.test(w));
    return words.join(" ") || null;
  } catch {
    return null;
  }
}

export async function handleWebhook(env: Env, req: Request, ctx?: ExecutionContext): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = (await req.json()) as TgUpdate;
  try {
    if (update.message) await onMessage(env, update.message);
    else if (update.callback_query) {
      await onCallback(env, update.callback_query);
      // товар додано з Telegram — одразу шукаємо його в АТБ (у фоні)
      ctx?.waitUntil(atbServerRun(env, 1).catch(() => {}));
    }
  } catch (e) {
    console.error("telegram handler", e);
    const chat = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    if (chat) await send(env, chat, `😕 Помилка: ${esc(e instanceof Error ? e.message : String(e))}`).catch(() => {});
  }
  // Telegram завжди отримує 200, щоб не повторював оновлення.
  return new Response("ok");
}

async function onMessage(env: Env, msg: NonNullable<TgUpdate["message"]>) {
  const chatId = msg.chat.id;
  const text = (msg.text ?? "").trim();
  const linked = await getSetting(env.DB, "tg_chat_id");

  // Прив'язка: /start КОД (код показується у веб-застосунку в налаштуваннях).
  if (text.startsWith("/start")) {
    const code = text.split(/\s+/)[1];
    const expected = await getSetting(env.DB, "tg_link_code");
    const expires = await getSetting(env.DB, "tg_link_expires");
    if (code && expected && code === expected && expires && Date.now() < Number(expires)) {
      await setSetting(env.DB, "tg_chat_id", String(chatId));
      await deleteSetting(env.DB, "tg_link_code");
      await send(env, chatId, `Привіт${msg.from?.first_name ? ", " + esc(msg.from.first_name) : ""}! 👋\nБот підключено. Щоранку надсилатиму акції на товари з твоїх списків.\n\nЩоб додати товар — просто напиши його назву або надішли посилання з silpo.ua.\n/digest — вигідне зараз`);
      return;
    }
    if (String(chatId) !== linked) {
      await send(env, chatId, "Щоб підключити бота, відкрий застосунок → Налаштування → «Підключити Telegram».");
      return;
    }
  }

  // Усі інші команди — лише з прив'язаного чату.
  if (String(chatId) !== linked) {
    await send(env, chatId, "Цей бот приватний 🙂");
    return;
  }

  if (text === "/digest" || text === "/deals") {
    const r = await sendDigest(env, { force: true });
    if (r === "no_chat") await send(env, chatId, "Чат не прив'язаний.");
    return;
  }
  if (text === "/help" || text === "/start") {
    await send(env, chatId, "Напиши назву товару (наприклад, «кава лаваца») або надішли посилання з silpo.ua — я запропоную варіанти для додавання в список.\n/digest — вигідне зараз");
    return;
  }
  if (!text || text.startsWith("/")) return;

  const query = queryFromSilpoUrl(text) ?? text;
  const src = silpoSource(env);
  const store = await primaryStoreId(env);
  if (!store) {
    await send(env, chatId, "Спершу вибери магазин у застосунку (Налаштування → Магазини).");
    return;
  }
  const found = await src.searchProducts(query, store, 6);
  if (found.length) await saveOffers(env.DB, found, todayIn(env.TIMEZONE));
  // загальний запит може бути довшим за ліміт callback_data (64 байти) — зберігаємо окремо
  await setSetting(env.DB, "tg_pending_query", query.slice(0, 200));

  const buttons = found.map((o) => [{ text: `${o.name} — ${o.price.toFixed(2)} ₴${o.regularPrice ? " 🏷" : ""}`.slice(0, 60), callback_data: `add:${o.productId}`.slice(0, 64) }]);
  buttons.push([{ text: `➕ Додати як «${query.slice(0, 30)}» (будь-який бренд)`, callback_data: "addq" }]);
  await send(env, chatId, found.length ? `Знайшла ${found.length} варіантів для «${esc(query)}». Що додати?` : `Нічого не знайдено для «${esc(query)}». Можу додати як загальну позицію:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function onCallback(env: Env, cb: NonNullable<TgUpdate["callback_query"]>) {
  const chatId = cb.message?.chat.id;
  const linked = await getSetting(env.DB, "tg_chat_id");
  if (!chatId || String(chatId) !== linked) {
    await tg(env, "answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  const listId = await defaultListId(env);
  const data = cb.data ?? "";
  let title: string | null = null;

  if (data.startsWith("add:")) {
    const productId = data.slice(4);
    const p = await env.DB.prepare("SELECT name FROM products WHERE id = ?1").bind(productId).first<{ name: string }>();
    if (p) {
      await addItem(env, { listId, productId, title: p.name });
      title = p.name;
    }
  } else if (data === "addq") {
    const q = await getSetting(env.DB, "tg_pending_query");
    if (q) {
      await addItem(env, { listId, query: q, title: q });
      title = `${q} (будь-який бренд)`;
    }
  }

  await tg(env, "answerCallbackQuery", { callback_query_id: cb.id, text: title ? "Додано ✅" : "Не вдалося додати" });
  if (title && cb.message) {
    const list = await env.DB.prepare("SELECT name FROM lists WHERE id = ?1").bind(listId).first<{ name: string }>();
    await tg(env, "editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: `✅ Додано в «${esc(list?.name ?? "список")}»: <b>${esc(title)}</b>`,
      parse_mode: "HTML",
    });
  }
}
