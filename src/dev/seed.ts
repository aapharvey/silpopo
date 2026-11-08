import type { Env } from "../types";
import { MOCK_CATALOG, MockSilpoSource, mockOfferFor, addDays } from "../silpo/mock";
import { saveOffers, snapshotStmt, upsertProductStmt } from "../db";
import { addItem, defaultListId } from "../service";
import { todayIn } from "../util/time";

/**
 * Демо-дані для режиму mock: 2 магазини + доставка, кілька позицій у списку
 * і 60 днів "історії цін", щоб одразу було видно графіки, поради та дайджест.
 */
export async function seedDemo(env: Env) {
  const db = env.DB;
  const src = new MockSilpoSource(env.TIMEZONE);
  const stores = (await src.listStores()).filter((s) => s.id !== "mock-store-3");
  await db.batch(
    stores.map((s) =>
      db.prepare("INSERT INTO stores (id, name, kind, active) VALUES (?1, ?2, ?3, 1) ON CONFLICT(id) DO UPDATE SET active = 1").bind(s.id, s.name, s.kind),
    ),
  );

  const today = todayIn(env.TIMEZONE);
  // Історія: для всіх товарів каталогу, по днях, пачками (ліміт розміру batch).
  const stmts: D1PreparedStatement[] = [];
  for (const p of MOCK_CATALOG) {
    stmts.push(upsertProductStmt(db, mockOfferFor(p, stores[0]!.id, today)));
    for (const s of stores) for (let d = 60; d >= 1; d--) stmts.push(snapshotStmt(db, mockOfferFor(p, s.id, addDays(today, -d)), addDays(today, -d)));
  }
  for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));

  // Сьогоднішні ціни
  for (const s of stores) await saveOffers(db, await src.getOffers(MOCK_CATALOG.map((p) => p.id), s.id), today);

  const listId = await defaultListId(env);
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM list_items").first<{ n: number }>();
  if (!existing?.n) {
    await addItem(env, { listId, productId: "m-coffee-1", title: "Кава мелена Lavazza Qualità Oro 250 г", stockable: true });
    await addItem(env, { listId, productId: "m-milk-1", title: "Молоко 2,5% Галичина 900 мл", quantity: 2 });
    await addItem(env, { listId, productId: "m-cheese-1", title: "Сир Гауда 45% Комо 150 г" });
    await addItem(env, { listId, productId: "m-butter-1", title: "Масло вершкове 82% Яготинське 200 г" });
    await addItem(env, { listId, productId: "m-powder-1", title: "Пральний порошок Persil Color 2,7 кг", stockable: true });
    await addItem(env, { listId, query: "яйця", title: "Яйця, 10 шт" });
    await addItem(env, { listId, query: "банани", title: "Банани" });
    await addItem(env, { listId, query: "макарони", title: "Макарони" });

    // кандидати і схожі — щоб одразу були альтернативи
    const items = (await db.prepare("SELECT id, product_id, query FROM list_items").all<{ id: number; product_id: string | null; query: string | null }>()).results;
    const cand: D1PreparedStatement[] = [];
    for (const it of items) {
      const found = it.product_id ? await src.findSimilar(it.product_id, stores[0]!.id) : await src.searchProducts(it.query!, stores[0]!.id);
      for (const o of found)
        cand.push(db.prepare("INSERT OR REPLACE INTO item_candidates (item_id, product_id, source) VALUES (?1, ?2, ?3)").bind(it.id, o.productId, it.product_id ? "similar" : "search"));
    }
    if (cand.length) await db.batch(cand);
  }
  return { ok: true, snapshots: stmts.length };
}
