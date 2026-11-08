import type { Env } from "./types";
import { analyze, unitPrice, type Analysis, type HistoryPoint } from "./analytics";
import { daysAgo, todayIn } from "./util/time";

export interface ProductRow {
  id: string;
  name: string;
  brand: string | null;
  category: string | null;
  pack_size: number | null;
  pack_unit: string | null;
  image_url: string | null;
  url: string | null;
}

export interface StoreOffer {
  storeId: string;
  storeName: string;
  price: number;
  regularPrice: number | null;
  promoType: string | null;
  promoUntil: string | null;
  inStock: boolean;
  day: string;
  unit: { value: number; unit: string } | null;
  analysis: Analysis;
}

export interface ProductView {
  product: ProductRow;
  offers: StoreOffer[]; // по магазинах, найдешевше спершу
  best: StoreOffer | null;
}

export interface ItemView {
  id: number;
  listId: number;
  title: string;
  query: string | null;
  quantity: number;
  note: string | null;
  stockable: boolean;
  checked: boolean;
  main: ProductView | null; // конкретний товар або найкращий кандидат загальної позиції
  alternatives: (ProductView & { savingPct: number })[]; // дешевші за ціною за одиницю
}

interface ItemRow {
  id: number;
  list_id: number;
  product_id: string | null;
  query: string | null;
  title: string;
  quantity: number;
  note: string | null;
  stockable: number;
  checked: number;
}

const HISTORY_DAYS = 90;

async function chunked<T>(ids: string[], fn: (chunk: string[], ph: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    out.push(...(await fn(chunk, chunk.map((_, j) => `?${j + 1}`).join(","))));
  }
  return out;
}

/** Збирає все потрібне для показу позицій списку(ів): ціни по магазинах, аналітику, альтернативи. */
export async function buildItems(env: Env, opts: { listId?: number; itemId?: number } = {}): Promise<ItemView[]> {
  const db = env.DB;
  const today = todayIn(env.TIMEZONE);

  let sql = "SELECT * FROM list_items";
  const binds: unknown[] = [];
  if (opts.itemId != null) {
    sql += " WHERE id = ?1";
    binds.push(opts.itemId);
  } else if (opts.listId != null) {
    sql += " WHERE list_id = ?1";
    binds.push(opts.listId);
  }
  sql += " ORDER BY checked, id";
  const items = (await db.prepare(sql).bind(...binds).all<ItemRow>()).results;
  if (!items.length) return [];

  const itemIds = items.map((i) => i.id);
  const cands = (
    await db
      .prepare(`SELECT item_id, product_id, source FROM item_candidates WHERE item_id IN (${itemIds.map((_, j) => `?${j + 1}`).join(",")})`)
      .bind(...itemIds)
      .all<{ item_id: number; product_id: string; source: string }>()
  ).results;

  const productIds = [...new Set([...items.map((i) => i.product_id).filter((x): x is string => !!x), ...cands.map((c) => c.product_id)])];

  const products = await chunked(productIds, async (chunk, ph) =>
    (await db.prepare(`SELECT id, name, brand, category, pack_size, pack_unit, image_url, url FROM products WHERE id IN (${ph})`).bind(...chunk).all<ProductRow>()).results,
  );
  const productMap = new Map(products.map((p) => [p.id, p]));

  const stores = (await db.prepare("SELECT id, name FROM stores WHERE active = 1").all<{ id: string; name: string }>()).results;
  const storeName = new Map(stores.map((s) => [s.id, s.name]));

  const from = daysAgo(today, HISTORY_DAYS);
  type SnapRow = HistoryPoint & { product_id: string; store_id: string; promo_type: string | null; promo_until: string | null; in_stock: number; last_price: number };
  const snaps = await chunked(productIds, async (chunk, ph) =>
    (
      await db
        .prepare(
          `SELECT product_id, store_id, day, min_price AS price, regular_price, promo_type, promo_until, in_stock, price AS last_price
           FROM price_snapshots WHERE day >= ?${chunk.length + 1} AND product_id IN (${ph}) ORDER BY day`,
        )
        .bind(...chunk, from)
        .all<SnapRow>()
    ).results,
  );

  const byKey = new Map<string, SnapRow[]>();
  for (const s of snaps) {
    if (!storeName.has(s.store_id)) continue;
    const k = `${s.product_id}|${s.store_id}`;
    byKey.set(k, [...(byKey.get(k) ?? []), s]);
  }

  const viewCache = new Map<string, ProductView | null>();
  const productView = (pid: string, stockable: boolean): ProductView | null => {
    const key = `${pid}|${stockable}`;
    if (viewCache.has(key)) return viewCache.get(key)!;
    const product = productMap.get(pid);
    if (!product) return null;
    const offers: StoreOffer[] = [];
    for (const st of stores) {
      const hist = byKey.get(`${pid}|${st.id}`);
      if (!hist?.length) continue;
      const last = hist[hist.length - 1]!;
      // свіжими вважаємо дані не старші 2 днів
      if (last.day < daysAgo(today, 2)) continue;
      const past = hist.slice(0, -1);
      const analysis = analyze(past, { price: last.last_price, regular_price: last.regular_price, promo_until: last.promo_until }, today, { stockable });
      offers.push({
        storeId: st.id,
        storeName: st.name,
        price: last.last_price,
        regularPrice: last.regular_price,
        promoType: last.promo_type,
        promoUntil: last.promo_until,
        inStock: !!last.in_stock,
        day: last.day,
        unit: unitPrice(last.last_price, product.pack_size, product.pack_unit),
        analysis,
      });
    }
    offers.sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.price - b.price);
    const v = { product, offers, best: offers.find((o) => o.inStock) ?? offers[0] ?? null };
    viewCache.set(key, v);
    return v;
  };

  const unitOf = (v: ProductView) => v.best?.unit?.value ?? null;
  const unitName = (v: ProductView) => v.best?.unit?.unit ?? null;

  return items.map((it) => {
    const stockable = !!it.stockable;
    const itemCands = cands.filter((c) => c.item_id === it.id);
    let main: ProductView | null = null;
    let pool: ProductView[] = [];

    if (it.product_id) {
      main = productView(it.product_id, stockable);
      pool = itemCands.filter((c) => c.source === "similar").map((c) => productView(c.product_id, stockable)).filter((v): v is ProductView => !!v?.best);
    } else {
      const all = itemCands.map((c) => productView(c.product_id, stockable)).filter((v): v is ProductView => !!v?.best);
      // для загальної позиції головний — найдешевший за одиницю (або за ціною)
      all.sort((a, b) => (unitOf(a) ?? a.best!.price) - (unitOf(b) ?? b.best!.price));
      main = all[0] ?? null;
      pool = all.slice(1);
    }

    const mainUnit = main ? unitOf(main) : null;
    const alternatives = pool
      .map((v) => {
        const u = unitOf(v);
        // порівнюємо лише однакові одиниці (кг з кг, л з л), інакше економія безглузда
        const sameUnit = main && unitName(main) === unitName(v);
        const savingPct = mainUnit && u && sameUnit ? Math.round((1 - u / mainUnit) * 100) / 100 : 0;
        return { ...v, savingPct };
      })
      .filter((v) => v.savingPct >= 0.1)
      .sort((a, b) => b.savingPct - a.savingPct)
      .slice(0, 3);

    return {
      id: it.id,
      listId: it.list_id,
      title: it.title,
      query: it.query,
      quantity: it.quantity,
      note: it.note,
      stockable,
      checked: !!it.checked,
      main,
      alternatives,
    };
  });
}

export function isDeal(o: StoreOffer | null | undefined): boolean {
  return !!o && o.inStock && ["record", "great", "good"].includes(o.analysis.verdict);
}

export interface DealsSummary {
  deals: ItemView[]; // позиції, де головний товар зараз вигідний хоча б в одному магазині
  alternatives: ItemView[]; // позиції з дешевшою альтернативою в акції
  endingSoon: ItemView[]; // акція закінчується сьогодні/завтра
  storeScores: { storeId: string; storeName: string; deals: number; saving: number }[];
}

export function summarizeDeals(items: ItemView[], today: string): DealsSummary {
  const open = items.filter((i) => !i.checked);
  const deals = open.filter((i) => i.main?.offers.some(isDeal));
  // альтернативи показуємо лише для позицій, які самі зараз не в акції
  const alternatives = open.filter((i) => !i.main?.offers.some(isDeal) && i.alternatives.some((a) => isDeal(a.best)));
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86_400_000).toISOString().slice(0, 10);
  const endingSoon = deals.filter((i) => i.main!.offers.some((o) => isDeal(o) && o.promoUntil && o.promoUntil <= tomorrow));

  const scores = new Map<string, { storeId: string; storeName: string; deals: number; saving: number }>();
  for (const i of open) {
    for (const o of i.main?.offers ?? []) {
      const s = scores.get(o.storeId) ?? { storeId: o.storeId, storeName: o.storeName, deals: 0, saving: 0 };
      if (isDeal(o)) {
        s.deals++;
        const typical = o.analysis.typical ?? o.regularPrice ?? o.price;
        s.saving += Math.max(0, typical - o.price) * i.quantity;
      }
      scores.set(o.storeId, s);
    }
  }
  const storeScores = [...scores.values()].map((s) => ({ ...s, saving: Math.round(s.saving) })).sort((a, b) => b.saving - a.saving || b.deals - a.deals);
  return { deals, alternatives, endingSoon, storeScores };
}
