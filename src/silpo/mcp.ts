import type { Env, ProductOffer, SilpoSource, StoreInfo } from "../types";

/**
 * Мінімальний MCP-клієнт (Streamable HTTP, JSON-RPC 2.0) для офіційного сервера Сільпо
 * https://mcp.silpo.ua/mcp. Авторизація — OAuth 2.1 від імені акаунта дружини;
 * токени лежать у таблиці oauth_tokens.
 *
 * СТАТУС: протокольна частина готова. Назви інструментів і розбір їхніх відповідей
 * (TOOL_MAP і mapProduct нижче) будуть заповнені після огляду реальних 39 інструментів
 * сервера — до того SilpoMcpSource кидає зрозумілу помилку, а застосунок працює в режимі mock.
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

/** Відповідність наших операцій інструментам сервера Сільпо. Заповнюється після огляду MCP. */
export const TOOL_MAP = {
  search: "", // пошук товарів
  offers: "", // ціни/акції за id товарів у магазині
  similar: "", // заміни / схожі товари
  stores: "", // список магазинів
  history: "", // історія замовлень
} as const;

async function loadToken(env: Env): Promise<string> {
  const row = await env.DB.prepare("SELECT access_token, expires_at FROM oauth_tokens WHERE provider = 'silpo'").first<{
    access_token: string;
    expires_at: string | null;
  }>();
  if (!row) throw new McpError("Сільпо ще не підключено: дружині треба увійти в акаунт у налаштуваннях", 401);
  // TODO: оновлення токена через refresh_token, коли з'ясуємо параметри OAuth сервера.
  return row.access_token;
}

export class SilpoMcpSource implements SilpoSource {
  private client: McpClient;

  constructor(private env: Env) {
    this.client = new McpClient(env.SILPO_MCP_URL, () => loadToken(env));
  }

  private notReady(op: keyof typeof TOOL_MAP): never {
    throw new McpError(`Інтеграція з MCP Сільпо ще не налаштована (${op}). Застосунок працює в режимі mock.`);
  }

  async searchProducts(_query: string, _storeId: string, _limit = 10): Promise<ProductOffer[]> {
    if (!TOOL_MAP.search) this.notReady("search");
    return [];
  }

  async getOffers(_productIds: string[], _storeId: string): Promise<ProductOffer[]> {
    if (!TOOL_MAP.offers) this.notReady("offers");
    return [];
  }

  async findSimilar(_productId: string, _storeId: string, _limit = 5): Promise<ProductOffer[]> {
    if (!TOOL_MAP.similar) this.notReady("similar");
    return [];
  }

  async listStores(_query?: string): Promise<StoreInfo[]> {
    if (!TOOL_MAP.stores) this.notReady("stores");
    return [];
  }

  async getPurchaseHistory(): Promise<{ productId: string; name: string; timesBought: number; lastBought?: string }[]> {
    if (!TOOL_MAP.history) this.notReady("history");
    return [];
  }

  /** Діагностика: список інструментів сервера (для сторінки налаштувань і налагодження). */
  listTools() {
    return this.client.listTools();
  }
}
