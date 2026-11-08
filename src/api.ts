import { Hono } from "hono";
import type { Env } from "./types";
import { authenticate } from "./auth";
import { getHistory, getSetting, saveOffers, setSetting } from "./db";
import { buildItems, summarizeDeals } from "./deals";
import { silpoSource } from "./silpo";
import { SilpoMcpSource } from "./silpo/mcp";
import { addItem, defaultListId, primaryStoreId } from "./service";
import { collect } from "./jobs/collect";
import { sendDigest, tg } from "./telegram";
import { daysAgo, todayIn } from "./util/time";
import { seedDemo } from "./dev/seed";

type Ctx = { Bindings: Env; Variables: { email: string } };
export const api = new Hono<Ctx>().basePath("/api");

api.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

api.use("*", async (c, next) => {
  const r = await authenticate(c.env, c.req.raw);
  if (!r.ok) return c.json({ error: r.message }, r.status as 401);
  c.set("email", r.email);
  await next();
});

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error("Невірний id");
  return n;
};

/* ───── Загальне ───── */

api.get("/me", async (c) => {
  const db = c.env.DB;
  const [chat, stores, lastCheck] = await Promise.all([
    getSetting(db, "tg_chat_id"),
    db.prepare("SELECT COUNT(*) AS n FROM stores WHERE active = 1").first<{ n: number }>(),
    db.prepare("SELECT MAX(last_checked) AS t FROM collect_state").first<{ t: string | null }>(),
  ]);
  // Запам'ятовуємо адресу застосунку для посилань у Telegram.
  const origin = new URL(c.req.url).origin;
  if ((await getSetting(db, "app_url")) !== origin) await setSetting(db, "app_url", origin);
  return c.json({
    email: c.get("email"),
    mode: c.env.SILPO_MODE,
    telegramLinked: !!chat,
    telegramConfigured: !!c.env.TELEGRAM_BOT_TOKEN,
    stores: stores?.n ?? 0,
    lastCheck: lastCheck?.t ?? null,
    today: todayIn(c.env.TIMEZONE),
  });
});

/* ───── Списки ───── */

api.get("/lists", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.emoji, l.position,
            COUNT(i.id) AS total, SUM(CASE WHEN i.checked = 0 THEN 1 ELSE 0 END) AS open
     FROM lists l LEFT JOIN list_items i ON i.list_id = l.id
     GROUP BY l.id ORDER BY l.position, l.id`,
  ).all();
  return c.json({ lists: r.results, defaultListId: await defaultListId(c.env) });
});

api.post("/lists", async (c) => {
  const b = await c.req.json<{ name: string; emoji?: string }>();
  if (!b.name?.trim()) return c.json({ error: "Назва обов'язкова" }, 400);
  const r = await c.env.DB.prepare("INSERT INTO lists (name, emoji, position) VALUES (?1, ?2, (SELECT COALESCE(MAX(position), 0) + 1 FROM lists)) RETURNING *")
    .bind(b.name.trim(), b.emoji ?? null)
    .first();
  return c.json(r);
});

api.patch("/lists/:id", async (c) => {
  const id = num(c.req.param("id"));
  const b = await c.req.json<{ name?: string; emoji?: string; makeDefault?: boolean }>();
  if (b.name != null || b.emoji != null) {
    await c.env.DB.prepare("UPDATE lists SET name = COALESCE(?2, name), emoji = COALESCE(?3, emoji) WHERE id = ?1").bind(id, b.name?.trim() || null, b.emoji ?? null).run();
  }
  if (b.makeDefault) await setSetting(c.env.DB, "default_list_id", String(id));
  return c.json({ ok: true });
});

api.delete("/lists/:id", async (c) => {
  const id = num(c.req.param("id"));
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM lists").first<{ n: number }>();
  if ((n?.n ?? 0) <= 1) return c.json({ error: "Не можна видалити останній список" }, 400);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM list_items WHERE list_id = ?1").bind(id), c.env.DB.prepare("DELETE FROM lists WHERE id = ?1").bind(id)]);
  return c.json({ ok: true });
});

api.get("/lists/:id/items", async (c) => c.json({ items: await buildItems(c.env, { listId: num(c.req.param("id")) }) }));

api.post("/lists/:id/items", async (c) => {
  const listId = num(c.req.param("id"));
  const b = await c.req.json<{ productId?: string; query?: string; title?: string; quantity?: number; stockable?: boolean }>();
  if (!b.productId && !b.query?.trim()) return c.json({ error: "Потрібен товар або запит" }, 400);
  let title = b.title?.trim();
  if (!title && b.productId) {
    const p = await c.env.DB.prepare("SELECT name FROM products WHERE id = ?1").bind(b.productId).first<{ name: string }>();
    if (!p) return c.json({ error: "Товар не знайдено — спершу знайдіть його пошуком" }, 400);
    title = p.name;
  }
  const id = await addItem(c.env, { listId, productId: b.productId, query: b.query?.trim(), title: title ?? b.query!.trim(), quantity: b.quantity, stockable: b.stockable });
  const [item] = await buildItems(c.env, { itemId: id });
  return c.json(item);
});

api.patch("/items/:id", async (c) => {
  const id = num(c.req.param("id"));
  const b = await c.req.json<{ quantity?: number; checked?: boolean; note?: string | null; stockable?: boolean; title?: string; listId?: number }>();
  await c.env.DB.prepare(
    `UPDATE list_items SET
       quantity = COALESCE(?2, quantity), checked = COALESCE(?3, checked), note = CASE WHEN ?4 THEN ?5 ELSE note END,
       stockable = COALESCE(?6, stockable), title = COALESCE(?7, title), list_id = COALESCE(?8, list_id)
     WHERE id = ?1`,
  )
    .bind(id, b.quantity ?? null, b.checked == null ? null : b.checked ? 1 : 0, b.note !== undefined ? 1 : 0, b.note ?? null, b.stockable == null ? null : b.stockable ? 1 : 0, b.title?.trim() || null, b.listId ?? null)
    .run();
  const [item] = await buildItems(c.env, { itemId: id });
  return c.json(item ?? { ok: true });
});

api.delete("/items/:id", async (c) => {
  await c.env.DB.prepare("DELETE FROM list_items WHERE id = ?1").bind(num(c.req.param("id"))).run();
  return c.json({ ok: true });
});

api.post("/lists/:id/clear-checked", async (c) => {
  await c.env.DB.prepare("DELETE FROM list_items WHERE list_id = ?1 AND checked = 1").bind(num(c.req.param("id"))).run();
  return c.json({ ok: true });
});

/* ───── Товари, пошук, акції ───── */

api.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ results: [] });
  const store = await primaryStoreId(c.env);
  if (!store) return c.json({ error: "Спершу додайте магазин у налаштуваннях" }, 400);
  const results = await silpoSource(c.env).searchProducts(q, store, 15);
  await saveOffers(c.env.DB, results, todayIn(c.env.TIMEZONE));
  return c.json({ results });
});

api.get("/products/:id", async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const product = await db.prepare("SELECT * FROM products WHERE id = ?1").bind(id).first();
  if (!product) return c.json({ error: "Не знайдено" }, 404);
  const today = todayIn(c.env.TIMEZONE);
  const stores = (await db.prepare("SELECT id, name, kind FROM stores WHERE active = 1").all<{ id: string; name: string; kind: string }>()).results;
  const history = await Promise.all(stores.map(async (s) => ({ store: s, points: await getHistory(db, id, s.id, daysAgo(today, 90)) })));
  return c.json({ product, history });
});

api.get("/deals", async (c) => {
  const items = await buildItems(c.env);
  return c.json(summarizeDeals(items, todayIn(c.env.TIMEZONE)));
});

/** Пропозиції для стартового списку з історії замовлень (того, чого ще немає в списках). */
api.get("/suggestions", async (c) => {
  const hist = await silpoSource(c.env).getPurchaseHistory();
  const inLists = new Set(
    (await c.env.DB.prepare("SELECT DISTINCT product_id FROM list_items WHERE product_id IS NOT NULL").all<{ product_id: string }>()).results.map((r) => r.product_id),
  );
  return c.json({ suggestions: hist.filter((h) => !inLists.has(h.productId)).sort((a, b) => b.timesBought - a.timesBought) });
});

api.post("/suggestions/accept", async (c) => {
  const b = await c.req.json<{ listId: number; productIds: string[] }>();
  const store = await primaryStoreId(c.env);
  if (!store) return c.json({ error: "Спершу додайте магазин" }, 400);
  const offers = await silpoSource(c.env).getOffers(b.productIds, store);
  await saveOffers(c.env.DB, offers, todayIn(c.env.TIMEZONE));
  for (const o of offers) await addItem(c.env, { listId: b.listId, productId: o.productId, title: o.name });
  return c.json({ added: offers.length });
});

/* ───── Магазини ───── */

api.get("/stores", async (c) => c.json({ stores: (await c.env.DB.prepare("SELECT * FROM stores WHERE active = 1 ORDER BY kind, created_at").all()).results }));

api.get("/stores/search", async (c) => c.json({ stores: await silpoSource(c.env).listStores(c.req.query("q") || undefined) }));

api.post("/stores", async (c) => {
  const b = await c.req.json<{ id: string; name: string; kind?: "store" | "delivery" }>();
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM stores WHERE active = 1").first<{ n: number }>();
  if ((n?.n ?? 0) >= 4) return c.json({ error: "Не більше 4 магазинів (щоб вкластися в безкоштовні ліміти)" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO stores (id, name, kind, active) VALUES (?1, ?2, ?3, 1) ON CONFLICT(id) DO UPDATE SET active = 1, name = excluded.name, kind = excluded.kind",
  )
    .bind(b.id, b.name, b.kind ?? "store")
    .run();
  return c.json({ ok: true });
});

api.delete("/stores/:id", async (c) => {
  await c.env.DB.prepare("UPDATE stores SET active = 0 WHERE id = ?1").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

/* ───── Telegram ───── */

api.post("/telegram/link", async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN) return c.json({ error: "Бот ще не налаштований (немає TELEGRAM_BOT_TOKEN)" }, 400);
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const code = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await setSetting(c.env.DB, "tg_link_code", code);
  await setSetting(c.env.DB, "tg_link_expires", String(Date.now() + 3_600_000));
  const me = (await tg(c.env, "getMe", {})) as { username: string };
  return c.json({ code, link: `https://t.me/${me.username}?start=${code}` });
});

/** Реєструє вебхук бота на поточну адресу застосунку — щоб не робити це вручну. */
api.post("/telegram/webhook", async (c) => {
  if (!c.env.TELEGRAM_BOT_TOKEN || !c.env.TELEGRAM_WEBHOOK_SECRET) return c.json({ error: "Потрібні секрети TELEGRAM_BOT_TOKEN і TELEGRAM_WEBHOOK_SECRET" }, 400);
  const url = `${new URL(c.req.url).origin}/telegram/webhook`;
  await tg(c.env, "setWebhook", { url, secret_token: c.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"] });
  await tg(c.env, "setMyCommands", { commands: [{ command: "digest", description: "Що вигідно зараз" }, { command: "help", description: "Як додавати товари" }] });
  return c.json({ ok: true, url });
});

api.post("/telegram/test", async (c) => c.json({ result: await sendDigest(c.env, { force: true, appUrl: new URL(c.req.url).origin }) }));

/* ───── Обслуговування ───── */

api.post("/collect", async (c) => c.json(await collect(c.env, silpoSource(c.env))));

api.get("/silpo/tools", async (c) => {
  if (c.env.SILPO_MODE !== "mcp") return c.json({ error: "Доступно лише в режимі mcp" }, 400);
  return c.json({ tools: await new SilpoMcpSource(c.env).listTools() });
});

api.post("/dev/seed", async (c) => {
  if (c.env.SILPO_MODE !== "mock") return c.json({ error: "Лише в режимі mock" }, 400);
  return c.json(await seedDemo(c.env));
});
