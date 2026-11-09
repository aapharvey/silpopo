import type { Env } from "./types";
import { getSetting, saveOffers } from "./db";
import { silpoSource } from "./silpo";
import { todayIn } from "./util/time";

/**
 * Одразу підтягує ціни для товарів у вказаних магазинах (а не чекає збирача).
 * Один пакетний запит на магазин на кожні 30 товарів; помилки окремого магазину не зупиняють решту.
 */
export async function refreshPrices(env: Env, productIds: string[], storeIds?: string[]): Promise<number> {
  const ids = [...new Set(productIds)].slice(0, 60);
  if (!ids.length) return 0;
  const stores = storeIds ?? (await env.DB.prepare("SELECT id FROM stores WHERE active = 1").all<{ id: string }>()).results.map((s) => s.id);
  const src = silpoSource(env);
  const day = todayIn(env.TIMEZONE);
  let saved = 0;
  for (const storeId of stores) {
    try {
      for (let i = 0; i < ids.length; i += 30) {
        const offers = await src.getOffers(ids.slice(i, i + 30), storeId);
        await saveOffers(env.DB, offers, day);
        saved += offers.length;
      }
    } catch (e) {
      console.error("refreshPrices", storeId, e instanceof Error ? e.message : e);
    }
  }
  return saved;
}

export async function primaryStoreId(env: Env): Promise<string | null> {
  const r = await env.DB.prepare("SELECT id FROM stores WHERE active = 1 ORDER BY kind = 'delivery', created_at LIMIT 1").first<{ id: string }>();
  return r?.id ?? null;
}

export async function defaultListId(env: Env): Promise<number> {
  const fromSettings = await getSetting(env.DB, "default_list_id");
  if (fromSettings) {
    const ok = await env.DB.prepare("SELECT id FROM lists WHERE id = ?1").bind(Number(fromSettings)).first();
    if (ok) return Number(fromSettings);
  }
  const first = await env.DB.prepare("SELECT id FROM lists ORDER BY position, id LIMIT 1").first<{ id: number }>();
  if (first) return first.id;
  const created = await env.DB.prepare("INSERT INTO lists (name, emoji) VALUES ('Тижнева закупівля', '🛒') RETURNING id").first<{ id: number }>();
  return created!.id;
}

export interface NewItem {
  listId: number;
  productId?: string | null;
  query?: string | null;
  title: string;
  quantity?: number;
  stockable?: boolean;
  note?: string | null;
}

/** Додає позицію; якщо такий самий товар уже є в списку і не відмічений — збільшує кількість. */
export async function addItem(env: Env, it: NewItem): Promise<number> {
  const db = env.DB;
  if (it.productId) {
    const existing = await db
      .prepare("SELECT id FROM list_items WHERE list_id = ?1 AND product_id = ?2 AND checked = 0")
      .bind(it.listId, it.productId)
      .first<{ id: number }>();
    if (existing) {
      await db.prepare("UPDATE list_items SET quantity = quantity + ?2 WHERE id = ?1").bind(existing.id, it.quantity ?? 1).run();
      return existing.id;
    }
  }
  const r = await db
    .prepare("INSERT INTO list_items (list_id, product_id, query, title, quantity, stockable, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING id")
    .bind(it.listId, it.productId ?? null, it.productId ? null : (it.query ?? it.title), it.title, it.quantity ?? 1, it.stockable ? 1 : 0, it.note ?? null)
    .first<{ id: number }>();
  return r!.id;
}
