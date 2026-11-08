import type { ProductOffer, SilpoSource, StoreInfo } from "../types";
import { todayIn } from "../util/time";

/**
 * Мок-джерело для розробки та демонстрації інтерфейсу без підключення до Сільпо.
 * Ціни детерміновані: залежать від товару, магазину і дня, з періодичними "акціями",
 * тож історія цін і поради виглядають правдоподібно.
 */

interface MockProduct {
  id: string;
  name: string;
  brand: string;
  category: string;
  packSize: number;
  packUnit: "kg" | "l" | "pcs";
  base: number; // звичайна ціна, грн
  promoEvery: number; // цикл акції, днів
  promoLen: number; // тривалість акції, днів
  promoDiscount: number; // 0.25 = -25%
}

const CATALOG: MockProduct[] = [
  { id: "m-milk-1", name: "Молоко 2,5% Галичина 900 мл", brand: "Галичина", category: "Молоко", packSize: 0.9, packUnit: "l", base: 46.9, promoEvery: 14, promoLen: 4, promoDiscount: 0.2 },
  { id: "m-milk-2", name: "Молоко 2,5% Простоквашино 840 г", brand: "Простоквашино", category: "Молоко", packSize: 0.84, packUnit: "l", base: 44.5, promoEvery: 21, promoLen: 7, promoDiscount: 0.25 },
  { id: "m-milk-3", name: "Молоко 2,5% Лавка Традицій 1 л", brand: "Лавка Традицій", category: "Молоко", packSize: 1, packUnit: "l", base: 52.9, promoEvery: 28, promoLen: 7, promoDiscount: 0.15 },
  { id: "m-coffee-1", name: "Кава мелена Lavazza Qualità Oro 250 г", brand: "Lavazza", category: "Кава", packSize: 0.25, packUnit: "kg", base: 389, promoEvery: 28, promoLen: 7, promoDiscount: 0.3 },
  { id: "m-coffee-2", name: "Кава мелена Jacobs Monarch 225 г", brand: "Jacobs", category: "Кава", packSize: 0.225, packUnit: "kg", base: 229, promoEvery: 21, promoLen: 5, promoDiscount: 0.25 },
  { id: "m-coffee-3", name: "Кава в зернах Illy Classico 250 г", brand: "Illy", category: "Кава", packSize: 0.25, packUnit: "kg", base: 519, promoEvery: 35, promoLen: 7, promoDiscount: 0.2 },
  { id: "m-eggs-1", name: "Яйця курячі С1 Ясенсвіт 10 шт", brand: "Ясенсвіт", category: "Яйця", packSize: 10, packUnit: "pcs", base: 72.9, promoEvery: 10, promoLen: 3, promoDiscount: 0.15 },
  { id: "m-eggs-2", name: "Яйця курячі С0 Квочка 10 шт", brand: "Квочка", category: "Яйця", packSize: 10, packUnit: "pcs", base: 84.9, promoEvery: 18, promoLen: 4, promoDiscount: 0.2 },
  { id: "m-cheese-1", name: "Сир Гауда 45% Комо 150 г", brand: "Комо", category: "Сир твердий", packSize: 0.15, packUnit: "kg", base: 98.9, promoEvery: 14, promoLen: 7, promoDiscount: 0.25 },
  { id: "m-cheese-2", name: "Сир Гауда 48% Звенигора 180 г", brand: "Звенигора", category: "Сир твердий", packSize: 0.18, packUnit: "kg", base: 109.9, promoEvery: 21, promoLen: 7, promoDiscount: 0.3 },
  { id: "m-bread-1", name: "Хліб Український Київхліб 750 г", brand: "Київхліб", category: "Хліб", packSize: 0.75, packUnit: "kg", base: 34.9, promoEvery: 30, promoLen: 2, promoDiscount: 0.1 },
  { id: "m-butter-1", name: "Масло вершкове 82% Яготинське 200 г", brand: "Яготинське", category: "Масло", packSize: 0.2, packUnit: "kg", base: 109.9, promoEvery: 14, promoLen: 5, promoDiscount: 0.2 },
  { id: "m-butter-2", name: "Масло вершкове 82% Президент 200 г", brand: "President", category: "Масло", packSize: 0.2, packUnit: "kg", base: 124.9, promoEvery: 21, promoLen: 7, promoDiscount: 0.25 },
  { id: "m-yogurt-1", name: "Йогурт грецький 2% Галичина 200 г", brand: "Галичина", category: "Йогурт", packSize: 0.2, packUnit: "kg", base: 39.9, promoEvery: 7, promoLen: 3, promoDiscount: 0.2 },
  { id: "m-pasta-1", name: "Макарони Barilla Spaghetti №5 500 г", brand: "Barilla", category: "Макарони", packSize: 0.5, packUnit: "kg", base: 79.9, promoEvery: 21, promoLen: 7, promoDiscount: 0.3 },
  { id: "m-pasta-2", name: "Макарони Чумак спагеті 400 г", brand: "Чумак", category: "Макарони", packSize: 0.4, packUnit: "kg", base: 45.9, promoEvery: 28, promoLen: 7, promoDiscount: 0.2 },
  { id: "m-rice-1", name: "Рис довгозернистий Сквирянка 1 кг", brand: "Сквирянка", category: "Крупи", packSize: 1, packUnit: "kg", base: 89.9, promoEvery: 30, promoLen: 7, promoDiscount: 0.2 },
  { id: "m-buck-1", name: "Гречка ядриця Хуторок 1 кг", brand: "Хуторок", category: "Крупи", packSize: 1, packUnit: "kg", base: 62.9, promoEvery: 21, promoLen: 5, promoDiscount: 0.15 },
  { id: "m-oil-1", name: "Олія соняшникова Олейна 850 мл", brand: "Олейна", category: "Олія", packSize: 0.85, packUnit: "l", base: 79.9, promoEvery: 14, promoLen: 7, promoDiscount: 0.2 },
  { id: "m-chicken-1", name: "Філе куряче охолоджене Наша Ряба 1 кг", brand: "Наша Ряба", category: "М'ясо", packSize: 1, packUnit: "kg", base: 219, promoEvery: 10, promoLen: 3, promoDiscount: 0.15 },
  { id: "m-banana-1", name: "Банани ваговi 1 кг", brand: "", category: "Фрукти", packSize: 1, packUnit: "kg", base: 74.9, promoEvery: 14, promoLen: 4, promoDiscount: 0.2 },
  { id: "m-apple-1", name: "Яблука Голден ваговi 1 кг", brand: "", category: "Фрукти", packSize: 1, packUnit: "kg", base: 44.9, promoEvery: 21, promoLen: 7, promoDiscount: 0.25 },
  { id: "m-powder-1", name: "Пральний порошок Persil Color 2,7 кг", brand: "Persil", category: "Побутова хімія", packSize: 2.7, packUnit: "kg", base: 429, promoEvery: 28, promoLen: 10, promoDiscount: 0.4 },
  { id: "m-powder-2", name: "Пральний порошок Ariel Color 2,7 кг", brand: "Ariel", category: "Побутова хімія", packSize: 2.7, packUnit: "kg", base: 449, promoEvery: 35, promoLen: 10, promoDiscount: 0.4 },
  { id: "m-tp-1", name: "Туалетний папір Zewa Deluxe 8 рулонів", brand: "Zewa", category: "Побутова хімія", packSize: 8, packUnit: "pcs", base: 189, promoEvery: 21, promoLen: 7, promoDiscount: 0.3 },
];

const STORES: StoreInfo[] = [
  { id: "mock-store-1", name: "Сільпо, вул. Антоновича 50 (тест)", kind: "store" },
  { id: "mock-store-2", name: "Сільпо, просп. Берестейський 2 (тест)", kind: "store" },
  { id: "mock-store-3", name: "Сільпо, вул. Здолбунівська 7 (тест)", kind: "store" },
  { id: "delivery", name: "Доставка додому", kind: "delivery" },
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(day + "T00:00:00Z") / 86_400_000);
}

function addDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Округлення до копійок у стилі цінників: 46.9 → 46.90, 44.53 → 44.50 */
const round = (n: number) => Math.round(n * 10) / 10;

/** Ціна товару в магазині на певний день (детерміновано). Експортується для тестів і сидінгу історії. */
export function mockOfferFor(p: MockProduct, storeId: string, day: string): ProductOffer {
  const seed = hash(p.id + storeId);
  const d = dayNumber(day);
  const phase = seed % p.promoEvery;
  const inCycle = (d + phase) % p.promoEvery;
  const inPromo = inCycle < p.promoLen;
  const storeFactor = 1 + ((seed % 7) - 3) / 100; // ±3% між магазинами
  const drift = 1 + Math.floor((d % 365) / 90) * 0.01; // повільна інфляція
  const regular = round(p.base * storeFactor * drift);
  const price = inPromo ? round(regular * (1 - p.promoDiscount)) : regular;
  return {
    productId: p.id,
    name: p.name,
    brand: p.brand || null,
    category: p.category,
    packSize: p.packSize,
    packUnit: p.packUnit,
    imageUrl: null,
    url: null,
    storeId,
    price,
    regularPrice: inPromo ? regular : null,
    promoType: inPromo ? "Знижка" : null,
    promoUntil: inPromo ? addDays(day, p.promoLen - inCycle - 1) : null,
    inStock: (seed + d) % 41 !== 0,
  };
}

export class MockSilpoSource implements SilpoSource {
  constructor(private tz = "Europe/Kyiv") {}

  private today() {
    return todayIn(this.tz);
  }

  async searchProducts(query: string, storeId: string, limit = 10): Promise<ProductOffer[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return CATALOG.filter((p) => {
      const hay = `${p.name} ${p.brand} ${p.category}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
      .slice(0, limit)
      .map((p) => mockOfferFor(p, storeId, this.today()));
  }

  async getOffers(productIds: string[], storeId: string): Promise<ProductOffer[]> {
    const day = this.today();
    return CATALOG.filter((p) => productIds.includes(p.id)).map((p) => mockOfferFor(p, storeId, day));
  }

  async findSimilar(productId: string, storeId: string, limit = 5): Promise<ProductOffer[]> {
    const p = CATALOG.find((x) => x.id === productId);
    if (!p) return [];
    return CATALOG.filter((x) => x.category === p.category && x.id !== p.id)
      .slice(0, limit)
      .map((x) => mockOfferFor(x, storeId, this.today()));
  }

  async listStores(query?: string): Promise<StoreInfo[]> {
    if (!query) return STORES;
    const q = query.toLowerCase();
    return STORES.filter((s) => s.name.toLowerCase().includes(q));
  }

  async getPurchaseHistory() {
    const picks = ["m-milk-1", "m-coffee-1", "m-eggs-1", "m-cheese-1", "m-bread-1", "m-butter-1", "m-banana-1", "m-yogurt-1", "m-powder-1"];
    return picks.map((id, i) => {
      const p = CATALOG.find((x) => x.id === id)!;
      return { productId: id, name: p.name, timesBought: 12 - i, lastBought: addDays(this.today(), -(i + 2)) };
    });
  }
}

export const MOCK_CATALOG = CATALOG;
export { addDays };
