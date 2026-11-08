// Кошик — веб-інтерфейс. Без фреймворків: хеш-маршрутизація + рендер шаблонами.

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (n) => (n == null ? "—" : `${Number(n).toFixed(2).replace(".", ",")} ₴`);
const pct = (x) => `${Math.round(x * 100)}%`;
const localTime = (t) => (t ? new Date(t.replace(" ", "T") + "Z").toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "");
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");

const state = { me: null, lists: [], listId: null, items: [], searchSeq: 0 };

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Помилка ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}
const fail = (e) => toast(`😕 ${e.message}`);

/* ───────── Нижній аркуш ───────── */
function openSheet(html) {
  $("#sheet-content").innerHTML = html;
  $("#sheet").hidden = false;
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
}
$("#sheet").addEventListener("click", (e) => e.target.closest("[data-close]") && closeSheet());
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());

/* ───────── Відображення ціни / вердикту ───────── */
const VERDICT = {
  record: { cls: "record", label: (a) => `🔥 рекорд −${pct(a.discountVsTypical)}` },
  great: { cls: "great", label: (a) => `−${pct(a.discountVsTypical)}` },
  good: { cls: "good", label: (a) => `−${pct(a.discountVsTypical)}` },
  fake: { cls: "fake", label: () => "«акція»" },
  high: { cls: "high", label: () => "дорожче" },
};
const isDeal = (o) => o && o.inStock && ["record", "great", "good"].includes(o.analysis.verdict);

function badge(o) {
  const v = o && VERDICT[o.analysis.verdict];
  return v ? `<span class="badge ${v.cls}">${esc(v.label(o.analysis))}</span>` : "";
}
function adviceCls(o) {
  if (!o) return "";
  const v = o.analysis.verdict;
  return v === "record" ? "hot" : v === "great" || v === "good" ? "good" : v === "fake" ? "warn" : "";
}

/* ───────── Списки ───────── */
async function renderLists() {
  view.innerHTML = `<div class="empty"><span class="spin">◐</span></div>`;
  const { lists, defaultListId } = await api("/lists");
  state.lists = lists;
  if (!state.listId || !lists.some((l) => l.id === state.listId)) state.listId = defaultListId;
  const { items } = await api(`/lists/${state.listId}/items`);
  state.items = items;
  drawLists();
}

function drawLists() {
  const banner =
    state.me && !state.me.stores
      ? `<div class="banner">Спершу виберіть магазин у <a href="#/settings">налаштуваннях</a> — без нього ціни не збираються.</div>`
      : "";
  view.innerHTML = `
    ${banner}
    <div class="listbar">
      ${state.lists.map((l) => `<button class="pill ${l.id === state.listId ? "active" : ""}" data-list="${l.id}">${esc(l.emoji ?? "")} ${esc(l.name)}<span class="count">${l.open ?? 0}</span></button>`).join("")}
      <button class="pill" data-newlist>＋ Новий</button>
    </div>
    <div class="adder">
      <input id="q" type="search" placeholder="Додати товар: «кава лаваца», «молоко 2,5»…" autocomplete="off" enterkeyhint="search">
      <div id="results"></div>
    </div>
    <div class="items">${state.items.length ? state.items.map(itemHtml).join("") : `<div class="empty"><div class="big">🧺</div>Список порожній.<br>Почніть вводити назву товару вище.</div>`}</div>
    ${state.items.some((i) => i.checked) ? `<div class="toolbar"><span class="muted small">Відмічені — куплено</span><button class="btn ghost small" data-clear>Прибрати куплене</button></div>` : ""}
  `;
}

/** Перемалювати поточну вкладку після змін у позиції. */
function redraw() {
  if ((location.hash || "#/").startsWith("#/deals")) renderDeals().catch(fail);
  else drawLists();
}

function itemHtml(i) {
  const m = i.main;
  const best = m?.best;
  const deal = m?.offers.find(isDeal);
  const shown = deal ?? best;
  const cls = ["item", i.checked ? "done" : "", deal ? (deal.analysis.verdict === "record" ? "hot" : "deal") : ""].join(" ");
  const sub = [];
  if (i.query && m) sub.push(`найвигідніше: ${esc(m.product.name)}`);
  if (shown) sub.push(esc(shown.storeName));
  if (shown?.promoUntil && isDeal(shown)) sub.push(`до ${ddmm(shown.promoUntil)}`);
  if (shown?.unit) sub.push(`${money(shown.unit.value)}/${shown.unit.unit}`);
  if (shown && !shown.inStock) sub.push("немає в наявності");
  const alt = i.alternatives[0];
  return `
    <div class="${cls}" data-item="${i.id}">
      <button class="check ${i.checked ? "on" : ""}" data-check="${i.id}" aria-label="Куплено">${i.checked ? "✓" : ""}</button>
      <div class="i-main" data-open="${i.id}">
        <div class="i-title">${esc(i.title)}${i.quantity !== 1 ? `<span class="i-qty">× ${i.quantity}</span>` : ""}${i.stockable ? ' <span title="Можна запастися">📦</span>' : ""}</div>
        ${sub.length ? `<div class="i-sub">${sub.join(" · ")}</div>` : !m ? `<div class="i-sub">${i.query ? "шукаю варіанти…" : "ціна ще збирається…"}</div>` : ""}
        ${shown?.analysis.advice && !i.checked ? `<div class="i-advice ${adviceCls(shown)}">${esc(shown.analysis.advice)}</div>` : ""}
        ${alt && !i.checked ? `<div class="i-alt">🔄 Дешевше: <b>${esc(alt.product.name)}</b> — ${money(alt.best.price)} (−${pct(alt.savingPct)} за ${esc(alt.best.unit?.unit ?? "од.")})</div>` : ""}
      </div>
      <div class="i-price">
        ${shown ? `<div class="price num">${money(shown.price)}</div>${shown.regularPrice ? `<div class="old num">${money(shown.regularPrice)}</div>` : ""}${badge(shown)}` : `<span class="nodata">—</span>`}
      </div>
    </div>`;
}

let searchTimer;
async function doSearch(q) {
  const box = $("#results");
  if (!box) return;
  if (q.trim().length < 2) {
    box.innerHTML = "";
    return;
  }
  const seq = ++state.searchSeq;
  box.innerHTML = `<div class="results"><div class="result"><span class="muted">Шукаю…</span></div></div>`;
  try {
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    if (seq !== state.searchSeq) return;
    box.innerHTML = `<div class="results">
      ${results
        .map(
          (r) => `<button class="result" data-add-product="${esc(r.productId)}">
            <span><div class="r-name">${esc(r.name)}</div><div class="r-sub">${r.inStock ? "" : "немає в наявності · "}${r.promoUntil ? `акція до ${ddmm(r.promoUntil)}` : esc(r.category ?? "")}</div></span>
            <span style="text-align:right"><div class="num">${money(r.price)}</div>${r.regularPrice ? `<div class="old num">${money(r.regularPrice)}</div>` : ""}</span>
          </button>`,
        )
        .join("")}
      <button class="result generic" data-add-query="${esc(q.trim())}"><span><div class="r-name">＋ «${esc(q.trim())}» — будь-який бренд</div><div class="r-sub">Підбиратиму найвигідніший варіант серед схожих</div></span></button>
    </div>`;
  } catch (e) {
    box.innerHTML = "";
    fail(e);
  }
}

async function addToList(body) {
  try {
    const item = await api(`/lists/${state.listId}/items`, { method: "POST", body });
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) state.items[idx] = item;
    else state.items.unshift(item);
    const l = state.lists.find((x) => x.id === state.listId);
    if (l && idx < 0) l.open = (l.open ?? 0) + 1;
    drawLists();
    toast(`Додано: ${item.title}`);
    $("#q")?.focus();
  } catch (e) {
    fail(e);
  }
}

async function patchItem(id, body) {
  const item = await api(`/items/${id}`, { method: "PATCH", body });
  const idx = state.items.findIndex((i) => i.id === id);
  if (idx >= 0) state.items[idx] = item;
  return item;
}

function openItem(id) {
  const i = state.items.find((x) => x.id === id);
  if (!i) return;
  const m = i.main;
  openSheet(`
    <h2 style="margin-top:4px">${esc(i.title)}</h2>
    ${i.query ? `<div class="muted small">Загальна позиція: «${esc(i.query)}» — показую найвигідніший варіант.</div>` : ""}
    <div class="card row">
      <div class="qty"><button data-qty="-1">−</button><b class="num" id="qty">${i.quantity}</b><button data-qty="1">＋</button></div>
      <label class="small"><input type="checkbox" id="stockable" ${i.stockable ? "checked" : ""}> 📦 можна запастися</label>
    </div>
    ${
      m
        ? `${m.product.name !== i.title ? `<h3>${esc(m.product.name)}</h3>` : `<h3>Ціни по магазинах</h3>`}
           <div class="offers">${m.offers
             .map(
               (o) => `<div class="offer"><span><b>${esc(o.storeName)}</b><div class="muted small">${o.inStock ? "" : "немає · "}${o.promoUntil ? `акція до ${ddmm(o.promoUntil)} · ` : ""}типова ${money(o.analysis.typical)}</div></span>
                 <span style="text-align:right"><div class="price num">${money(o.price)}</div>${badge(o)}</span></div>`,
             )
             .join("") || `<div class="muted small">Ціни ще збираються.</div>`}</div>
           ${m.best?.analysis.advice ? `<div class="i-advice ${adviceCls(m.best)}" style="margin-top:10px">${esc(m.best.analysis.advice)}</div>` : ""}
           <div id="chart" class="card" style="margin-top:12px"><span class="muted small">Завантажую історію цін…</span></div>`
        : `<div class="card muted">Даних про ціну ще немає — збирач оновить їх найближчим часом.</div>`
    }
    ${
      i.alternatives.length
        ? `<h3>Дешевші схожі</h3><div class="offers">${i.alternatives
            .map(
              (a) => `<div class="offer"><span>${esc(a.product.name)}<div class="muted small">${esc(a.best.storeName)} · ${money(a.best.unit?.value)}/${esc(a.best.unit?.unit ?? "од.")}</div></span>
                <span style="text-align:right"><div class="price num">${money(a.best.price)}</div><button class="btn small ghost" data-swap="${esc(a.product.id)}">Замінити</button></span></div>`,
            )
            .join("")}</div>`
        : ""
    }
    <div class="toolbar"><button class="btn danger" data-del="${i.id}">Видалити з списку</button><button class="btn" data-close>Готово</button></div>
  `);
  const sheet = $("#sheet-content");
  sheet.onclick = async (e) => {
    const q = e.target.closest("[data-qty]");
    if (q) {
      const nq = Math.max(1, i.quantity + Number(q.dataset.qty));
      i.quantity = nq;
      $("#qty").textContent = nq;
      patchItem(i.id, { quantity: nq }).then(redraw, fail);
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      await api(`/items/${i.id}`, { method: "DELETE" }).catch(fail);
      state.items = state.items.filter((x) => x.id !== i.id);
      closeSheet();
      redraw();
    }
    const swap = e.target.closest("[data-swap]");
    if (swap) {
      await api(`/items/${i.id}`, { method: "DELETE" }).catch(fail);
      state.items = state.items.filter((x) => x.id !== i.id);
      closeSheet();
      addToList({ productId: swap.dataset.swap, quantity: i.quantity, stockable: i.stockable });
    }
  };
  $("#stockable").onchange = (e) => patchItem(i.id, { stockable: e.target.checked }).then(redraw, fail);
  if (m) loadChart(m.product.id);
}

/* ───────── Графік історії цін (SVG) ───────── */
const COLORS = ["#2f8a4e", "#e8643c", "#3d6fb6", "#9a5fb5"];
async function loadChart(productId) {
  const box = $("#chart");
  try {
    const { history } = await api(`/products/${encodeURIComponent(productId)}`);
    const series = history.filter((h) => h.points.length > 1);
    if (!series.length) {
      box.innerHTML = `<span class="muted small">Історія цін з'явиться за кілька днів.</span>`;
      return;
    }
    const all = series.flatMap((s) => s.points);
    const days = [...new Set(all.map((p) => p.day))].sort();
    const min = Math.min(...all.map((p) => p.price));
    const max = Math.max(...all.map((p) => p.price));
    const W = 600, H = 180, P = 28;
    const x = (d) => P + ((W - P * 1.5) * days.indexOf(d)) / Math.max(1, days.length - 1);
    const y = (v) => H - P - ((H - P * 1.8) * (v - min)) / Math.max(0.01, max - min);
    const lines = series
      .map((s, k) => `<polyline fill="none" stroke="${COLORS[k % COLORS.length]}" stroke-width="2.5" stroke-linejoin="round" points="${s.points.map((p) => `${x(p.day).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ")}"/>`)
      .join("");
    box.innerHTML = `
      <div class="row small"><b>Ціна за ${days.length} дн.</b><span class="muted num">${money(min)} – ${money(max)}</span></div>
      <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Графік ціни">
        <line x1="${P}" x2="${W - P / 2}" y1="${y(min)}" y2="${y(min)}" stroke="currentColor" stroke-opacity=".15" stroke-dasharray="4 4"/>
        <line x1="${P}" x2="${W - P / 2}" y1="${y(max)}" y2="${y(max)}" stroke="currentColor" stroke-opacity=".15" stroke-dasharray="4 4"/>
        ${lines}
        <text x="${P}" y="${H - 6}" font-size="12" fill="currentColor" opacity=".55">${ddmm(days[0])}</text>
        <text x="${W - P / 2}" y="${H - 6}" font-size="12" text-anchor="end" fill="currentColor" opacity=".55">${ddmm(days.at(-1))}</text>
      </svg>
      <div class="legend">${series.map((s, k) => `<span><i style="background:${COLORS[k % COLORS.length]}"></i>${esc(s.store.name)}</span>`).join("")}</div>`;
  } catch (e) {
    box.innerHTML = `<span class="muted small">Не вдалося завантажити історію.</span>`;
  }
}

/* ───────── Вигідно ───────── */
async function renderDeals() {
  view.innerHTML = `<div class="empty"><span class="spin">◐</span></div>`;
  const d = await api("/deals");
  const stores = d.storeScores.filter((s) => s.deals > 0);
  view.innerHTML = `
    <h2>Вигідно зараз</h2>
    ${
      stores.length
        ? `<h3>Де вигідніше закупитися</h3><div class="stores-score">${stores
            .map((s, k) => `<div class="score ${k === 0 && stores.length > 1 ? "best" : ""}"><span><b>${esc(s.storeName)}</b><div class="muted small">${s.deals} товарів зі списків в акції</div></span><span class="num"><b>~${s.saving} ₴</b><div class="muted small">економії</div></span></div>`)
            .join("")}</div>`
        : ""
    }
    <h3>З ваших списків (${d.deals.length})</h3>
    <div class="items">${d.deals.length ? d.deals.map(itemHtml).join("") : `<div class="empty"><div class="big">🤷‍♀️</div>Зараз вигідних акцій на товари зі списків немає.</div>`}</div>
    ${d.alternatives.length ? `<h3>Схожі товари дешевше</h3><div class="items">${d.alternatives.map(itemHtml).join("")}</div>` : ""}
  `;
  state.items = [...d.deals, ...d.alternatives];
}

/* ───────── Налаштування ───────── */
async function renderSettings() {
  view.innerHTML = `<div class="empty"><span class="spin">◐</span></div>`;
  const [{ stores }, { lists, defaultListId }] = await Promise.all([api("/stores"), api("/lists")]);
  const me = state.me;
  view.innerHTML = `
    <h2>Магазини</h2>
    <div class="card stack">
      ${stores.map((s) => `<div class="row"><span>${s.kind === "delivery" ? "🚚" : "🏬"} ${esc(s.name)}</span><button class="btn danger small" data-rmstore="${esc(s.id)}">прибрати</button></div>`).join("") || `<div class="muted">Магазинів ще немає.</div>`}
      <input class="field" id="storeq" placeholder="Знайти магазин: вулиця, район…">
      <div id="storeres" class="stack"></div>
    </div>

    <h2>Списки</h2>
    <div class="card stack">
      ${lists
        .map(
          (l) => `<div class="row"><span>${esc(l.emoji ?? "")} ${esc(l.name)} ${l.id === defaultListId ? '<span class="muted small">· для Telegram</span>' : ""}</span>
            <span>${l.id !== defaultListId ? `<button class="btn ghost small" data-deflist="${l.id}">для бота</button>` : ""}<button class="btn ghost small" data-renlist="${l.id}">✎</button><button class="btn danger small" data-dellist="${l.id}">✕</button></span></div>`,
        )
        .join("")}
      <button class="btn ghost" data-newlist>＋ Новий список</button>
    </div>

    <h2>З історії замовлень</h2>
    <div class="card"><div class="muted small">Ваші часті покупки в Сільпо, яких ще немає у списках.</div><div id="sugg" class="stack" style="margin-top:8px"><button class="btn ghost" data-loadsugg>Показати</button></div></div>

    <h2>Telegram</h2>
    <div class="card stack">
      ${
        !me.telegramConfigured
          ? `<div class="muted small">Бот ще не налаштований на сервері.</div>`
          : me.telegramLinked
            ? `<div>✅ Бот підключено. Дайджест щодня о 8:00.</div><button class="btn ghost" data-tgtest>Надіслати дайджест зараз</button><button class="btn ghost small" data-tglink>Підключити інший чат</button>`
            : `<div class="muted small">Підключіть бота, щоб отримувати ранковий дайджест і додавати товари з Telegram.</div><button class="btn" data-tglink>Підключити Telegram</button>`
      }
      ${me.telegramConfigured ? `<button class="btn ghost small" data-tgwebhook>Зареєструвати вебхук бота</button>` : ""}
      <div id="tglink"></div>
    </div>

    <h2>Обслуговування</h2>
    <div class="card stack small">
      <div class="row"><span>Джерело даних</span><b>${me.mode === "mock" ? "тестові дані" : "MCP Сільпо"}</b></div>
      <div class="row"><span>Остання перевірка цін</span><span class="num">${esc(localTime(me.lastCheck) || "ще не було")}</span></div>
      <div class="row"><span>Вхід</span><span>${esc(me.email)}</span></div>
      <button class="btn ghost" data-collect>Оновити ціни зараз</button>
      ${me.mode === "mock" ? `<button class="btn ghost" data-seed>Заповнити демо-даними</button>` : ""}
    </div>
  `;
  let t;
  $("#storeq").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const { stores: found } = await api(`/stores/search?q=${encodeURIComponent(e.target.value)}`);
        $("#storeres").innerHTML = found.map((s) => `<button class="result" data-addstore='${esc(JSON.stringify(s))}'><span>${s.kind === "delivery" ? "🚚" : "🏬"} ${esc(s.name)}</span><span>＋</span></button>`).join("");
      } catch (err) {
        fail(err);
      }
    }, 300);
  };
}

/* ───────── Делегування подій ───────── */
document.addEventListener("click", async (e) => {
  const el = (s) => e.target.closest(s);
  try {
    if (el("[data-list]")) {
      state.listId = Number(el("[data-list]").dataset.list);
      await renderLists();
    } else if (el("[data-newlist]")) {
      const name = prompt("Назва нового списку", "");
      if (!name?.trim()) return;
      const l = await api("/lists", { method: "POST", body: { name } });
      state.listId = l.id;
      location.hash = "#/";
      await renderLists();
    } else if (el("[data-add-product]")) {
      await addToList({ productId: el("[data-add-product]").dataset.addProduct });
      $("#q").value = "";
      $("#results").innerHTML = "";
    } else if (el("[data-add-query]")) {
      await addToList({ query: el("[data-add-query]").dataset.addQuery });
      $("#q").value = "";
      $("#results").innerHTML = "";
    } else if (el("[data-check]")) {
      const id = Number(el("[data-check]").dataset.check);
      const it = state.items.find((i) => i.id === id);
      await patchItem(id, { checked: !it.checked });
      redraw();
    } else if (el("[data-open]")) {
      openItem(Number(el("[data-open]").dataset.open));
    } else if (el("[data-clear]")) {
      await api(`/lists/${state.listId}/clear-checked`, { method: "POST" });
      await renderLists();
    } else if (el("[data-addstore]")) {
      const s = JSON.parse(el("[data-addstore]").dataset.addstore);
      await api("/stores", { method: "POST", body: s });
      await refreshMe();
      await renderSettings();
      toast("Магазин додано — ціни почнуть збиратися");
    } else if (el("[data-rmstore]")) {
      await api(`/stores/${encodeURIComponent(el("[data-rmstore]").dataset.rmstore)}`, { method: "DELETE" });
      await refreshMe();
      await renderSettings();
    } else if (el("[data-deflist]")) {
      await api(`/lists/${el("[data-deflist]").dataset.deflist}`, { method: "PATCH", body: { makeDefault: true } });
      await renderSettings();
    } else if (el("[data-renlist]")) {
      const id = el("[data-renlist]").dataset.renlist;
      const name = prompt("Нова назва", state.lists.find((l) => l.id == id)?.name ?? "");
      if (!name?.trim()) return;
      await api(`/lists/${id}`, { method: "PATCH", body: { name } });
      await renderSettings();
    } else if (el("[data-dellist]")) {
      if (!confirm("Видалити список разом із товарами?")) return;
      await api(`/lists/${el("[data-dellist]").dataset.dellist}`, { method: "DELETE" });
      await renderSettings();
    } else if (el("[data-loadsugg]")) {
      const { suggestions } = await api("/suggestions");
      $("#sugg").innerHTML = suggestions.length
        ? suggestions.map((s) => `<label class="row"><span><input type="checkbox" value="${esc(s.productId)}" checked> ${esc(s.name)}</span><span class="muted small">${s.timesBought}×</span></label>`).join("") +
          `<button class="btn" data-acceptsugg>Додати вибране в «${esc(state.lists.find((l) => l.id === state.listId)?.name ?? "список")}»</button>`
        : `<div class="muted small">Усі часті покупки вже у списках 👍</div>`;
    } else if (el("[data-acceptsugg]")) {
      const ids = [...document.querySelectorAll("#sugg input:checked")].map((i) => i.value);
      const { lists } = await api("/lists");
      const listId = state.listId ?? lists[0].id;
      const r = await api("/suggestions/accept", { method: "POST", body: { listId, productIds: ids } });
      toast(`Додано ${r.added} товарів`);
      $("#sugg").innerHTML = "";
    } else if (el("[data-tglink]")) {
      const r = await api("/telegram/link", { method: "POST" });
      $("#tglink").innerHTML = `<a class="btn" href="${esc(r.link)}" target="_blank" rel="noopener">Відкрити бота в Telegram</a><div class="muted small" style="margin-top:6px">Натисніть «Start» у боті. Посилання діє 1 годину.</div>`;
    } else if (el("[data-tgwebhook]")) {
      const r = await api("/telegram/webhook", { method: "POST" });
      toast(`Вебхук: ${r.url}`);
    } else if (el("[data-tgtest]")) {
      const r = await api("/telegram/test", { method: "POST" });
      toast(r.result === "sent" ? "Дайджест надіслано" : r.result === "nothing" ? "Вигідного зараз немає — надіслала про це повідомлення" : "Чат не підключено");
    } else if (el("[data-collect]")) {
      const r = await api("/collect", { method: "POST" });
      toast(`Перевірено ${r.checked} цін`);
      await refreshMe();
    } else if (el("[data-seed]")) {
      const btn = el("[data-seed]");
      btn.disabled = true;
      // Заповнення кроками, щоб кожен запит вкладався в ліміти безкоштовного Cloudflare.
      for (let step = 0; step != null; ) {
        const r = await api(`/dev/seed?step=${step}`, { method: "POST" });
        btn.textContent = `Заповнюю… ${Math.round(((r.next ?? r.steps) / r.steps) * 100)}%`;
        step = r.next;
      }
      await refreshMe();
      toast("Демо-дані додано");
      location.hash = "#/";
    }
  } catch (err) {
    fail(err);
  }
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doSearch(e.target.value), 280);
  }
});

/* ───────── Маршрутизація ───────── */
async function refreshMe() {
  state.me = await api("/me");
  $("#status").textContent = state.me.mode === "mock" ? "тестові дані" : state.me.lastCheck ? `ціни: ${localTime(state.me.lastCheck)}` : "";
}

async function route() {
  closeSheet();
  const h = location.hash || "#/";
  const tab = h.startsWith("#/deals") ? "deals" : h.startsWith("#/settings") ? "settings" : "lists";
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  try {
    if (!state.me) await refreshMe();
    if (tab === "deals") await renderDeals();
    else if (tab === "settings") await renderSettings();
    else await renderLists();
  } catch (e) {
    view.innerHTML = `<div class="empty"><div class="big">🔒</div>${esc(e.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();
