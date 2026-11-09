import type { Env, SilpoSource } from "../types";
import { markCheckedStmt, saveOffers } from "../db";
import { todayIn } from "../util/time";
import { SilpoAuthError } from "../silpo/oauth";

/**
 * Збирач цін. Запускається кожні 15 хв і обробляє невелику порцію, щоб вкластися в ліміти
 * безкоштовного Cloudflare (10 мс CPU, 50 підзапитів на запуск; запити до БД теж рахуються).
 *
 * За один запуск:
 *  1) оновлює кандидатів для однієї "загальної" позиції (пошук за запитом), якщо давно не оновлювались;
 *  2) шукає схожі товари для однієї конкретної позиції, якщо їх ще немає;
 *  3) перевіряє ціни для COLLECT_BATCH пар (товар × магазин), які найдовше не перевірялись.
 */
export async function collect(env: Env, src: SilpoSource): Promise<{ checked: number; searched: number; similar: number }> {
  const db = env.DB;
  const day = todayIn(env.TIMEZONE);
  const batch = Math.max(1, Number(env.COLLECT_BATCH) || 12);

  // На справжніх даних без підключеного акаунта Сільпо збирати нічого.
  if (env.SILPO_MODE === "mcp") {
    const t = await db.prepare("SELECT 1 FROM oauth_tokens WHERE provider = 'silpo'").first();
    if (!t) return { checked: 0, searched: 0, similar: 0 };
  }
  const stores = (await db.prepare("SELECT id FROM stores WHERE active = 1").all<{ id: string }>()).results;
  if (!stores.length) return { checked: 0, searched: 0, similar: 0 };
  const primaryStore = stores[0]!.id;

  let searched = 0;
  let similar = 0;

  // 1) Загальні позиції: оновити кандидатів раз на добу.
  const generic = await db
    .prepare(
      `SELECT li.id, li.query FROM list_items li
       WHERE li.product_id IS NULL AND li.query IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM item_candidates c WHERE c.item_id = li.id AND c.source = 'search' AND c.found_at > datetime('now', '-1 day'))
       ORDER BY li.id LIMIT 1`,
    )
    .first<{ id: number; query: string }>();
  if (generic) {
    const found = await src.searchProducts(generic.query, primaryStore, 8);
    await saveOffers(db, found, day);
    await db.batch([
      db.prepare("DELETE FROM item_candidates WHERE item_id = ?1 AND source = 'search'").bind(generic.id),
      ...found.map((o) =>
        db.prepare("INSERT OR REPLACE INTO item_candidates (item_id, product_id, source, found_at) VALUES (?1, ?2, 'search', datetime('now'))").bind(generic.id, o.productId),
      ),
    ]);
    searched = 1;
  }

  // 2) Схожі товари для конкретних позицій (раз на тиждень).
  const concrete = await db
    .prepare(
      `SELECT li.id, li.product_id FROM list_items li
       WHERE li.product_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM item_candidates c WHERE c.item_id = li.id AND c.source = 'similar' AND c.found_at > datetime('now', '-7 days'))
         AND NOT EXISTS (SELECT 1 FROM settings s WHERE s.key = 'similar_none:' || li.product_id AND s.updated_at > datetime('now', '-7 days'))
       ORDER BY li.id LIMIT 1`,
    )
    .first<{ id: number; product_id: string }>();
  if (concrete) {
    const found = await src.findSimilar(concrete.product_id, primaryStore, 5);
    if (found.length) {
      await saveOffers(db, found, day);
      await db.batch(
        found.map((o) =>
          db.prepare("INSERT OR REPLACE INTO item_candidates (item_id, product_id, source, found_at) VALUES (?1, ?2, 'similar', datetime('now'))").bind(concrete.id, o.productId),
        ),
      );
    } else {
      await db
        .prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, '1', datetime('now'))")
        .bind(`similar_none:${concrete.product_id}`)
        .run();
    }
    similar = 1;
  }

  // 3) Черга перевірки цін.
  const queue = (
    await db
      .prepare(
        `WITH tracked AS (
           SELECT product_id FROM list_items WHERE product_id IS NOT NULL
           UNION SELECT product_id FROM item_candidates
         )
         SELECT t.product_id, s.id AS store_id
         FROM tracked t
         CROSS JOIN stores s
         LEFT JOIN collect_state c ON c.product_id = t.product_id AND c.store_id = s.id
         WHERE s.active = 1 AND (c.last_checked IS NULL OR c.last_checked < datetime('now', '-6 hours'))
         ORDER BY c.last_checked IS NOT NULL, c.last_checked
         LIMIT ?1`,
      )
      .bind(batch)
      .all<{ product_id: string; store_id: string }>()
  ).results;

  const byStore = new Map<string, string[]>();
  for (const q of queue) byStore.set(q.store_id, [...(byStore.get(q.store_id) ?? []), q.product_id]);

  let checked = 0;
  for (const [storeId, ids] of byStore) {
    try {
      const offers = await src.getOffers(ids, storeId);
      await saveOffers(db, offers, day);
      const missing = ids.filter((id) => !offers.some((o) => o.productId === id));
      if (missing.length) await db.batch(missing.map((id) => markCheckedStmt(db, id, storeId, "not_found")));
      checked += ids.length;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Вхід у Сільпо закінчився — не позначаємо товари як перевірені, щоб після повторного входу їх зібрати.
      if (e instanceof SilpoAuthError) {
        console.error("collect: silpo auth", msg);
        break;
      }
      await db.batch(ids.map((id) => markCheckedStmt(db, id, storeId, msg.slice(0, 300))));
      console.error("collect failed", storeId, msg);
    }
  }

  return { checked, searched, similar };
}
