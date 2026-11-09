import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../types";
import { analyzeAtbHtml } from "./collector";
import { parseAtbCards } from "./parse";

/**
 * Перевірка: чи віддає АТБ сторінки самому Cloudflare (без телефона).
 *  A) звичайний запит із сервера;
 *  B) вбудований браузер Cloudflare (Browser Run) — справжній Chrome, але з серверної адреси.
 * Нічого не обходимо: якщо сайт показує перевірку «я не робот», просто фіксуємо це.
 */

const SAFARI_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const TEST_URL = "https://www.atbmarket.com/sch?lang=uk&query=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE";

export interface ServerProbe {
  method: "fetch" | "browser";
  ok: boolean;
  status: number | null;
  verdict: string;
  cards: number;
  ms: number;
  note: string;
}

async function viaFetch(): Promise<ServerProbe> {
  const t = Date.now();
  try {
    const r = await fetch(TEST_URL, { headers: { "user-agent": SAFARI_UA, "accept-language": "uk-UA,uk;q=0.9", accept: "text/html" } });
    const html = await r.text();
    const a = analyzeAtbHtml(html, TEST_URL);
    const cards = parseAtbCards(html).length;
    return { method: "fetch", ok: cards > 0, status: r.status, verdict: a.verdict, cards, ms: Date.now() - t, note: a.title ?? "" };
  } catch (e) {
    return { method: "fetch", ok: false, status: null, verdict: "error", cards: 0, ms: Date.now() - t, note: e instanceof Error ? e.message : String(e) };
  }
}

async function viaBrowser(env: Env): Promise<ServerProbe> {
  const t = Date.now();
  if (!env.BROWSER) return { method: "browser", ok: false, status: null, verdict: "unavailable", cards: 0, ms: 0, note: "Браузер Cloudflare не підключено" };
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setUserAgent(SAFARI_UA);
    const resp = await page.goto(TEST_URL, { waitUntil: "domcontentloaded", timeout: 25_000 });
    let html = await page.content();
    // Якщо це перевірка «зачекайте» — даємо звичайному браузеру кілька секунд, як людині.
    if (analyzeAtbHtml(html, TEST_URL).verdict === "challenge") {
      await new Promise((r) => setTimeout(r, 8_000));
      html = await page.content();
    }
    const a = analyzeAtbHtml(html, TEST_URL);
    const cards = parseAtbCards(html).length;
    return { method: "browser", ok: cards > 0, status: resp?.status() ?? null, verdict: a.verdict, cards, ms: Date.now() - t, note: a.title ?? "" };
  } catch (e) {
    return { method: "browser", ok: false, status: null, verdict: "error", cards: 0, ms: Date.now() - t, note: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export async function serverProbe(env: Env): Promise<ServerProbe[]> {
  return [await viaFetch(), await viaBrowser(env)];
}
