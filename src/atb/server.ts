import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "../types";
import { getSetting, setSetting } from "../db";
import { analyzeAtbHtml, atbSearchUrl, processAtbPage, returnAtbTask, takeAtbTask } from "./collector";
import { parseAtbCards } from "./parse";

/**
 * Автоматичний збір цін АТБ із самого Cloudflare — без телефона.
 * Застосунок сам визначає робочий спосіб і пам'ятає його:
 *   fetch   — звичайний запит із сервера (найшвидше, без лімітів);
 *   browser — вбудований браузер Cloudflare (10 хв/день безкоштовно ≈ 100+ сторінок);
 *   none    — АТБ не пускає сервер; тоді працює iPhone, а сервер перевіряє знову через 6 год.
 * Захист сайту не обходимо: якщо АТБ показує перевірку «я не робот», просто відступаємо.
 */

export type ServerMethod = "fetch" | "browser" | "none";
export interface ServerMode {
  method: ServerMethod;
  checked: string;
  detail?: string;
}

const MODE = "atb_server_mode";
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const TEST_URL = atbSearchUrl("молоко");

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;

export async function fetchHtml(url: string): Promise<{ status: number; html: string }> {
  const r = await fetch(url, { headers: { "user-agent": UA, "accept-language": "uk-UA,uk;q=0.9", accept: "text/html,application/xhtml+xml" } });
  return { status: r.status, html: await r.text() };
}

export async function browserHtml(browser: Browser, url: string): Promise<{ status: number | null; html: string }> {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(UA);
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    let html = await page.content();
    // Сторінка «зачекайте» — даємо звичайному браузеру кілька секунд, як людині. Капчу не розв'язуємо.
    if (analyzeAtbHtml(html, url).verdict === "challenge") {
      await new Promise((r) => setTimeout(r, 8_000));
      html = await page.content();
    }
    return { status: resp?.status() ?? null, html };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function getServerMode(env: Env): Promise<ServerMode | null> {
  const raw = await getSetting(env.DB, MODE);
  return raw ? (JSON.parse(raw) as ServerMode) : null;
}

async function saveMode(env: Env, method: ServerMethod, detail?: string): Promise<ServerMode> {
  const m: ServerMode = { method, checked: new Date().toISOString(), detail };
  await setSetting(env.DB, MODE, JSON.stringify(m));
  return m;
}

/** Визначає, яким способом сервер може отримати сторінку АТБ. */
export async function detectServerMode(env: Env): Promise<ServerMode> {
  let fetchNote: string;
  try {
    const { status, html } = await fetchHtml(TEST_URL);
    if (parseAtbCards(html).length) return saveMode(env, "fetch", `HTTP ${status}`);
    fetchNote = `запит: ${analyzeAtbHtml(html, TEST_URL).verdict}, HTTP ${status}`;
  } catch (e) {
    fetchNote = `запит: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (env.BROWSER) {
    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const { status, html } = await browserHtml(browser, TEST_URL);
      if (parseAtbCards(html).length) return saveMode(env, "browser", `HTTP ${status ?? "?"}`);
      return saveMode(env, "none", `${fetchNote}; браузер: ${analyzeAtbHtml(html, TEST_URL).verdict}, HTTP ${status ?? "?"}`);
    } catch (e) {
      return saveMode(env, "none", `${fetchNote}; браузер: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  return saveMode(env, "none", fetchNote);
}

/**
 * Обробляє до maxPages сторінок із черги «несвіжих» позицій.
 * Викликається одразу після додавання товару і з cron кожні 15 хв (лише коли є що перевіряти).
 * maxPages малий, щоб вкластися в 10 мс CPU безкоштовного тарифу.
 */
export async function atbServerRun(env: Env, maxPages = 1): Promise<{ method: ServerMethod; processed: number }> {
  let mode = await getServerMode(env);
  const age = mode ? Date.now() - Date.parse(mode.checked) : Infinity;
  if (!mode || (mode.method === "none" && age > 6 * 3_600_000)) mode = await detectServerMode(env);
  if (mode.method === "none") return { method: "none", processed: 0 };

  let browser: Browser | null = null;
  let processed = 0;
  try {
    for (let i = 0; i < maxPages; i++) {
      const task = await takeAtbTask(env);
      if (!task) break;
      const url = atbSearchUrl(task.q);
      let html: string;
      try {
        if (mode.method === "fetch") html = (await fetchHtml(url)).html;
        else {
          browser ??= await puppeteer.launch(env.BROWSER!);
          html = (await browserHtml(browser, url)).html;
        }
      } catch (e) {
        await returnAtbTask(env);
        break; // тимчасова мережева помилка — спробуємо наступного разу
      }
      const r = await processAtbPage(env, task, html, "server");
      if (!r.ok) {
        // АТБ перестав пускати сервер — віддаємо позицію iPhone і перевіримо сервер пізніше.
        await returnAtbTask(env);
        await saveMode(env, "none", `${mode.method}: ${r.verdict}`);
        return { method: "none", processed };
      }
      processed++;
    }
  } finally {
    await browser?.close().catch(() => {});
  }
  return { method: mode.method, processed };
}
