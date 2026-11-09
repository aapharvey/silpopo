import type { Env } from "../types";
import { getSetting, setSetting } from "../db";
import { todayIn } from "../util/time";
import { currentShopId, parseAtbCards, type AtbCard } from "./parse";
import { atbQueryFor, matchCards } from "./match";

/**
 * АТБ через «збирач» на iPhone (застосунок «Команди»).
 *
 * Сайт АТБ блокує серверні адреси, тому сторінки завантажує телефон (домашня/мобільна адреса),
 * а весь розбір відбувається тут. Збирач «тупий»: питає адресу → завантажує → надсилає назад.
 *
 *   GET  /atb/next?key=…    → адреса сторінки АТБ, яку треба завантажити (text/plain)
 *   POST /atb/ingest?key=…  ← сирий HTML цієї сторінки
 *
 * Збирач щоночі проходить чергу пошукових сторінок АТБ (по одній на товар зі списків),
 * а тут ми зберігаємо ціни та зіставляємо товари АТБ із товарами Сільпо.
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

interface Task {
  q: string; // пошуковий запит на сайті АТБ
  refs: string[]; // для яких позицій списку (id товару Сільпо або "q:<запит>")
}
interface Queue {
  built: string;
  pos: number;
  tasks: Task[];
}
export interface RunStats {
  started: string;
  last: string;
  pages: number;
  cards: number;
  verdict: ProbeResult["verdict"];
  message?: string;
}

const QUEUE = "atb_queue";
const CURRENT = "atb_current";
const RUN = "atb_run";
const MAX_TASKS = 40;

export const atbSearchUrl = (q: string) => `https://www.atbmarket.com/sch?lang=uk&query=${encodeURIComponent(q)}`;

/** Черга на ніч: по одній сторінці пошуку на кожен некуплений товар зі списків. */
/**
 * Черга лише з «несвіжих» позицій: тих, що сьогодні ще не перевірялись в АТБ (нові — першими).
 * Тому нічний запуск проходить усе, а запуск вдень — тільки щойно додані товари (кілька секунд).
 */
async function buildQueue(env: Env): Promise<Task[]> {
  const day = todayIn(env.TIMEZONE);
  const rows = (
    await env.DB.prepare(
      `SELECT li.product_id, li.query, p.name,
              (SELECT a.name FROM atb_matches m JOIN atb_products a ON a.id = m.atb_id
                WHERE m.ref = li.product_id AND m.kind = 'same' AND m.status IN ('confirmed', 'suggested')
                ORDER BY m.status = 'confirmed' DESC LIMIT 1) AS atb_name,
              l.last_ok, l.fail_day, l.fails
       FROM list_items li
       LEFT JOIN products p ON p.id = li.product_id
       LEFT JOIN atb_search_log l ON l.ref = COALESCE(li.product_id, 'q:' || li.query)
       WHERE li.checked = 0
         AND (l.last_ok IS NULL OR l.last_ok < ?1)
         AND (COALESCE(l.fail_day, '') != ?1 OR COALESCE(l.fails, 0) < 3)
       ORDER BY l.ref IS NOT NULL, li.id DESC`,
    )
      .bind(day)
      .all<{ product_id: string | null; query: string | null; name: string | null; atb_name: string | null }>()
  ).results;
  const byQ = new Map<string, Task>();
  for (const r of rows) {
    const ref = r.product_id ?? (r.query ? `q:${r.query}` : null);
    if (!ref) continue;
    // Якщо «той самий» товар уже знайдено — шукаємо його точною назвою, інакше — короткий запит.
    const q = (r.atb_name ?? (r.name ? atbQueryFor(r.name) : r.query) ?? "").trim();
    if (!q) continue;
    const t = byQ.get(q) ?? { q, refs: [] };
    if (!t.refs.includes(ref)) t.refs.push(ref);
    byQ.set(q, t);
  }
  return [...byQ.values()].slice(0, MAX_TASKS);
}

async function nextTask(env: Env): Promise<Task | null> {
  const raw = await getSetting(env.DB, QUEUE);
  let q = raw ? (JSON.parse(raw) as Queue) : null;
  // Черга закінчилась (або її немає) — одразу збираємо нову з того, що сьогодні ще не перевірено.
  if (!q || q.pos >= q.tasks.length) {
    q = { built: new Date().toISOString(), pos: 0, tasks: await buildQueue(env) };
    await setSetting(env.DB, QUEUE, JSON.stringify(q));
    // Новий прогін, якщо попередній закінчився понад 20 хв тому — інакше продовжуємо лічильники.
    const runRaw = await getSetting(env.DB, RUN);
    const prev = runRaw ? (JSON.parse(runRaw) as RunStats) : null;
    if (!prev || Date.now() - Date.parse(prev.last) > 20 * 60_000) {
      await setSetting(env.DB, RUN, JSON.stringify({ started: q.built, last: q.built, pages: 0, cards: 0, verdict: "unknown" } satisfies RunStats));
    }
  }
  if (!q || q.pos >= q.tasks.length) return null;
  const t = q.tasks[q.pos]!;
  q.pos++;
  await setSetting(env.DB, QUEUE, JSON.stringify(q));
  await setSetting(env.DB, CURRENT, JSON.stringify(t));
  return t;
}

/** Зберігає товари й ціни АТБ (одним пакетом) і оновлює зіставлення для позицій завдання. */
export async function saveAtbPage(env: Env, cards: AtbCard[], shopId: string, refs: string[]): Promise<number> {
  const db = env.DB;
  const day = todayIn(env.TIMEZONE);
  const stmts: D1PreparedStatement[] = [];
  for (const c of cards) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO atb_products (id, slug, name, brand, category, pack_size, pack_unit, per_kg, image_url, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, name = excluded.name, brand = excluded.brand, category = excluded.category,
             pack_size = excluded.pack_size, pack_unit = excluded.pack_unit, per_kg = excluded.per_kg,
             image_url = COALESCE(excluded.image_url, atb_products.image_url), updated_at = datetime('now')`,
        )
        .bind(c.id, c.slug, c.name, c.brand, c.category, c.packSize, c.packUnit, c.perKg ? 1 : 0, c.image),
      db
        .prepare(
          `INSERT INTO atb_prices (product_id, shop_id, day, price, old_price, label, min_price, checked_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4, datetime('now'))
           ON CONFLICT(product_id, shop_id, day) DO UPDATE SET price = excluded.price, old_price = excluded.old_price,
             label = excluded.label, min_price = MIN(atb_prices.min_price, excluded.price), checked_at = datetime('now')`,
        )
        .bind(c.id, shopId, day, c.price, c.oldPrice, c.label),
    );
  }

  // Зіставлення: для кожної позиції — «той самий» (якщо знайдено) і найдешевший аналог за кг/л/шт.
  if (refs.length && cards.length) {
    const ph = refs.map((_, k) => `?${k + 1}`).join(",");
    const productIds = refs.filter((r) => !r.startsWith("q:"));
    const silpo = productIds.length
      ? (
          await db
            .prepare(`SELECT id, name, pack_size, pack_unit FROM products WHERE id IN (${productIds.map((_, k) => `?${k + 1}`).join(",")})`)
            .bind(...productIds)
            .all<{ id: string; name: string; pack_size: number | null; pack_unit: string | null }>()
        ).results
      : [];
    const existing = (
      await db.prepare(`SELECT ref, atb_id, status FROM atb_matches WHERE ref IN (${ph})`).bind(...refs).all<{ ref: string; atb_id: string; status: string }>()
    ).results;
    for (const ref of refs) {
      const s = ref.startsWith("q:") ? { name: ref.slice(2), packSize: null, packUnit: null } : silpo.find((x) => x.id === ref);
      if (!s) continue;
      const rejected = new Set(existing.filter((e) => e.ref === ref && e.status === "rejected").map((e) => e.atb_id));
      const confirmed = existing.some((e) => e.ref === ref && e.status === "confirmed");
      const m = matchCards({ name: s.name, packSize: "pack_size" in s ? s.pack_size : null, packUnit: "pack_unit" in s ? s.pack_unit : null }, cards.filter((c) => !rejected.has(c.id)));
      if (m.same && !confirmed && !ref.startsWith("q:")) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO atb_matches (ref, atb_id, kind, status, score) VALUES (?1, ?2, 'same', 'suggested', ?3)
               ON CONFLICT(ref, atb_id) DO UPDATE SET score = excluded.score, updated_at = datetime('now')`,
            )
            .bind(ref, m.same.card.id, m.same.score),
        );
      }
      stmts.push(db.prepare("DELETE FROM atb_matches WHERE ref = ?1 AND kind = 'analog'").bind(ref));
      if (m.analog) {
        stmts.push(
          db
            .prepare("INSERT OR REPLACE INTO atb_matches (ref, atb_id, kind, status, score) VALUES (?1, ?2, 'analog', 'auto', ?3)")
            .bind(ref, m.analog.card.id, m.analog.perUnit),
        );
      }
    }
  }
  for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
  return cards.length;
}

async function notifyTelegram(env: Env, text: string) {
  const chat = await getSetting(env.DB, "tg_chat_id");
  if (!chat || !env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {});
}

/**
 * Обробка однієї сторінки АТБ — однакова для iPhone і для сервера:
 * зберігає ціни, оновлює зіставлення, позначає позиції як перевірені (або невдалі — тоді вони повернуться в чергу).
 */
export async function processAtbPage(
  env: Env,
  task: Task,
  html: string,
  source: "phone" | "server",
  ctx?: ExecutionContext,
): Promise<{ ok: boolean; verdict: ProbeResult["verdict"]; saved: number; message: string }> {
  const target = atbSearchUrl(task.q);
  const probe = analyzeAtbHtml(html, target);
  const runRaw = await getSetting(env.DB, RUN);
  const run: RunStats = runRaw ? JSON.parse(runRaw) : { started: new Date().toISOString(), last: "", pages: 0, cards: 0, verdict: "unknown" };
  run.last = new Date().toISOString();
  const day = todayIn(env.TIMEZONE);

  if (probe.verdict === "challenge" || probe.verdict === "blocked" || probe.verdict === "empty") {
    // Для сервера невдача не рахується проти позиції: її просто збере iPhone.
    if (source === "phone" && task.refs.length) {
      await env.DB.batch(
        task.refs.map((ref) =>
          env.DB
            .prepare(
              `INSERT INTO atb_search_log (ref, q, fail_day, fails, updated_at) VALUES (?1, ?2, ?3, 1, datetime('now'))
               ON CONFLICT(ref) DO UPDATE SET fails = CASE WHEN atb_search_log.fail_day = excluded.fail_day THEN atb_search_log.fails + 1 ELSE 1 END,
                 fail_day = excluded.fail_day, updated_at = datetime('now')`,
            )
            .bind(ref, task.q, day),
        ),
      );
      // Сайт не пустив — не обходимо захист, а повідомляємо (один раз за прогін).
      if (run.verdict !== probe.verdict) {
        const p = notifyTelegram(env, `АТБ: ${probe.message}`);
        if (ctx) ctx.waitUntil(p);
        else await p;
      }
      run.verdict = probe.verdict;
      run.message = probe.message;
      await setSetting(env.DB, RUN, JSON.stringify(run));
    }
    return { ok: false, verdict: probe.verdict, saved: 0, message: probe.message };
  }

  const cards = parseAtbCards(html);
  const saved = await saveAtbPage(env, cards, currentShopId(html) ?? "", task.refs);
  if (task.refs.length) {
    await env.DB.batch(
      task.refs.map((ref) =>
        env.DB
          .prepare(
            `INSERT INTO atb_search_log (ref, q, last_ok, fails, updated_at) VALUES (?1, ?2, ?3, 0, datetime('now'))
             ON CONFLICT(ref) DO UPDATE SET q = excluded.q, last_ok = excluded.last_ok, fails = 0, updated_at = datetime('now')`,
          )
          .bind(ref, task.q, day),
      ),
    );
  }
  run.pages++;
  run.cards += saved;
  run.verdict = "ok";
  run.message = undefined;
  await setSetting(env.DB, RUN, JSON.stringify(run));
  await setSetting(env.DB, LAST, JSON.stringify({ ...probe, message: `✅ ${task.q || "сторінка"}: ${saved} товарів` }));
  return { ok: true, verdict: "ok", saved, message: `✓ ${task.q}: ${saved} товарів` };
}

/** Взяти наступне завдання з черги (спільна черга для iPhone і сервера). */
export async function takeAtbTask(env: Env): Promise<Task | null> {
  return nextTask(env);
}

/** Повернути завдання в чергу (сервер не зміг — збере iPhone). */
export async function returnAtbTask(env: Env): Promise<void> {
  const raw = await getSetting(env.DB, QUEUE);
  if (!raw) return;
  const q = JSON.parse(raw) as Queue;
  if (q.pos > 0) q.pos--;
  await setSetting(env.DB, QUEUE, JSON.stringify(q));
}

export type { Task as AtbTask };

export async function handleAtb(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const text = (s: string, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  if (!(await keyOk(env, url))) return text("Невірний ключ. Скопіюйте адреси заново з Налаштувань Silpopo → АТБ.", 403);

  // Наступна сторінка для завантаження, або DONE, коли черга на сьогодні закінчилась.
  if (url.pathname === "/atb/next" && req.method === "GET") {
    const t = await nextTask(env);
    if (!t) return text("DONE");
    const target = atbSearchUrl(t.q);
    await setSetting(env.DB, NEXT, target);
    return text(target);
  }

  if (url.pathname === "/atb/ingest" && req.method === "POST") {
    const html = await req.text();
    const curRaw = await getSetting(env.DB, CURRENT);
    const task = curRaw ? (JSON.parse(curRaw) as Task) : { q: "", refs: [] };
    const r = await processAtbPage(env, task, html, "phone", ctx);
    return text(r.message);
  }

  return text("Not found", 404);
}

export async function atbStatus(env: Env) {
  const last = await getSetting(env.DB, LAST);
  const run = await getSetting(env.DB, RUN);
  const q = await getSetting(env.DB, QUEUE);
  const queue = q ? (JSON.parse(q) as Queue) : null;
  return {
    key: await atbKey(env),
    last: last ? (JSON.parse(last) as ProbeResult) : null,
    run: run ? (JSON.parse(run) as RunStats) : null,
    queue: queue ? { pos: queue.pos, total: queue.tasks.length, built: queue.built } : null,
    tracked: (await env.DB.prepare("SELECT COUNT(*) AS n FROM list_items WHERE checked = 0").first<{ n: number }>())?.n ?? 0,
    // скільки позицій сьогодні ще без перевірки в АТБ
    pending:
      (
        await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM list_items li LEFT JOIN atb_search_log l ON l.ref = COALESCE(li.product_id, 'q:' || li.query)
           WHERE li.checked = 0 AND (l.last_ok IS NULL OR l.last_ok < ?1)`,
        )
          .bind(todayIn(env.TIMEZONE))
          .first<{ n: number }>()
      )?.n ?? 0,
  };
}
