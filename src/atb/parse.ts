import { parseRatio } from "../silpo/mcp";

/** Товар АТБ з картки на сторінці пошуку чи каталогу. */
export interface AtbCard {
  id: string; // data-productid
  slug: string; // /product/<slug>
  name: string;
  brand: string | null;
  category: string | null;
  price: number;
  oldPrice: number | null;
  label: string | null; // "-15%"
  perKg: boolean; // ціна за кг (вагові товари)
  packSize: number | null;
  packUnit: "kg" | "l" | "pcs" | null;
  image: string | null;
}

const attr = (block: string, name: string) => block.match(new RegExp(`data-${name}="([^"]*)"`))?.[1] ?? null;
const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/** Розмір упаковки з назви АТБ: "Молоко 0,9 кг …" → 0.9 кг, "Молоко 300г …" → 0.3 кг. */
export function sizeFromName(name: string): { size: number; unit: "kg" | "l" | "pcs" } | null {
  const m = name.replace(/,/g, ".").match(/(\d+(?:\.\d+)?)\s*(кг|г|мл|л|шт)(?![а-яіїєґ])/i);
  return m ? parseRatio(`${m[1]}${m[2]!.toLowerCase()}`) : null;
}

/**
 * Розбирає HTML сторінки АТБ (пошук / каталог). Працює лише з блоком карток, щоб економити CPU.
 */
export function parseAtbCards(html: string): AtbCard[] {
  const start = html.indexOf("<article");
  const end = html.lastIndexOf("</article>");
  if (start < 0 || end < 0) return [];
  const block = html.slice(start, end + 10);
  const out: AtbCard[] = [];
  for (const part of block.split("<article").slice(1)) {
    if (!part.includes("catalog-item")) continue;
    const title = part.match(/catalog-item__title[^>]*>\s*<a href="\/product\/([^"]+)"[^>]*>([^<]+)</);
    const top = part.match(/<data value="([\d.]+)" class="product-price__top/);
    const id = attr(part, "productid");
    if (!title || !top || !id) continue;
    const bottom = part.match(/<data value="([\d.]+)" class="product-price__bottom/);
    const unit = part.match(/product-price__unit">([^<]*)</)?.[1] ?? "";
    const label = part.match(/custom-product-label"[^>]*>\s*([^<]*?)\s*</)?.[1] || null;
    const name = decode(title[2]!);
    const perKg = /кг/.test(unit) || attr(part, "current-measure") === "kg";
    const size = perKg ? { size: 1, unit: "kg" as const } : sizeFromName(name);
    const price = Number(top[1]);
    const old = bottom ? Number(bottom[1]) : null;
    out.push({
      id,
      slug: title[1]!,
      name,
      brand: attr(part, "brand") ? decode(attr(part, "brand")!) : null,
      category: attr(part, "category") ? decode(attr(part, "category")!) : null,
      price,
      oldPrice: old && old > price ? old : null,
      label: label ? decode(label) : null,
      perKg,
      packSize: size?.size ?? null,
      packUnit: size?.unit ?? null,
      image: part.match(/<img src="([^"]+)"/)?.[1] ?? null,
    });
  }
  return out;
}

export function currentShopId(html: string): string | null {
  return html.match(/currentShopId:\s*(\d+)/)?.[1] ?? null;
}
