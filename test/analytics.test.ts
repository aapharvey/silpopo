import { describe, expect, it } from "vitest";
import { analyze, median, promoCycle, unitPrice, type HistoryPoint } from "../src/analytics";
import { queryFromSilpoUrl } from "../src/telegram";
import { daysAgo } from "../src/util/time";

const today = "2026-11-09";

/** Історія: звичайна ціна 100, акція 75 кожні 14 днів по 3 дні. */
function cyclic(days = 60, every = 14, len = 3): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (let d = days; d >= 1; d--) {
    const promo = d % every < len;
    out.push({ day: daysAgo(today, d), price: promo ? 75 : 100, regular_price: promo ? 100 : null });
  }
  return out;
}

describe("median / unitPrice", () => {
  it("рахує медіану", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
  it("рахує ціну за кг", () => {
    expect(unitPrice(389, 0.25, "kg")).toEqual({ value: 1556, unit: "кг" });
    expect(unitPrice(10, null, "kg")).toBeNull();
  });
});

describe("analyze", () => {
  it("справжня знижка відносно типової ціни", () => {
    const a = analyze(cyclic(), { price: 75, regular_price: 100 }, today);
    expect(a.typical).toBe(100);
    expect(a.discountVsTypical).toBe(0.25);
    expect(["record", "great"]).toContain(a.verdict);
  });

  it("розпізнає фейкову акцію: «стара» ціна завищена, а платиш як зазвичай", () => {
    const a = analyze(cyclic(), { price: 100, regular_price: 130 }, today);
    expect(a.verdict).toBe("fake");
  });

  it("рекордно низька ціна + можна запастися", () => {
    const a = analyze(cyclic(), { price: 60, regular_price: 100 }, today, { stockable: true });
    expect(a.verdict).toBe("record");
    expect(a.advice).toMatch(/запастися/);
  });

  it("оцінює цикл акцій і радить почекати", () => {
    const h = cyclic(60, 14, 3);
    const { cycle } = promoCycle(h, 100);
    expect(cycle).toBe(14);
    const a = analyze(h, { price: 100, regular_price: null }, today);
    expect(a.promoCycleDays).toBe(14);
    expect(a.nextPromoInDays).not.toBeNull();
  });

  it("без історії довіряє стікеру акції", () => {
    const a = analyze([], { price: 80, regular_price: 100 }, today);
    expect(a.verdict).toBe("great");
    expect(a.typical).toBe(100); // звичайна — зі старої ціни на цінику
  });

  it("почали стежити посеред акції — це не фейк", () => {
    // 2 дні історії, обидва в акції по 75 (на цінику стара ціна 100), сьогодні акція триває
    const h: HistoryPoint[] = [
      { day: daysAgo(today, 2), price: 75, regular_price: 100 },
      { day: daysAgo(today, 1), price: 75, regular_price: 100 },
    ];
    const a = analyze(h, { price: 75, regular_price: 100 }, today);
    expect(a.verdict).not.toBe("fake");
    expect(a.verdict).toBe("great");
    expect(a.typical).toBe(100);
  });

  it("фейк — лише коли самі бачили звичайну ціну", () => {
    // бачили 5 днів без акції по 100, тепер «акція» з ціною 100 і старою 130
    const h: HistoryPoint[] = [5, 4, 3, 2, 1].map((d) => ({ day: daysAgo(today, d), price: 100, regular_price: null }));
    expect(analyze(h, { price: 100, regular_price: 130 }, today).verdict).toBe("fake");
    // а без таких днів — не звинувачуємо
    expect(analyze([], { price: 100, regular_price: 130 }, today).verdict).not.toBe("fake");
  });

  it("мало історії — цикл не оцінюється", () => {
    const a = analyze(cyclic(10), { price: 100, regular_price: null }, today);
    expect(a.promoCycleDays).toBeNull();
  });
});

describe("queryFromSilpoUrl", () => {
  it("витягає назву з посилання", () => {
    expect(queryFromSilpoUrl("глянь https://silpo.ua/product/kava-lavazza-qualita-oro-250g-123456")).toBe("kava lavazza qualita oro 250g");
    expect(queryFromSilpoUrl("просто текст")).toBeNull();
  });
});

import { analyzeAtbHtml } from "../src/atb/collector";
describe("analyzeAtbHtml", () => {
  it("розпізнає перевірку Cloudflare", () => {
    const r = analyzeAtbHtml("<html><head><title>Just a moment...</title></head><body>" + "x".repeat(2000) + "<script>window._cf_chl_opt={}</script></body></html>", "u");
    expect(r.verdict).toBe("challenge");
  });
  it("розпізнає сторінку з товарами", () => {
    const card = '<a href="/product/moloko-galychyna-25-900g">Молоко</a><span>45,90 грн</span>';
    const r = analyzeAtbHtml("<html><title>Пошук — АТБ</title>" + card.repeat(10) + "</html>", "u");
    expect(r.verdict).toBe("ok");
    expect(r.productLinks).toBe(1);
  });
});
