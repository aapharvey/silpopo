import { daysBetween } from "./util/time";

export interface HistoryPoint {
  day: string; // YYYY-MM-DD
  price: number; // скільки платили (з акцією)
  regular_price: number | null;
}

export interface CurrentPrice {
  price: number;
  regular_price: number | null;
  promo_until?: string | null;
}

export type Verdict =
  | "record" // найнижча ціна за період
  | "great" // справжня суттєва знижка
  | "good" // невелика справжня знижка
  | "fake" // "акція", але ціна не нижча за типову
  | "normal" // звичайна ціна
  | "high"; // дорожче, ніж зазвичай

export interface Analysis {
  typical: number | null; // медіана ціни за період
  min: number | null; // мінімум за період
  discountVsTypical: number | null; // 0.23 = на 23% дешевше за типову
  verdict: Verdict;
  promoCycleDays: number | null; // як часто буває акція
  nextPromoInDays: number | null; // через скільки днів очікувати наступну
  daysOfHistory: number;
  advice: string | null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Ціна за кг / л / шт. */
export function unitPrice(price: number, packSize?: number | null, packUnit?: string | null): { value: number; unit: string } | null {
  if (!packSize || !packUnit || packSize <= 0) return null;
  const unit = packUnit === "kg" ? "кг" : packUnit === "l" ? "л" : "шт";
  return { value: Math.round((price / packSize) * 100) / 100, unit };
}

/** Знаходить епізоди акцій і оцінює їхній цикл. */
export function promoCycle(history: HistoryPoint[], typical: number | null): { cycle: number | null; lastStart: string | null } {
  const sorted = [...history].sort((a, b) => a.day.localeCompare(b.day));
  const isPromo = (p: HistoryPoint) => p.regular_price != null || (typical != null && p.price < typical * 0.93);
  const starts: string[] = [];
  let prevPromo = false;
  let prevDay: string | null = null;
  for (const p of sorted) {
    const promo = isPromo(p);
    // нова акція, якщо вчора її не було або є пропуск у даних більше ніж 2 дні
    const gap = prevDay ? daysBetween(prevDay, p.day) : 0;
    if (promo && (!prevPromo || gap > 2)) starts.push(p.day);
    prevPromo = promo;
    prevDay = p.day;
  }
  if (starts.length < 2) return { cycle: null, lastStart: starts.at(-1) ?? null };
  const gaps = starts.slice(1).map((d, i) => daysBetween(starts[i]!, d));
  const cycle = median(gaps);
  return { cycle: cycle != null ? Math.round(cycle) : null, lastStart: starts.at(-1)! };
}

const money = (n: number) => `${n.toFixed(2).replace(".", ",")} ₴`;

export function analyze(
  history: HistoryPoint[],
  current: CurrentPrice | null,
  today: string,
  opts: { stockable?: boolean; minDaysForCycle?: number } = {},
): Analysis {
  const prices = history.map((h) => h.price);
  // "Звичайна" ціна — медіана днів без акції. Якщо таких днів ще мало (почали стежити посеред акції),
  // беремо стару ціну з цінника Сільпо: інакше акційна ціна сама стала б «звичайною»,
  // і справжню акцію ми б несправедливо назвали фейковою.
  const regularDays = history.filter((h) => h.regular_price == null).map((h) => h.price);
  const enoughRegular = regularDays.length >= 3;
  const stickers = [...history.map((h) => h.regular_price), current?.regular_price ?? null].filter((x): x is number => x != null && x > 0);
  const typical = enoughRegular ? median(regularDays) : stickers.length ? median(stickers) : median(prices);
  const min = prices.length ? Math.min(...prices) : null;
  const daysOfHistory = history.length ? daysBetween(history.map((h) => h.day).sort()[0]!, today) + 1 : 0;

  let verdict: Verdict = "normal";
  let discountVsTypical: number | null = null;

  if (current && typical) {
    discountVsTypical = Math.round((1 - current.price / typical) * 100) / 100;
    // «Рекорд» і «фейк» — лише коли ми самі бачили звичайну ціну щонайменше 3 дні.
    const enoughHistory = history.length >= 7 && enoughRegular;
    if (enoughHistory && min != null && current.price <= min && discountVsTypical >= 0.05) verdict = "record";
    else if (discountVsTypical >= 0.15) verdict = "great";
    else if (discountVsTypical >= 0.05) verdict = "good";
    else if (current.regular_price != null && enoughRegular) verdict = "fake";
    else if (discountVsTypical <= -0.07 && enoughRegular) verdict = "high";
  }

  const { cycle, lastStart } = daysOfHistory >= (opts.minDaysForCycle ?? 28) ? promoCycle(history, typical) : { cycle: null, lastStart: null };
  let nextPromoInDays: number | null = null;
  if (cycle && lastStart) {
    const n = cycle - daysBetween(lastStart, today);
    nextPromoInDays = n >= 0 ? n : null;
  }

  const inPromoNow = verdict === "record" || verdict === "great" || verdict === "good";
  let advice: string | null = null;
  const fromSticker = !enoughRegular && current?.regular_price != null;
  if (fromSticker && (verdict === "great" || verdict === "good")) {
    // Історії ще немає — спираємося лише на цінник Сільпо.
    advice = `Акція: звичайна ціна ${money(current!.regular_price!)}`;
  } else if (verdict === "record") advice = opts.stockable ? "Рекордно низька ціна — варто запастися" : "Рекордно низька ціна";
  else if (verdict === "great") advice = opts.stockable ? `Дешевше, ніж зазвичай (звичайна ціна ${money(typical!)}) — можна взяти про запас` : `Дешевше, ніж зазвичай (звичайна ціна ${money(typical!)})`;
  else if (verdict === "good") advice = `Трохи дешевше, ніж зазвичай (звичайна ціна ${money(typical!)})`;
  else if (verdict === "fake") advice = "«Акція», але ціна не нижча за звичайну";
  // Радимо почекати, лише коли акція дуже близько (до 4 днів), інакше порада стає шумом.
  if (!inPromoNow && nextPromoInDays != null && nextPromoInDays <= 4) {
    const wait = nextPromoInDays <= 1 ? `акція (кожні ~${cycle} дн.) очікується з дня на день` : `акція зазвичай буває кожні ~${cycle} дн., наступна — орієнтовно через ${nextPromoInDays} дн.`;
    advice = advice ? `${advice}; ${wait}` : `Якщо не терміново — почекай: ${wait}`;
  }

  return { typical, min, discountVsTypical, verdict, promoCycleDays: cycle, nextPromoInDays, daysOfHistory, advice };
}
