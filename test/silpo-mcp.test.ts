import { afterEach, describe, expect, it, vi } from "vitest";
import { mapProduct, parseRatio, SilpoMcpSource, storeKey, type SilpoProduct } from "../src/silpo/mcp";
import type { Env } from "../src/types";

describe("parseRatio", () => {
  it("розбирає упаковки Сільпо", () => {
    expect(parseRatio("900г")).toEqual({ size: 0.9, unit: "kg" });
    expect(parseRatio("0,45кг")).toEqual({ size: 0.45, unit: "kg" });
    expect(parseRatio("1,5л")).toEqual({ size: 1.5, unit: "l" });
    expect(parseRatio("0,33л")).toEqual({ size: 0.33, unit: "l" });
    expect(parseRatio("10шт")).toEqual({ size: 10, unit: "pcs" });
    expect(parseRatio("40*2г/уп")).toEqual({ size: 0.08, unit: "kg" });
    expect(parseRatio("шт")).toEqual({ size: 1, unit: "pcs" });
    expect(parseRatio("")).toBeNull();
  });
});

const milk: SilpoProduct = {
  id: "1ed0762e-b3f9-6ca8-bdbf-dd63763181f9",
  name: "Молоко «Ферма» ультрапастеризоване 2,5%",
  slug: "moloko-ferma-ultrapasteryzovane-2-5-576829",
  price: 54.9,
  displayPrice: 54.9,
  oldPrice: 79.99,
  stock: 178,
  available: true,
  image: "https://images.silpo.ua/x.png",
  weighted: false,
  displayRatio: "900г",
  externalProductId: 576829,
};
const banana: SilpoProduct = { ...milk, name: "Банан", slug: "banan-32485", price: 82.15, displayPrice: 8.22, oldPrice: null, weighted: true, displayRatio: "100г", externalProductId: 32485 };

describe("mapProduct", () => {
  it("акційний товар: стара ціна стає звичайною", () => {
    const o = mapProduct(milk, "delivery:b1");
    expect(o).toMatchObject({ productId: "576829", price: 54.9, regularPrice: 79.99, packSize: 0.9, packUnit: "kg", inStock: true, slug: milk.slug });
    expect(o.url).toBe("https://silpo.ua/product/moloko-ferma-ultrapasteryzovane-2-5-576829");
  });
  it("ваговий товар: ціна за кг", () => {
    const o = mapProduct(banana, "b1");
    expect(o).toMatchObject({ price: 82.15, regularPrice: null, packSize: 1, packUnit: "kg" });
  });
  it("id магазинів", () => {
    expect(storeKey("delivery:abc")).toEqual({ branchId: "abc", deliveryType: "DeliveryHome" });
    expect(storeKey("abc")).toEqual({ branchId: "abc", deliveryType: "SelfPickup" });
  });
});

/** Мінімальна імітація D1 для settings і oauth_tokens. */
function fakeDb() {
  const settings = new Map<string, string>();
  const token = { access_token: "tok", refresh_token: "r", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      if (sql.includes("FROM settings")) return settings.has(args[0] as string) ? { value: settings.get(args[0] as string) } : null;
      if (sql.includes("FROM oauth_tokens")) return token;
      if (sql.includes("FROM products")) return { slug: "banan-32485" };
      return null;
    },
    run: async () => {
      if (sql.startsWith("INSERT INTO settings")) settings.set(args[0] as string, args[1] as string);
      return {};
    },
    all: async () => ({ results: [] }),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async () => [], settings } as unknown as D1Database & { settings: Map<string, string> };
}

function rpc(result: unknown, id: number) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("SilpoMcpSource через MCP", () => {
  it("getOffers: initialize → слот → пакетний пошук за артикулами", async () => {
    const calls: { method: string; tool?: string; args?: Record<string, unknown>; auth?: string; session?: string | null }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const h = init.headers as Record<string, string>;
      calls.push({ method: body.method, tool: body.params?.name, args: body.params?.arguments, auth: h.authorization, session: h["mcp-session-id"] ?? null });
      if (body.method === "initialize") return rpc({ protocolVersion: "2025-06-18", capabilities: {} }, body.id);
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.params.name === "silpo_get_time_slots")
        return rpc({ content: [{ type: "text", text: JSON.stringify({ slots: [{ start: "2030-01-01T10:00:00+00:00", end: "2030-01-01T11:30:00+00:00", available: true }] }) }] }, body.id);
      if (body.params.name === "silpo_find_products_batch") {
        const q = body.params.arguments.products as string[];
        const text = JSON.stringify({ queries: q.map((x) => ({ query: x, products: x === "576829" ? [milk] : x === "32485" ? [banana] : [] })) });
        // відповідь у вигляді SSE-потоку — теж має працювати
        return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text }] } })}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      }
      throw new Error("unexpected " + body.params?.name);
    });

    const db = fakeDb();
    const env = { DB: db, SILPO_MCP_URL: "https://mcp.silpo.ua/mcp", TIMEZONE: "Europe/Kyiv" } as unknown as Env;
    const src = new SilpoMcpSource(env);
    const offers = await src.getOffers(["576829", "32485", "999"], "delivery:b1");

    expect(offers.map((o) => o.productId)).toEqual(["576829", "32485"]);
    expect(calls.map((c) => c.tool ?? c.method)).toEqual(["initialize", "notifications/initialized", "silpo_get_time_slots", "silpo_find_products_batch"]);
    expect(calls[0]!.auth).toBe("Bearer tok");
    expect(calls[3]!.session).toBe("s1");
    expect(calls[3]!.args).toMatchObject({ branchId: "b1", deliveryType: "DeliveryHome", timeslotStart: "2030-01-01T10:00:00+00:00", products: ["576829", "32485", "999"] });
    // слот закешовано
    expect([...db.settings.keys()]).toContain("slot:delivery:b1");
  });
});
