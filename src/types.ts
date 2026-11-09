export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  SILPO_MODE: "mock" | "mcp";
  SILPO_MCP_URL: string;
  TIMEZONE: string;
  DIGEST_HOUR: string;
  ALLOWED_EMAILS?: string;
  COLLECT_BATCH: string;
  // Cloudflare Access: домен команди (xxx.cloudflareaccess.com) і Application Audience (AUD) tag
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  // 'open' — без входу (лише в режимі mock); 'password' — пароль (секрет APP_PASSWORD); 'access' — Cloudflare Access
  AUTH_MODE?: "open" | "password" | "access";
  APP_PASSWORD?: string;

  // Секрети
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Лише для локальної розробки: пропустити перевірку Cloudflare Access.
  DEV_NO_AUTH?: string;
}

/** Те, що ми знаємо про товар у конкретному магазині на цей момент. */
export interface ProductOffer {
  productId: string;
  slug?: string | null; // адреса товару в Сільпо (для схожих товарів)
  name: string;
  brand?: string | null;
  category?: string | null;
  packSize?: number | null; // 0.9
  packUnit?: "kg" | "l" | "pcs" | null;
  imageUrl?: string | null;
  url?: string | null;

  storeId: string;
  price: number; // скільки платиш зараз (з акцією)
  regularPrice?: number | null; // стара ціна, якщо акція
  promoType?: string | null;
  promoUntil?: string | null; // YYYY-MM-DD
  inStock: boolean;
}

export interface StoreInfo {
  id: string;
  name: string;
  kind: "store" | "delivery";
}

/**
 * Джерело даних Сільпо. Реальна реалізація — через офіційний MCP (src/silpo/mcp.ts),
 * для розробки — мок із детермінованими даними (src/silpo/mock.ts).
 */
export interface SilpoSource {
  searchProducts(query: string, storeId: string, limit?: number): Promise<ProductOffer[]>;
  getOffers(productIds: string[], storeId: string): Promise<ProductOffer[]>;
  /** Схожі товари / заміни. */
  findSimilar(productId: string, storeId: string, limit?: number): Promise<ProductOffer[]>;
  listStores(query?: string): Promise<StoreInfo[]>;
  /** Товари з історії замовлень з кількістю покупок (для стартового списку). */
  getPurchaseHistory(): Promise<{ productId: string; name: string; timesBought: number; lastBought?: string }[]>;
}
