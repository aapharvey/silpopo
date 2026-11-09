import type { AtbCard } from "./parse";

/**
 * Зіставлення товару Сільпо з товарами АТБ.
 *  - same:   той самий товар (тип + бренд + жирність/відсоток + фасовка) — дружина підтверджує один раз;
 *  - analog: той самий тип і одиниця (кг/л/шт), інший бренд — порівнюємо за ціною за одиницю.
 * Власні марки мереж ніколи не вважаються «тим самим».
 */

export interface SilpoRef {
  name: string;
  packSize: number | null;
  packUnit: string | null;
}

// Латинські літери, які в назвах АТБ іноді стоять замість кириличних ("Мoлoкo").
const HOMO: Record<string, string> = { a: "а", c: "с", e: "е", i: "і", o: "о", p: "р", x: "х", y: "у", k: "к", m: "м", t: "т", h: "н", b: "в" };

export function normName(s: string): string {
  let t = s.toLowerCase().replace(/[«»"'’`®™()]/g, " ");
  // замінюємо латинські двійники лише всередині кириличних слів
  t = t.replace(/[a-zа-яіїєґ]+/g, (w) => (/[а-яіїєґ]/.test(w) ? w.replace(/[a-z]/g, (ch) => HOMO[ch] ?? ch) : w));
  return t.replace(/\s+/g, " ").trim();
}

const OWN_BRANDS = ["своя лінія", "розумний вибір", "de luxe foods", "премія", "повна чаша", "metro chef", "aro", "rioba", "horeca select"];

export function isOwnBrand(brand: string | null | undefined): boolean {
  const b = normName(brand ?? "");
  return !!b && OWN_BRANDS.some((x) => b.includes(x));
}

/** Основний тип товару — перше слово, обрізане до основи ("яйця"/"яйце" → "яйц"). */
export function typeStem(name: string): string {
  const w = normName(name).split(" ")[0] ?? "";
  return w.slice(0, Math.max(4, w.length - 2));
}

export function percentOf(name: string): string | null {
  return name.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*%/)?.[1] ?? null;
}

/** Бренд у назві Сільпо зазвичай у лапках: «Галичина». */
export function silpoBrand(name: string): string | null {
  return name.match(/«([^»]+)»/)?.[1] ?? null;
}

/** Короткий пошуковий запит для АТБ на основі назви Сільпо: тип + бренд + відсоток. */
export function atbQueryFor(name: string): string {
  const type = normName(name).split(" ")[0] ?? "";
  const brand = silpoBrand(name);
  const pct = percentOf(name);
  if (brand) return [type, normName(brand), pct ? `${pct.replace(".", ",")}%` : ""].filter(Boolean).join(" ");
  // без лапок — перші 3–4 значущі слова
  return normName(name)
    .split(" ")
    .filter((w) => w.length > 1)
    .slice(0, 4)
    .join(" ");
}

// Слова, що роблять товар іншим: безлактозне молоко ≠ звичайне, згущене ≠ питне тощо.
const QUALIFIERS = ["безлактоз", "згущ", "дитяч", "для дітей", "пряжен", "органіч", "сух", "кокос", "мигдал", "вівсян", "соєв", "шоколад", "какао", "без цукру", "знежир"];
const qualifiersOf = (name: string) => {
  const n = normName(name);
  return QUALIFIERS.filter((q) => n.includes(q)).sort().join("|");
};

const unitPrice = (price: number, size: number | null) => (size && size > 0 ? price / size : null);

export interface MatchResult {
  same: { card: AtbCard; score: number } | null;
  analog: { card: AtbCard; perUnit: number } | null;
}

export function matchCards(silpo: SilpoRef, cards: AtbCard[]): MatchResult {
  const stem = typeStem(silpo.name);
  const pct = percentOf(silpo.name);
  const brand = normName(silpoBrand(silpo.name) ?? "");
  const sName = normName(silpo.name);
  const quals = qualifiersOf(silpo.name);
  const sameType = cards.filter((c) => typeStem(c.name) === stem && qualifiersOf(c.name) === quals);

  let same: MatchResult["same"] = null;
  for (const c of sameType) {
    const cb = normName(c.brand ?? "");
    const brandOk = !!cb && (brand ? brand.includes(cb) || cb.includes(brand) : sName.includes(cb));
    if (!brandOk || isOwnBrand(c.brand)) continue;
    const cp = percentOf(c.name);
    if ((pct || cp) && pct !== cp) continue;
    let score = 0.7;
    if (silpo.packSize && c.packSize && silpo.packUnit === c.packUnit) {
      const diff = Math.abs(silpo.packSize - c.packSize) / silpo.packSize;
      if (diff > 0.08) continue; // інша фасовка — не той самий товар
      score += 0.3 * (1 - diff / 0.08);
    }
    if (!same || score > same.score) same = { card: c, score: Math.round(score * 100) / 100 };
  }

  let analog: MatchResult["analog"] = null;
  for (const c of sameType) {
    if (same && c.id === same.card.id) continue;
    if (silpo.packUnit && c.packUnit && silpo.packUnit !== c.packUnit) continue;
    const cp = percentOf(c.name);
    if (pct && cp && pct !== cp) continue;
    const pu = unitPrice(c.price, c.packSize);
    if (pu == null) continue;
    // дуже малі фасовки (стіки, порції) не порівнюємо з звичайними
    if (silpo.packSize && c.packSize && c.packSize < silpo.packSize / 4) continue;
    if (!analog || pu < analog.perUnit) analog = { card: c, perUnit: Math.round(pu * 100) / 100 };
  }
  return { same, analog };
}
