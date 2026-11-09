import type { Env, ProductOffer, SilpoSource, StoreInfo } from "../types";
import { getSetting, setSetting } from "../db";
import { todayIn } from "../util/time";
import { accessToken } from "./oauth";

/**
 * Мінімальний MCP-клієнт (Streamable HTTP, JSON-RPC 2.0) для офіційного сервера Сільпо
 * https://mcp.silpo.ua/mcp. Авторизація — OAuth 2.1 від імені акаунта дружини;
 * токени лежать у таблиці oauth_tokens.
 *
 * Використовуємо лише інструменти ЧИТАННЯ (пошук, ціни, схожі, магазини, історія).
 * Кошик, замовлення й бонуси застосунок не змінює.
 */

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {
  constructor(message: string, readonly code?: number) {
    super(message);
  }
}

export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;

  constructor(private url: string, private getToken: () => Promise<string>) {}

  private async post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${await this.getToken()}`,
      "mcp-protocol-version": "2025-06-18",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (res.status === 401) throw new McpError("Сільпо: потрібна повторна авторизація", 401);
    if (!res.ok && res.status !== 202) throw new McpError(`Сільпо MCP: HTTP ${res.status}`, res.status);
    return res;
  }

  /** Відповідь може прийти як JSON або як SSE-потік — підтримуємо обидва варіанти. */
  private async readResponse(res: Response, id: number): Promise<JsonRpcResponse> {
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      const text = await res.text();
      for (const block of text.split(/\n\n/)) {
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue;
        const msg = JSON.parse(data) as JsonRpcResponse;
        if (msg.id === id) return msg;
      }
      throw new McpError("Сільпо MCP: у потоці немає відповіді на запит");
    }
    return (await res.json()) as JsonRpcResponse;
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    const msg = await this.readResponse(res, id);
    if (msg.error) throw new McpError(`Сільпо MCP: ${msg.error.message}`, msg.error.code);
    return msg.result;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "silpopo", version: "0.1.0" },
    });
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.initialized = true;
  }

  async listTools(): Promise<{ name: string; description?: string; inputSchema?: unknown }[]> {
    await this.initialize();
    const r = (await this.request("tools/list")) as { tools: { name: string; description?: string; inputSchema?: unknown }[] };
    return r.tools;
  }

  /** Викликає інструмент і повертає structuredContent або розібраний JSON із текстової частини. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.initialize();
    const r = (await this.request("tools/call", { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    if (r.isError) {
      const text = r.content?.map((c) => c.text ?? "").join(" ") ?? "";
      throw new McpError(`Сільпо MCP (${name}): ${text || "помилка інструмента"}`);
    }
    if (r.structuredContent !== undefined) return r.structuredContent;
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

/* ───────────── Розбір відповідей Сільпо ───────────── */

export interface SilpoProduct {
  id: string;
  name: string;
  slug: string;
  price: number;
  displayPrice?: number;
  oldPrice: number | null;
  stock: number;
  available: boolean;
  image?: string | null;
  weighted: boolean;
  displayRatio?: string | null;
  externalProductId: number;
}

/** "900г" → 0.9 кг, "1,5л" → 1.5 л, "10шт" → 10 шт, "40*2г/уп" → 0.08 кг. */
export function parseRatio(ratio: string | null | undefined): { size: number; unit: "kg" | "l" | "pcs" } | null {
  if (!ratio) return null;
  const s = ratio.toLowerCase().replace(/\s+/g, "").replace(",", ".");
  const m = s.match(/^(\d+(?:\.\d+)?)(?:\*(\d+(?:\.\d+)?))?(кг|г|мл|л|шт)/);
  if (!m) return s.startsWith("шт") ? { size: 1, unit: "pcs" } : null;
  let n = Number(m[1]) * (m[2] ? Number(m[2]) : 1);
  const u = m[3];
  if (!Number.isFinite(n) || n <= 0) return null;
  if (u === "г") return { size: n / 1000, unit: "kg" };
  if (u === "кг") return { size: n, unit: "kg" };
  if (u === "мл") return { size: n / 1000, unit: "l" };
  if (u === "л") return { size: n, unit: "l" };
  return { size: n, unit: "pcs" };
}

export function mapProduct(p: SilpoProduct, storeId: string): ProductOffer {
  const pack = p.weighted ? { size: 1, unit: "kg" as const } : parseRatio(p.displayRatio);
  const regular = p.oldPrice && p.oldPrice > p.price ? p.oldPrice : null;
  return {
    productId: String(p.externalProductId),
    slug: p.slug,
    name: p.name,
    brand: null,
    category: null,
    packSize: pack?.size ?? null,
    packUnit: pack?.unit ?? null,
    imageUrl: p.image ?? null,
    url: p.slug ? `https://silpo.ua/product/${p.slug}` : null,
    storeId,
    price: p.price,
    regularPrice: regular,
    promoType: regular ? "Акція" : null,
    promoUntil: null,
    inStock: !!p.available && Number(p.stock) > 0,
  };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[«»"'’`®™]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const isBag = (name: string) => /^пакет\b/i.test(name.trim());

/* ───────────── Джерело даних ───────────── */

interface Ctx {
  branchId: string;
  deliveryType: string;
  start: string;
  end: string;
}

/**
 * id магазинів у застосунку:
 *  - самовивіз/магазин:  "<branchId>"
 *  - доставка додому:   "delivery:<branchId>"
 */
export function storeKey(id: string): { branchId: string; deliveryType: "SelfPickup" | "DeliveryHome" } {
  return id.startsWith("delivery:") ? { branchId: id.slice(9), deliveryType: "DeliveryHome" } : { branchId: id, deliveryType: "SelfPickup" };
}

export class SilpoMcpSource implements SilpoSource {
  private client: McpClient;

  constructor(private env: Env) {
    this.client = new McpClient(env.SILPO_MCP_URL, () => accessToken(env));
  }

  private call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    return this.client.callTool(tool, args) as Promise<T>;
  }

  /** Часовий слот потрібен для запитів цін; кешуємо його на день для кожного магазину. */
  private async ctx(storeId: string): Promise<Ctx> {
    const { branchId, deliveryType } = storeKey(storeId);
    const key = `slot:${storeId}`;
    const today = todayIn(this.env.TIMEZONE);
    const cached = await getSetting(this.env.DB, key);
    if (cached) {
      const c = JSON.parse(cached) as { day: string; start: string; end: string };
      if (c.day === today && Date.parse(c.end) > Date.now()) return { branchId, deliveryType, start: c.start, end: c.end };
    }
    const now = new Date();
    const r = await this.call<{ slots?: { start: string; end: string; available: boolean }[] }>("silpo_get_time_slots", {
      branchId,
      deliveryTypes: [deliveryType],
      start: now.toISOString(),
      end: new Date(now.getTime() + 3 * 86_400_000).toISOString(),
      limit: 20,
    });
    const slots = r.slots ?? [];
    const slot = slots.find((s) => s.available) ?? slots[0];
    // Якщо слотів немає (магазин зачинений) — беремо умовне вікно: ціни повертаються й без нього.
    const start = slot?.start ?? new Date(now.getTime() + 3_600_000).toISOString();
    const end = slot?.end ?? new Date(now.getTime() + 7_200_000).toISOString();
    await setSetting(this.env.DB, key, JSON.stringify({ day: today, start, end }));
    return { branchId, deliveryType, start, end };
  }

  /** Контекст кошика (адреса доставки й філія) — кешуємо на день. */
  private async cartCtx(): Promise<{ storeId: string; name: string; city: string }> {
    const today = todayIn(this.env.TIMEZONE);
    const cached = await getSetting(this.env.DB, "silpo_cart_ctx");
    if (cached) {
      const c = JSON.parse(cached) as { day: string; storeId: string; name: string; city: string };
      if (c.day === today) return c;
    }
    const my = await this.call<{ shoppingCartId: string | null; exists: boolean }>("silpo_get_my_shopping_cart", {});
    if (!my.exists || !my.shoppingCartId) throw new McpError("У Сільпо ще немає адреси доставки — оформіть хоча б один кошик на сайті чи в застосунку Сільпо");
    const r = await this.call<{ cart: { address?: { city?: string; street?: string; house?: string }; shipments?: { branchId: string }[] } }>(
      "silpo_get_shopping_cart_by_id",
      { shoppingCartId: my.shoppingCartId },
    );
    const branchId = r.cart.shipments?.[0]?.branchId;
    if (!branchId) throw new McpError("Не вдалося визначити філію доставки");
    const a = r.cart.address ?? {};
    const c = {
      day: today,
      storeId: `delivery:${branchId}`,
      name: `Доставка: ${[a.street, a.house].filter(Boolean).join(", ") || "додому"}`,
      city: a.city ?? "",
    };
    await setSetting(this.env.DB, "silpo_cart_ctx", JSON.stringify(c));
    return c;
  }

  private async batch(queries: string[], storeId: string, limit: number) {
    const c = await this.ctx(storeId);
    return this.call<{ queries: { query: string; products: SilpoProduct[] }[] }>("silpo_find_products_batch", {
      branchId: c.branchId,
      deliveryType: c.deliveryType,
      timeslotStart: c.start,
      timeslotEnd: c.end,
      products: queries.slice(0, 30),
      limit,
    });
  }

  async searchProducts(query: string, storeId: string, limit = 10): Promise<ProductOffer[]> {
    const r = await this.batch([query], storeId, limit);
    return (r.queries[0]?.products ?? []).filter((p) => !isBag(p.name)).map((p) => mapProduct(p, storeId));
  }

  /**
   * Ціни за нашими id. id — це артикул Сільпо (externalProductId); пошук за ним точний.
   * Позиції з історії онлайн-замовлень можуть мати id виду "name:<назва>" — їх шукаємо за назвою.
   */
  async getOffers(productIds: string[], storeId: string): Promise<ProductOffer[]> {
    const out: ProductOffer[] = [];
    for (let i = 0; i < productIds.length; i += 30) {
      const ids = productIds.slice(i, i + 30);
      const r = await this.batch(
        ids.map((id) => (id.startsWith("name:") ? id.slice(5) : id)),
        storeId,
        5,
      );
      ids.forEach((id, k) => {
        const products = r.queries[k]?.products ?? [];
        let p: SilpoProduct | undefined;
        if (id.startsWith("name:")) {
          const want = norm(id.slice(5));
          p = products.find((x) => norm(x.name) === want) ?? products[0];
        } else {
          p = products.find((x) => String(x.externalProductId) === id);
        }
        if (p) out.push(mapProduct(p, storeId));
      });
    }
    return out;
  }

  async findSimilar(productId: string, storeId: string, limit = 5): Promise<ProductOffer[]> {
    const row = await this.env.DB.prepare("SELECT slug FROM products WHERE id = ?1").bind(productId).first<{ slug: string | null }>();
    if (!row?.slug) return [];
    const c = await this.ctx(storeId);
    const r = await this.call<{ products?: SilpoProduct[] }>("silpo_get_similar_products", {
      branchId: c.branchId,
      slug: row.slug,
      deliveryType: c.deliveryType,
      timeslotStart: c.start,
      timeslotEnd: c.end,
      limit,
    });
    return (r.products ?? []).filter((p) => !isBag(p.name)).map((p) => mapProduct(p, storeId));
  }

  /** Доставка за адресою з кошика + магазини з самовивозом (у своєму місті або за пошуком). */
  async listStores(query?: string): Promise<StoreInfo[]> {
    const cart = await this.cartCtx().catch(() => null);
    const r = await this.call<{ branches?: { branchId: string; externalId: string; city: string; address: string; hasPickup: boolean; open: boolean }[] }>(
      "silpo_list_branches",
      { hasPickup: true, limit: 500 },
    );
    const q = norm(query ?? "");
    const city = norm(cart?.city ?? "");
    const branches = (r.branches ?? []).filter((b) => {
      const hay = norm(`${b.city} ${b.address}`);
      if (q) return q.split(" ").every((w) => hay.includes(w));
      return city ? norm(b.city).includes(city) : false;
    });
    const stores: StoreInfo[] = branches.slice(0, 25).map((b) => ({
      id: b.branchId,
      name: `Сільпо, ${b.address}${city && norm(b.city) !== city ? ` (${b.city})` : ""}`,
      kind: "store" as const,
    }));
    if (cart && (!q || norm(cart.name).includes(q) || "доставка".includes(q))) stores.unshift({ id: cart.storeId, name: cart.name, kind: "delivery" });
    return stores;
  }

  /** Часті покупки з чеків у магазинах і з онлайн-замовлень за останні ~6 місяців. */
  async getPurchaseHistory() {
    const cart = await this.cartCtx();
    const c = await this.ctx(cart.storeId);
    const agg = new Map<string, { productId: string; name: string; timesBought: number; lastBought?: string }>();
    const byName = new Map<string, string>(); // норм. назва → ключ

    const bump = (key: string, productId: string, name: string, date?: string) => {
      const cur = agg.get(key) ?? { productId, name, timesBought: 0, lastBought: undefined };
      cur.timesBought++;
      if (date && (!cur.lastBought || date > cur.lastBought)) cur.lastBought = date;
      agg.set(key, cur);
      byName.set(norm(name), key);
    };

    type Offline = { orders?: { createdAt: string; products: { lagerId: number; name: string; catalogProduct: { name: string } | null }[] }[]; meta?: { total: number } };
    for (let offset = 0; offset < 30; offset += 10) {
      const r = await this.call<Offline>("silpo_get_my_offline_orders", {
        branchId: c.branchId,
        deliveryType: c.deliveryType,
        timeslotStart: c.start,
        timeslotEnd: c.end,
        limit: 10,
        offset,
      });
      for (const o of r.orders ?? []) {
        const seen = new Set<number>();
        for (const p of o.products) {
          const name = p.catalogProduct?.name ?? p.name;
          if (isBag(name) || seen.has(p.lagerId)) continue;
          seen.add(p.lagerId);
          bump(`a:${p.lagerId}`, String(p.lagerId), name, o.createdAt.slice(0, 10));
        }
      }
      if ((r.meta?.total ?? 0) <= offset + 10) break;
    }

    type Online = { orders?: { createdAt: string; products: { name: string; removed: boolean }[] }[] };
    const on = await this.call<Online>("silpo_get_my_online_orders", { limit: 50 });
    for (const o of on.orders ?? []) {
      const seen = new Set<string>();
      for (const p of o.products) {
        if (p.removed || isBag(p.name)) continue;
        const n = norm(p.name);
        if (seen.has(n)) continue;
        seen.add(n);
        const key = byName.get(n) ?? `n:${n}`;
        const existing = agg.get(key);
        bump(key, existing?.productId ?? `name:${p.name}`, existing?.name ?? p.name, o.createdAt.slice(0, 10));
      }
    }

    return [...agg.values()].filter((x) => x.timesBought >= 2).sort((a, b) => b.timesBought - a.timesBought).slice(0, 60);
  }

  /** Діагностика: список інструментів сервера. */
  listTools() {
    return this.client.listTools();
  }
}
