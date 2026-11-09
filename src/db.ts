import type { ProductOffer } from "./types";
import type { HistoryPoint } from "./analytics";

export function upsertProductStmt(db: D1Database, o: ProductOffer): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO products (id, name, brand, category, pack_size, pack_unit, image_url, url, slug, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, brand = COALESCE(excluded.brand, products.brand), category = COALESCE(excluded.category, products.category),
         pack_size = excluded.pack_size, pack_unit = excluded.pack_unit,
         image_url = COALESCE(excluded.image_url, products.image_url),
         url = COALESCE(excluded.url, products.url), slug = COALESCE(excluded.slug, products.slug), updated_at = datetime('now')`,
    )
    .bind(o.productId, o.name, o.brand ?? null, o.category ?? null, o.packSize ?? null, o.packUnit ?? null, o.imageUrl ?? null, o.url ?? null, o.slug ?? null);
}

/** Один рядок на товар × магазин × день: зберігаємо останнє спостереження і мінімум дня. */
export function snapshotStmt(db: D1Database, o: ProductOffer, day: string): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO price_snapshots (product_id, store_id, day, price, regular_price, promo_type, promo_until, in_stock, min_price, checked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?4, datetime('now'))
       ON CONFLICT(product_id, store_id, day) DO UPDATE SET
         price = excluded.price, regular_price = excluded.regular_price,
         promo_type = excluded.promo_type, promo_until = excluded.promo_until,
         in_stock = excluded.in_stock, min_price = MIN(price_snapshots.min_price, excluded.price),
         checked_at = datetime('now')`,
    )
    .bind(o.productId, o.storeId, day, o.price, o.regularPrice ?? null, o.promoType ?? null, o.promoUntil ?? null, o.inStock ? 1 : 0);
}

export function markCheckedStmt(db: D1Database, productId: string, storeId: string, error: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO collect_state (product_id, store_id, last_checked, last_error) VALUES (?1, ?2, datetime('now'), ?3)
       ON CONFLICT(product_id, store_id) DO UPDATE SET last_checked = datetime('now'), last_error = excluded.last_error`,
    )
    .bind(productId, storeId, error);
}

/** Зберегти пропозиції: товар + знімок ціни + відмітка перевірки (одним batch). */
export async function saveOffers(db: D1Database, offers: ProductOffer[], day: string): Promise<void> {
  if (!offers.length) return;
  const stmts = offers.flatMap((o) => [upsertProductStmt(db, o), snapshotStmt(db, o, day), markCheckedStmt(db, o.productId, o.storeId)]);
  await db.batch(stmts);
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const r = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')")
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?1").bind(key).run();
}

export async function getHistory(db: D1Database, productId: string, storeId: string, fromDay: string): Promise<HistoryPoint[]> {
  const r = await db
    .prepare("SELECT day, min_price AS price, regular_price FROM price_snapshots WHERE product_id = ?1 AND store_id = ?2 AND day >= ?3 ORDER BY day")
    .bind(productId, storeId, fromDay)
    .all<HistoryPoint>();
  return r.results;
}

export interface LatestPrice {
  product_id: string;
  store_id: string;
  day: string;
  price: number;
  regular_price: number | null;
  promo_type: string | null;
  promo_until: string | null;
  in_stock: number;
}

/** Остання відома ціна для набору товарів в активних магазинах. */
export async function latestPrices(db: D1Database, productIds: string[]): Promise<LatestPrice[]> {
  if (!productIds.length) return [];
  const out: LatestPrice[] = [];
  // D1 обмежує кількість параметрів у запиті — ділимо на порції.
  for (let i = 0; i < productIds.length; i += 90) {
    const chunk = productIds.slice(i, i + 90);
    const ph = chunk.map((_, j) => `?${j + 1}`).join(",");
    const r = await db
      .prepare(
        `SELECT s.product_id, s.store_id, s.day, s.price, s.regular_price, s.promo_type, s.promo_until, s.in_stock
         FROM price_snapshots s
         JOIN stores st ON st.id = s.store_id AND st.active = 1
         WHERE s.product_id IN (${ph})
           AND s.day = (SELECT MAX(day) FROM price_snapshots s2 WHERE s2.product_id = s.product_id AND s2.store_id = s.store_id)`,
      )
      .bind(...chunk)
      .all<LatestPrice>();
    out.push(...r.results);
  }
  return out;
}
