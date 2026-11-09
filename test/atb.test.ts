import { describe, expect, it } from "vitest";
import html from "./fixtures/atb-search-moloko.html?raw";
import { parseAtbCards, sizeFromName, currentShopId } from "../src/atb/parse";
import { atbQueryFor, matchCards, normName, typeStem } from "../src/atb/match";


describe("parseAtbCards", () => {
  const cards = parseAtbCards(html);
  it("розбирає картки зі сторінки пошуку АТБ", () => {
    expect(cards.length).toBe(14);
    const sale = cards.find((c) => c.id === "135089")!;
    expect(sale).toMatchObject({ name: "Молоко 0,9 кг Своя Лінія ультрапастеризоване 1%", price: 39.9, oldPrice: 47.3, label: "-15%", brand: "Своя Лінія", packSize: 0.9, packUnit: "kg" });
    expect(sale.slug).toBe("moloko-09-kg-svoa-linia-ultrapasterizovane-1");
    const plain = cards.find((c) => c.id === "125868")!;
    expect(plain).toMatchObject({ price: 57.9, oldPrice: null, brand: "Молокія" });
  });
  it("магазин сторінки", () => expect(currentShopId(html)).toBe("101332"));
  it("розмір з назви", () => {
    expect(sizeFromName("Молоко 300г Ічня згущене")).toEqual({ size: 0.3, unit: "kg" });
    expect(sizeFromName("Молоко  370 г Iчня")).toEqual({ size: 0.37, unit: "kg" });
    expect(sizeFromName("Сік 1,5 л Sandora")).toEqual({ size: 1.5, unit: "l" });
  });
});

describe("зіставлення", () => {
  const cards = parseAtbCards(html);
  it("нормалізує латинські двійники", () => {
    expect(normName("Мoлoкo 330 г")).toBe("молоко 330 г");
    expect(typeStem("Молоко «Галичина»")).toBe(typeStem("Молоко 0,9 кг"));
  });
  it("запит для АТБ з назви Сільпо", () => {
    expect(atbQueryFor("Молоко «Галичина» ультрапастеризоване 2,5%")).toBe("молоко галичина 2,5%");
  });
  it("той самий товар: бренд + жирність + фасовка", () => {
    const m = matchCards({ name: "Молоко «Молокія» ультрапастеризоване 2,5%", packSize: 0.9, packUnit: "kg" }, cards);
    expect(m.same?.card.id).toBe("125868"); // Молоко 0,9 кг Молокія 2,5%
  });
  it("інша жирність — не той самий; аналог — найдешевший за кг з тією ж жирністю", () => {
    const m = matchCards({ name: "Молоко «Галичина» ультрапастеризоване 2,5%", packSize: 0.95, packUnit: "kg" }, cards);
    expect(m.same).toBeNull();
    expect(m.analog).not.toBeNull();
    expect(m.analog!.card.name).toMatch(/2,5%/);
  });
  it("безлактозне чи згущене не плутаємо зі звичайним молоком", () => {
    const m = matchCards({ name: "Молоко «Галичина» безлактозне 2,5%", packSize: 0.87, packUnit: "kg" }, cards);
    expect(m.analog?.card.name ?? "").toMatch(/безлактозне/);
    const plain = matchCards({ name: "Молоко «Ічня» 2,5%", packSize: 0.9, packUnit: "kg" }, cards);
    expect(plain.analog?.card.name ?? "").not.toMatch(/згущ/);
  });
  it("власна марка не буває «тим самим»", () => {
    const m = matchCards({ name: "Молоко «Своя Лінія» ультрапастеризоване 1%", packSize: 0.9, packUnit: "kg" }, cards);
    expect(m.same).toBeNull();
  });
});
