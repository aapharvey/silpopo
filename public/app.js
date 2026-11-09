// Silpopo — веб-інтерфейс у стилі «Розумний чек». Без фреймворків: хеш-маршрутизація + рендер шаблонами.
// Вкладки: Список (робота зі списком) · Асистент (поради й план покупки) · Налаштування.
// Правило текстів: жодних відсотків — кожна вигода показується готовою ціною.

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n).toLocaleString("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (n) => (n == null ? "—" : `${fmt(n)} ₴`);
const ddmm = (d) => (d ? `${d.slice(8, 10)}.${d.slice(5, 7)}` : "");
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`;
};
const goods = (n) => plural(n, "товар", "товари", "товарів");

const ICON = {
  down: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
  back: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>`,
  right: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8L20 8H6.2"/><circle cx="9" cy="20" r="1.3"/><circle cx="17" cy="20" r="1.3"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>`,
};

/* ───────── Локальне сховище (офлайн-кеш, налаштування вигляду) ───────── */
const ls = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`silpopo:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`silpopo:${k}`, JSON.stringify(v));
    } catch {
      /* сховище недоступне — не критично */
    }
  },
};

const state = {
  me: ls.get("me", null),
  lists: ls.get("lists", []),
  listId: ls.get("listId", null),
  items: [],
  stores: ls.get("stores", []),
  shop: ls.get("shop", null),
  showDone: false,
  searchSeq: 0,
};

/* ───────── Запити до сервера ───────── */
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? "GET",
      headers: opts.body ? { "content-type": "application/json" } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    const err = new Error("Немає зв'язку з інтернетом");
    err.offline = true;
    throw err;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `Помилка ${res.status}`);
    err.status = res.status;
    err.login = !!data.login;
    throw err;
  }
  return data;
}

/* Черга змін: галочки й кількість зберігаються миттєво на екрані, а на сервер ідуть у фоні.
   Без інтернету зміни чекають у черзі й надсилаються, щойно зв'язок повернеться. */
const queue = ls.get("queue", []);
let flushing = false;
function enqueue(op) {
  // нова зміна того самого поля замінює стару
  const i = queue.findIndex((q) => q.key && q.key === op.key);
  if (i >= 0) queue.splice(i, 1);
  queue.push(op);
  ls.set("queue", queue);
  flush();
}
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const op = queue[0];
      try {
        await api(op.path, { method: op.method, body: op.body });
      } catch (e) {
        if (e.offline) break;
        if (e.login) break;
        toast(`Не вдалося зберегти: ${e.message}`);
      }
      queue.shift();
      ls.set("queue", queue);
    }
  } finally {
    flushing = false;
    paintStatus();
  }
}
window.addEventListener("online", () => {
  flush();
  paintStatus();
});
window.addEventListener("offline", paintStatus);

/* ───────── Тост з «Скасувати» ───────── */
let toastTimer;
function toast(msg, action) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ""}`;
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => {
    t.hidden = true;
    action.fn();
  };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 5000 : 2600);
}
const fail = (e) => toast(e.offline ? "Немає інтернету — спробуйте пізніше" : e.message);

/* ───────── Нижній аркуш (закривається свайпом униз за ручку або кнопкою) ───────── */
const sheetBody = $(".sheet-body");
let onSheetClose = null;
function openSheet(html, onClose) {
  $("#sheet-content").innerHTML = html;
  $("#sheet").hidden = false;
  sheetBody.style.transform = "";
  sheetBody.scrollTop = 0;
  document.body.style.overflow = "hidden";
  onSheetClose = onClose ?? null;
}
function closeSheet() {
  if ($("#sheet").hidden) return;
  $("#sheet").hidden = true;
  document.body.style.overflow = "";
  $("#sheet-content").onclick = null;
  const cb = onSheetClose;
  onSheetClose = null;
  cb?.();
}
$("#sheet").addEventListener("click", (e) => e.target.closest("[data-close]") && closeSheet());
document.addEventListener("keydown", (e) => e.key === "Escape" && closeSheet());
(() => {
  // Свайп униз: за ручку — завжди, за вміст — коли аркуш прокручено до самого верху.
  let startY = null, dy = 0;
  const start = (y, fromGrab) => {
    if (!fromGrab && sheetBody.scrollTop > 0) return;
    startY = y;
    dy = 0;
    sheetBody.classList.add("dragging");
  };
  const move = (y, e) => {
    if (startY == null) return;
    dy = Math.max(0, y - startY);
    if (dy > 0 && e.cancelable) e.preventDefault();
    sheetBody.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (startY == null) return;
    sheetBody.classList.remove("dragging");
    startY = null;
    if (dy > 110) closeSheet();
    else sheetBody.style.transform = "";
  };
  sheetBody.addEventListener("touchstart", (e) => start(e.touches[0].clientY, !!e.target.closest(".grab")), { passive: true });
  sheetBody.addEventListener("touchmove", (e) => move(e.touches[0].clientY, e), { passive: false });
  sheetBody.addEventListener("touchend", end);
  sheetBody.addEventListener("touchcancel", end);
  const grab = $(".grab");
  grab.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    start(e.clientY, true);
    const mm = (ev) => move(ev.clientY, ev);
    const up = () => {
      end();
      window.removeEventListener("pointermove", mm);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", mm);
    window.addEventListener("pointerup", up);
  });
})();

/** Аркуш із полем вводу замість системного prompt(). */
function askText(title, value = "", button = "Зберегти") {
  return new Promise((resolve) => {
    let done = false;
    openSheet(
      `<h2>${esc(title)}</h2>
       <form id="ask" class="stack" style="margin-top:12px">
         <input class="field" id="ask-v" value="${esc(value)}" autocomplete="off" required>
         <button class="btn block big" type="submit">${esc(button)}</button>
       </form>`,
      () => !done && resolve(null),
    );
    const inp = $("#ask-v");
    setTimeout(() => inp.focus(), 50);
    $("#ask").onsubmit = (e) => {
      e.preventDefault();
      done = true;
      const v = inp.value.trim();
      closeSheet();
      resolve(v || null);
    };
  });
}
function askConfirm(title, text, button = "Так") {
  return new Promise((resolve) => {
    let done = false;
    openSheet(
      `<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
       <div class="sheet-foot"><button class="btn line" data-close>Скасувати</button><button class="btn" id="ask-yes">${esc(button)}</button></div>`,
      () => !done && resolve(false),
    );
    $("#ask-yes").onclick = () => {
      done = true;
      closeSheet();
      resolve(true);
    };
  });
}

/* ───────── Магазини й ціни ───────── */
const isDelivery = (s) => s && (s.kind === "delivery" || String(s.id).startsWith("delivery:"));
function storeLabel(s) {
  if (!s) return "";
  if (isDelivery(s)) return "Доставка Сільпо";
  const n = String(s.name)
    .replace(/^\s*сільпо\s*[,:—–-]?\s*/i, "")
    .replace(/(^|\s)(вул\.|вулиця|просп\.|проспект)\s*/gi, "$1")
    .trim();
  return n || s.name;
}
const storeById = (id) => state.stores.find((s) => s.id === id);
function homeStoreId() {
  const saved = ls.get("homeStore", null);
  if (saved && storeById(saved)) return saved;
  return (state.stores.find((s) => !isDelivery(s)) ?? state.stores[0])?.id ?? null;
}
const homeStore = () => storeById(homeStoreId());

/** Ціна товару в конкретному магазині (лише якщо є в наявності). */
function offerAt(i, sid) {
  const o = i.main?.offers.find((x) => x.storeId === sid);
  return o && o.inStock ? o : null;
}
/** Що показуємо в списку: ціна у «своєму» магазині, інакше найкраща з інших. */
function shownOffer(i) {
  return offerAt(i, homeStoreId()) ?? i.main?.best ?? null;
}
const was = (o) => {
  const w = o.analysis.typical ?? o.regularPrice;
  return w && w > o.price + 0.004 ? w : null;
};
const inPromo = (o) => ["record", "great", "good"].includes(o?.analysis.verdict);
const atbCheaper = (i, price) => {
  const s = i.atb?.same;
  return s && price != null && s.price < price - 0.5 && s.price <= price * 0.97 ? s : null;
};

/** Одна найважливіша мітка на позиції — завжди фактом із ціною. */
function signal(i) {
  const o = shownOffer(i);
  if (!o) return null;
  const a = o.analysis;
  const same = atbCheaper(i, o.price);
  if (same) return { cls: "save", atb: true, text: `дешевше — ${money(same.price)}` };
  if (a.verdict === "record") return { cls: "rec", text: was(o) ? `Рекорд · було ${money(was(o))}` : "Рекордна ціна" };
  if (inPromo(o) && was(o)) return { cls: "save", text: `Акція · було ${money(was(o))}` };
  if (a.nextPromoInDays != null && a.nextPromoInDays <= 4 && state.me?.today)
    return { cls: "cau", text: `Акція очікується ~${ddmm(addDays(state.me.today, a.nextPromoInDays))}` };
  const alt = i.alternatives?.[0];
  if (alt?.best) return { cls: "save", text: `Схожий: ${alt.product.name} — ${money(alt.best.price)}` };
  if (a.verdict === "fake") return { cls: "cau", text: "«Акція», але це звичайна ціна" };
  if (a.verdict === "high" && a.typical) return { cls: "cau", text: `Дорожче, ніж зазвичай (${money(a.typical)})` };
  const an = i.atb?.analog;
  if (an?.unit && o.unit && an.unit.unit === o.unit.unit && an.unit.value < o.unit.value * 0.85)
    return { cls: "save", atb: true, text: `схожий — ${money(an.price)}` };
  return null;
}
const tagHtml = (s) => (s ? `<span class="tag ${s.cls}">${s.atb ? "<b>АТБ</b>" : ""}${esc(s.text)}</span>` : "");

/* ───────── Відділи магазину (для режиму покупок) ───────── */
const W = "(?<![\\p{L}])"; // початок слова для кирилиці
const DEPTS = [
  ["Овочі й фрукти", /банан|яблук|груш|апельсин|мандарин|лимон|лайм|огір|помідор|томат|картопл|цибул|морк|капуст|перець|перці|часник|кабач|баклаж|авокадо|ягод|виноград|зелень|салат|кріп|петрушк|гриб|печериц|буряк|фрукт|овоч|ківі|гарбуз/iu],
  ["Хліб і випічка", /хліб|батон|багет|лаваш|булк|булоч|круасан|випічк|тост|хлібц/iu],
  ["Молочне і яйця", new RegExp(`молок|кефір|йогурт|сметан|${W}сир|сирок|масло вершк|вершк|ряжанк|кисломолоч|яйц|айран|біфідо|творож|масло \\d|масло солодк`, "iu")],
  ["М'ясо і риба", /м['’]яс|мяс|курк|курят|філе|фарш|свинин|ялович|телят|індич|ковбас|сосиск|сардельк|шинк|бекон|балик|риба|рибн|лосос|сьомг|оселед|скумбр|креветк|тунець|паштет/iu],
  ["Бакалія", new RegExp(`крупа|гречк|${W}рис|макарон|спагет|вермішел|борошн|цукор|${W}сіль|олія|оцет|кава|${W}чай|какао|вівсян|пластівц|мюслі|консерв|горох|квасол|соус|кетчуп|майонез|гірчиц|спеці|приправ|${W}мед`, "iu")],
  ["Солодке і снеки", /шоколад|цукерк|печиво|вафл|торт|тістеч|чипс|горіх|сухарик|батончик|морозив|снек|зефір|пастил|мармелад/iu],
  ["Напої", new RegExp(`${W}вода|${W}сік|нектар|напій|лимонад|пиво|вино|${W}кола|мінерал|енергетик`, "iu")],
  ["Заморожене", /заморож|пельмен|вареник|морожен/iu],
  ["Побут і хімія", /порошок|гель для прання|засіб|мийн|папір|серветк|рушник|губк|пакет|фольг|плівк|кондиціонер для білизни|відбілювач|капсули для прання|таблетки для посуд/iu],
  ["Гігієна і догляд", /шампун|мило|зубн|паста зубна|дезодор|гель для душу|прокладк|підгуз|бритв|крем|ватн|тампон/iu],
];
function deptOf(i) {
  const name = `${i.main?.product.name ?? ""} ${i.title}`;
  const k = DEPTS.findIndex(([, re]) => re.test(name));
  return k < 0 ? { k: 99, name: "Інше" } : { k, name: DEPTS[k][0] };
}

/* ───────── План покупки: суми по магазинах і розділений кошик Сільпо + АТБ ───────── */
function computePlan(items = state.items) {
  const open = items.filter((i) => !i.checked && i.main?.offers.length);
  const fallback = (i) => (i.main.best?.price ?? 0) * i.quantity;
  const homeId = homeStoreId();
  const options = [];
  for (const s of state.stores) {
    let total = 0, missing = 0, miss = 0;
    for (const i of open) {
      const o = offerAt(i, s.id);
      if (o) total += o.price * i.quantity;
      else {
        missing++;
        miss += fallback(i);
      }
    }
    options.push({ key: `one:${s.id}`, kind: "single", store: s, total, missing, rank: total + miss });
  }
  for (const s of state.stores.filter((x) => !isDelivery(x))) {
    const silpo = [], atb = [];
    let missing = 0, miss = 0, saving = 0;
    for (const i of open) {
      const o = offerAt(i, s.id);
      const same = i.atb?.same;
      if (same && (!o || same.price < o.price - 0.009)) {
        atb.push({ i, price: same.price, silpo: o?.price ?? null, name: same.name });
        if (o) saving += (o.price - same.price) * i.quantity;
      } else if (o) silpo.push({ i, price: o.price });
      else {
        missing++;
        miss += fallback(i);
      }
    }
    if (!atb.length || saving < 1) continue;
    const sum = (xs) => xs.reduce((a, x) => a + x.price * x.i.quantity, 0);
    const total = sum(silpo) + sum(atb);
    options.push({ key: `split:${s.id}`, kind: "split", store: s, silpo, atb, total, atbTotal: sum(atb), silpoTotal: sum(silpo), saving, missing, rank: total + miss });
  }
  options.sort((a, b) => a.rank - b.rank || (a.kind === "single" ? -1 : 1));
  const home = options.find((o) => o.key === `one:${homeId}`);
  for (const o of options) o.vsHome = home ? Math.max(0, home.rank - o.rank) : 0;
  return { options, best: options[0] ?? null, home, count: open.length };
}
/** Економія варіанта: для «Сільпо + АТБ» — порівняно з усім у тому ж Сільпо, інакше — порівняно зі «своїм» магазином. */
const optSaving = (o) => (o.kind === "split" ? o.saving : o.vsHome);
const optTitle = (o) => (o.kind === "split" ? `${storeLabel(o.store)} + АТБ` : storeLabel(o.store));

/* ───────── Списки ───────── */
async function loadItems() {
  try {
    const [{ lists, defaultListId }, { stores }] = await Promise.all([api("/lists"), api("/stores")]);
    state.lists = lists;
    state.stores = stores;
    ls.set("lists", lists);
    ls.set("stores", stores);
    if (!state.listId || !lists.some((l) => l.id === state.listId)) state.listId = defaultListId ?? lists[0]?.id;
    ls.set("listId", state.listId);
    const { items } = await api(`/lists/${state.listId}/items`);
    state.items = applyQueue(items);
    ls.set(`items:${state.listId}`, state.items);
    state.offline = false;
  } catch (e) {
    if (!e.offline) throw e;
    state.items = ls.get(`items:${state.listId}`, []);
    state.offline = true;
  }
  paintStatus();
  paintAssistantDot();
}
/** Накладає ще не надіслані зміни з черги на свіжі дані з сервера. */
function applyQueue(items) {
  for (const op of queue) {
    const m = op.path.match(/^\/items\/(\d+)$/);
    if (!m) continue;
    const it = items.find((i) => i.id === Number(m[1]));
    if (!it) continue;
    if (op.method === "PATCH") Object.assign(it, op.body);
  }
  return items.filter((i) => !queue.some((op) => op.method === "DELETE" && op.path === `/items/${i.id}`));
}
function saveItemsCache() {
  ls.set(`items:${state.listId}`, state.items);
}

async function renderList() {
  if (!state.items.length && !ls.get(`items:${state.listId}`, null)) {
    view.innerHTML = `<div class="topbar"><span class="wm">Silpopo</span></div><div class="receipt" style="margin-top:60px">${'<div class="skel"></div>'.repeat(4)}</div>`;
  } else {
    if (!state.items.length) state.items = ls.get(`items:${state.listId}`, []);
    drawList();
  }
  await loadItems();
  if (route.current === "lists") drawList();
}

function drawList() {
  const list = state.lists.find((l) => l.id === state.listId);
  const open = state.items.filter((i) => !i.checked);
  const done = state.items.filter((i) => i.checked);
  const hs = homeStore();
  const me = state.me;
  const banner =
    me && !me.silpoConnected
      ? `<div class="banner">Підключіть акаунт Сільпо в <a href="#/settings">налаштуваннях</a>, щоб бачити справжні ціни.</div>`
      : me && !me.stores
        ? `<div class="banner">Виберіть магазини в <a href="#/settings">налаштуваннях</a> — без них ціни не збираються.</div>`
        : "";
  let total = 0, noPrice = 0;
  for (const i of open) {
    const o = shownOffer(i);
    if (o) total += o.price * i.quantity;
    else noPrice++;
  }
  view.innerHTML = `
    <div class="topbar"><a class="wm" href="#/">Silpopo</a><span id="status" class="status"></span></div>
    <button class="title-btn" data-pick-list><b>${esc(list ? `${list.emoji ? `${list.emoji} ` : ""}${list.name}` : "Список")}</b>${ICON.down}</button>
    <div class="sub">${goods(open.length)}${hs ? ` · ціни: <button class="linkish" data-pick-store>${esc(storeLabel(hs))}</button>` : ""}</div>
    ${banner}
    <button class="adder-btn" data-go="#/add">${ICON.plus}Додати товар</button>
    ${
      open.length
        ? `<div class="receipt" style="margin-top:14px">
            ${open.map(rowHtml).join("")}
            <div class="r-total"><span class="lbl" style="color:var(--ink)">Разом${noPrice ? ` <span class="muted" style="text-transform:none;letter-spacing:0;font-family:Manrope,sans-serif;font-weight:600">· без ціни: ${noPrice}</span>` : ""}</span><span class="num">${money(total)}</span></div>
          </div>`
        : `<div class="empty"><b>${done.length ? "Усе куплено" : "Список порожній"}</b>${done.length ? "Можна прибрати куплене або додати нове." : "Додайте перший товар — назвою чи «будь-який бренд»."}</div>`
    }
    ${
      done.length
        ? `<div class="section-h"><span class="lbl">Куплено · ${done.length}</span><button class="btn line small" data-clear>Прибрати куплене</button></div>
           <div class="receipt">${done.map(rowHtml).join("")}</div>`
        : ""
    }
    ${open.length ? `<div class="cta-bar"><button class="btn block big" data-goshop>${ICON.cart}Іду в магазин</button></div>` : ""}
  `;
  paintStatus();
}

function rowHtml(i) {
  const o = shownOffer(i);
  const hs = homeStoreId();
  const lines = [];
  if (i.query && i.main) lines.push(`будь-який бренд · зараз ${i.main.product.name}`);
  if (o && hs && o.storeId !== hs && !i.checked) lines.push(`немає в цьому магазині · є: ${storeLabel(storeById(o.storeId)) || o.storeName}`);
  if (!i.main) lines.push(i.query ? "шукаю варіанти…" : "ціна ще збирається…");
  return `
    <div class="r-row ${i.checked ? "done" : ""}" data-item="${i.id}">
      <button class="cb ${i.checked ? "on" : ""}" data-check="${i.id}" aria-label="${i.checked ? "Повернути" : "Куплено"}: ${esc(i.title)}">${i.checked ? ICON.check : ""}</button>
      <button class="r-main" data-open="${i.id}">
        <span class="nm">${esc(i.title)}${i.quantity !== 1 ? ` <span class="qty">×${i.quantity}</span>` : ""}</span>
        ${lines.map((l) => `<span class="g-sub">${esc(l)}</span>`).join("")}
        ${i.checked ? "" : tagHtml(signal(i))}
      </button>
      <span class="pr">${o ? fmt(o.price * i.quantity) : "—"}</span>
    </div>`;
}

function toggleCheck(id) {
  const it = state.items.find((i) => i.id === id);
  if (!it) return;
  it.checked = !it.checked;
  saveItemsCache();
  const l = state.lists.find((x) => x.id === state.listId);
  if (l) l.open = state.items.filter((i) => !i.checked).length;
  enqueue({ key: `check:${id}`, method: "PATCH", path: `/items/${id}`, body: { checked: it.checked } });
  redraw();
}

function redraw() {
  if (route.current === "lists") drawList();
  else if (route.current === "shop") drawShop();
  else if (route.current === "assistant") drawAssistant();
  paintAssistantDot();
}

function paintStatus() {
  const el = $("#status");
  if (!el) return;
  const pending = queue.length;
  if (state.offline || !navigator.onLine) {
    el.className = "status off";
    el.textContent = pending ? `без інтернету · ${plural(pending, "зміна чекає", "зміни чекають", "змін чекають")}` : "без інтернету";
    return;
  }
  el.className = "status";
  const t = state.me?.lastCheck;
  el.textContent = state.me?.mode === "mock" ? "тестові дані" : t ? `ціни оновлено о ${new Date(t.replace(" ", "T") + "Z").toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}` : "";
}

function pickList() {
  openSheet(`
    <h2>Списки</h2>
    <div style="margin-top:12px">
      ${state.lists
        .map(
          (l) => `<button class="opt ${l.id === state.listId ? "on" : ""}" data-list="${l.id}"><span class="rad"></span><span class="t"><span class="nm">${esc(`${l.emoji ? `${l.emoji} ` : ""}${l.name}`)}</span></span><span class="sub">${goods(l.open ?? 0)}</span></button>`,
        )
        .join("")}
    </div>
    <form id="newlist" class="row" style="margin-top:14px"><input class="field" id="newlist-v" placeholder="Новий список" autocomplete="off"><button class="btn" type="submit">Створити</button></form>
    <div style="margin-top:14px;text-align:center"><a href="#/settings" class="small" style="font-weight:700">Перейменувати чи видалити списки</a></div>
  `);
  $("#newlist").onsubmit = async (e) => {
    e.preventDefault();
    const name = $("#newlist-v").value.trim();
    if (!name) return;
    try {
      const l = await api("/lists", { method: "POST", body: { name } });
      state.listId = l.id;
      ls.set("listId", l.id);
      state.items = [];
      closeSheet();
      location.hash = "#/";
      await renderList();
    } catch (err) {
      fail(err);
    }
  };
}

function pickStore() {
  const cur = homeStoreId();
  openSheet(`
    <h2>Ціни в магазині</h2>
    <p class="sub" style="margin:0 0 12px">У списку показуватимуться ціни цього магазину.</p>
    ${state.stores.map((s) => `<button class="opt ${s.id === cur ? "on" : ""}" data-home="${esc(s.id)}"><span class="rad"></span><span class="t nm">${esc(storeLabel(s))}</span></button>`).join("")}
  `);
}

/* ───────── Картка товару ───────── */
function openItem(id) {
  const i = state.items.find((x) => x.id === id);
  if (!i) return;
  const m = i.main;
  const hs = homeStore();
  const o = shownOffer(i);
  const a = o?.analysis;
  const img = m?.product.image_url;
  let badge = "";
  if (a?.verdict === "record") badge = `<span class="badge rec">Рекорд</span>`;
  else if (inPromo(o)) badge = `<span class="badge save">Акція</span>`;
  else if (a?.verdict === "fake") badge = `<span class="badge cau">«Акція» не справжня</span>`;
  else if (a?.verdict === "high") badge = `<span class="badge cau">Дорожче, ніж зазвичай</span>`;
  const facts = [];
  if (o) {
    const usual = a.typical ?? o.regularPrice;
    if (usual) facts.push(["Звичайна ціна", money(usual)]);
    if (a.min != null && a.daysOfHistory >= 7) facts.push([`Найнижча за ${plural(a.daysOfHistory, "день", "дні", "днів")}`, money(Math.min(a.min, o.price))]);
    if (o.promoUntil && inPromo(o)) facts.push(["Акція діє до", ddmm(o.promoUntil)]);
    if (a.nextPromoInDays != null && !inPromo(o) && state.me?.today) facts.push(["Наступна акція", `~${ddmm(addDays(state.me.today, a.nextPromoInDays))}`]);
  }
  const usual = o ? (a.typical ?? o.regularPrice) : null;
  const stockNote =
    o && (a.verdict === "record" || a.verdict === "great") && usual && usual > o.price
      ? `<div class="note save" id="stock-note">Варто запастися: 2 шт зараз — ${money(o.price * 2)}. За звичайною ціною було б ${money(usual * 2)}</div>`
      : "";
  const offers = (m?.offers ?? []).slice().sort((x, y) => Number(y.inStock) - Number(x.inStock) || x.price - y.price);
  const minPrice = offers.find((x) => x.inStock)?.price;
  const atb = i.atb;
  const ref = i.main && !i.query ? i.main.product.id : `q:${i.query}`;

  openSheet(
    `
    <div class="it-head">
      ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy">` : `<span class="thumb">фото</span>`}
      <div style="flex:1;min-width:0">
        <div class="it-title">${esc(m?.product.name ?? i.title)}</div>
        ${i.query ? `<div class="sub">Будь-який бренд: «${esc(i.query)}» — показую найвигідніший варіант</div>` : ""}
        ${m?.product.url ? `<a class="small" href="${esc(m.product.url)}" target="_blank" rel="noopener" style="font-weight:600;color:var(--muted)">Відкрити на silpo.ua</a>` : ""}
      </div>
    </div>
    ${
      o
        ? `<div class="price-card">
            <div class="row" style="align-items:flex-end">
              <div><div class="sub">Зараз ${o.storeId === hs?.id ? `на ${esc(storeLabel(hs))}` : `у ${esc(storeLabel(storeById(o.storeId)) || o.storeName)}`}</div><div class="price-big num">${money(o.price)}</div></div>
              ${badge}
            </div>
            ${facts.map(([k, v]) => `<div class="fact"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}
            ${a.verdict === "fake" ? `<div class="note cau" style="margin-top:12px">Позначено як акція, але це звичайна ціна для цього товару.</div>` : ""}
            <div id="chart"><div class="skel" style="margin:12px 0 0;height:120px"></div></div>
          </div>`
        : `<div class="note cau" style="margin-top:16px">Даних про ціну ще немає — вони з'являться найближчим часом.</div>`
    }
    <div class="panel"><span class="nm">Кількість</span><span class="stepper"><button data-qty="-1" aria-label="Менше">−</button><b class="num" id="qty">${i.quantity}</b><button data-qty="1" aria-label="Більше">+</button></span></div>
    <label class="panel"><span><span class="nm">Можна запастися</span><span class="g-sub">кава, хімія — купувати про запас на акції</span></span><span class="switch"><input type="checkbox" id="stockable" ${i.stockable ? "checked" : ""}><i></i></span></label>
    ${i.stockable ? stockNote : ""}
    ${
      offers.length
        ? `<span class="lbl">Ціни в магазинах</span><div class="receipt">
            ${offers
              .map(
                (x) => `<div class="r-row"><span style="flex:1;min-width:0"><span class="nm" style="font-weight:${x.price === minPrice && x.inStock ? 700 : 600}">${esc(storeLabel(storeById(x.storeId)) || x.storeName)}</span>${!x.inStock ? `<span class="g-sub">немає в наявності</span>` : x.price === minPrice && offers.length > 1 ? `<span class="g-sub">найдешевше</span>` : ""}</span><span class="pr" style="font-weight:${x.price === minPrice ? 700 : 500}">${fmt(x.price)}</span></div>`,
              )
              .join("")}
            ${atbRows(atb, ref)}
          </div>`
        : atb && (atb.same || atb.analog)
          ? `<span class="lbl">АТБ</span><div class="receipt">${atbRows(atb, ref)}</div>`
          : ""
    }
    ${
      i.alternatives.length
        ? `<span class="lbl">Дешевші схожі</span><div class="receipt">${i.alternatives
            .map(
              (x) => `<div class="r-row"><span style="flex:1;min-width:0"><span class="nm" style="font-weight:600">${esc(x.product.name)}</span><span class="g-sub">${esc(storeLabel(storeById(x.best.storeId)) || x.best.storeName)}${x.best.unit ? ` · ${money(x.best.unit.value)}/${esc(x.best.unit.unit)}` : ""}</span></span>
                <span style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><span class="pr">${fmt(x.best.price)}</span><button class="btn line small" data-swap="${esc(x.product.id)}">Замінити</button></span></div>`,
            )
            .join("")}</div>`
        : ""
    }
    <div class="sheet-foot"><button class="btn danger" data-del>Видалити</button><button class="btn" data-close>Готово</button></div>
  `,
  );
  const sheet = $("#sheet-content");
  sheet.onclick = async (e) => {
    const q = e.target.closest("[data-qty]");
    if (q) {
      i.quantity = Math.max(1, i.quantity + Number(q.dataset.qty));
      $("#qty").textContent = i.quantity;
      saveItemsCache();
      enqueue({ key: `qty:${i.id}`, method: "PATCH", path: `/items/${i.id}`, body: { quantity: i.quantity } });
      redraw();
    } else if (e.target.closest("[data-del]")) {
      closeSheet();
      removeWithUndo(i);
    } else if (e.target.closest("[data-swap]")) {
      const pid = e.target.closest("[data-swap]").dataset.swap;
      closeSheet();
      try {
        await api(`/items/${i.id}`, { method: "DELETE" });
        state.items = state.items.filter((x) => x.id !== i.id);
        await addToList({ productId: pid, quantity: i.quantity, stockable: i.stockable }, "Замінено");
      } catch (err) {
        fail(err);
      }
    } else if (e.target.closest("[data-atb-match]")) {
      const b = e.target.closest("[data-atb-match]");
      try {
        await api("/atb/match", { method: "POST", body: { ref: b.dataset.ref, atbId: b.dataset.atb, action: b.dataset.atbMatch } });
        toast(b.dataset.atbMatch === "confirm" ? "Запам'ятала: той самий товар" : "Добре, шукатиму інший");
        closeSheet();
        await loadItems();
        redraw();
      } catch (err) {
        fail(err);
      }
    }
  };
  $("#stockable").onchange = (e) => {
    i.stockable = e.target.checked;
    saveItemsCache();
    enqueue({ key: `stock:${i.id}`, method: "PATCH", path: `/items/${i.id}`, body: { stockable: i.stockable } });
    redraw();
    const n = $("#stock-note");
    if (n) n.hidden = !i.stockable;
    else if (i.stockable && stockNote) $("#stockable").closest(".panel").insertAdjacentHTML("afterend", stockNote);
  };
  if (o) loadChart(m.product.id, o.storeId, a.typical);
}

function atbRows(atb, ref) {
  if (!atb || (!atb.same && !atb.analog)) return "";
  let html = "";
  if (atb.same) {
    const ask =
      atb.same.status === "confirmed"
        ? ""
        : `<span class="row" style="justify-content:flex-start;margin-top:8px"><span class="sub">Це той самий товар?</span><button class="btn line small" data-atb-match="confirm" data-ref="${esc(ref)}" data-atb="${esc(atb.same.id)}">Так</button><button class="btn line small" data-atb-match="reject" data-ref="${esc(ref)}" data-atb="${esc(atb.same.id)}">Ні</button></span>`;
    html += `<div class="r-row"><span style="flex:1;min-width:0"><span style="display:flex;align-items:center;gap:6px"><span class="atb-mark">АТБ</span><a class="nm" style="font-weight:600;text-decoration:none" href="${esc(atb.same.url)}" target="_blank" rel="noopener">той самий товар</a></span>${atb.same.label ? `<span class="g-sub">${esc(atb.same.label)}</span>` : ""}${ask}</span><span class="pr">${fmt(atb.same.price)}</span></div>`;
  }
  if (atb.analog) {
    html += `<div class="r-row"><span style="flex:1;min-width:0"><span style="display:flex;align-items:center;gap:6px"><span class="atb-mark">АТБ</span><a class="nm" style="font-weight:600;text-decoration:none" href="${esc(atb.analog.url)}" target="_blank" rel="noopener">${esc(atb.analog.name)}</a></span><span class="g-sub">схожий${atb.analog.unit ? ` · ${money(atb.analog.unit.value)}/${esc(atb.analog.unit.unit)}` : ""}</span></span><span class="pr" style="font-weight:500">${fmt(atb.analog.price)}</span></div>`;
  }
  return html;
}

/** Видалення з можливістю скасувати: на сервер іде через 5 секунд. */
function removeWithUndo(i) {
  const idx = state.items.findIndex((x) => x.id === i.id);
  if (idx < 0) return;
  state.items.splice(idx, 1);
  saveItemsCache();
  redraw();
  const timer = setTimeout(() => enqueue({ method: "DELETE", path: `/items/${i.id}` }), 5000);
  toast(`Видалено: ${i.title}`, {
    label: "Скасувати",
    fn: () => {
      clearTimeout(timer);
      state.items.splice(Math.min(idx, state.items.length), 0, i);
      saveItemsCache();
      redraw();
    },
  });
}

/* Графік: смуга «звичайна ціна», лінія свого магазину, інші — тонко. */
async function loadChart(productId, storeId, typical) {
  const box = $("#chart");
  try {
    const { history } = await api(`/products/${encodeURIComponent(productId)}`);
    if (!$("#chart")) return;
    const series = history.filter((h) => h.points.length > 1);
    if (!series.length) {
      box.innerHTML = `<div class="sub" style="margin-top:12px">Графік ціни з'явиться за кілька днів спостережень.</div>`;
      return;
    }
    series.sort((x, y) => Number(x.store.id === storeId) - Number(y.store.id === storeId));
    const all = series.flatMap((s) => s.points);
    const days = [...new Set(all.map((p) => p.day))].sort();
    const prices = all.map((p) => p.price).concat(typical ? [typical] : []);
    const min = Math.min(...prices), max = Math.max(...prices);
    const Wd = 600, H = 130, top = 8, bot = 8;
    const x = (d) => (Wd * days.indexOf(d)) / Math.max(1, days.length - 1);
    const y = (v) => top + ((H - top - bot) * (max - v)) / Math.max(0.01, max - min);
    const band = typical ? `<rect x="0" y="${(y(typical) - 5).toFixed(1)}" width="${Wd}" height="10" fill="var(--soft)" stroke="none"/>` : "";
    const lines = series
      .map((s) => {
        const mine = s.store.id === storeId;
        return `<polyline fill="none" stroke="${mine ? "var(--ink)" : "var(--box)"}" stroke-width="${mine ? 3 : 1.6}" vector-effect="non-scaling-stroke" stroke-linejoin="round" points="${s.points.map((p) => `${x(p.day).toFixed(1)},${y(p.price).toFixed(1)}`).join(" ")}"/>`;
      })
      .join("");
    const mineS = series.find((s) => s.store.id === storeId) ?? series.at(-1);
    const last = mineS.points.at(-1);
    box.innerHTML = `
      ${typical ? `<div class="chart-l" style="margin-top:12px">смуга — звичайна ціна ${esc(money(typical))}</div>` : ""}
      <div style="position:relative;margin-top:6px">
        <svg class="chart" viewBox="0 0 ${Wd} ${H}" preserveAspectRatio="none" role="img" aria-label="Графік ціни за ${days.length} днів">${band}${lines}</svg>
        <i class="chart-dot" style="left:${((x(last.day) / Wd) * 100).toFixed(1)}%;top:${((y(last.price) / H) * 100).toFixed(1)}%"></i>
      </div>
      <div class="row chart-l"><span>${ddmm(days[0])}</span><span>сьогодні</span></div>`;
  } catch {
    if ($("#chart")) box.innerHTML = "";
  }
}

/* ───────── Додавання товару ───────── */
const addedNow = new Set();
function renderAdd() {
  document.body.classList.add("fullscreen");
  view.innerHTML = `
    <div class="search-row">
      <label class="search"><span class="sr">Додати товар</span>${ICON.search}<input id="q" type="search" placeholder="молоко, кава Lavazza…" autocomplete="off" enterkeyhint="done"></label>
      <a class="back" href="#/" style="padding:0 4px">Готово</a>
    </div>
    <div id="results"></div>
    <div id="sugg"></div>`;
  const q = $("#q");
  setTimeout(() => q.focus(), 60);
  q.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && q.value.trim().length >= 2) {
      e.preventDefault();
      addToList({ query: q.value.trim() }).then(() => clearSearch());
    }
  });
  loadSuggestions();
}
function clearSearch() {
  const q = $("#q");
  if (!q) return;
  q.value = "";
  $("#results").innerHTML = "";
  $("#sugg").hidden = false;
  q.focus();
}

let searchTimer;
async function doSearch(q) {
  const box = $("#results");
  if (!box) return;
  $("#sugg").hidden = q.trim().length >= 2;
  if (q.trim().length < 2) {
    box.innerHTML = "";
    return;
  }
  const seq = ++state.searchSeq;
  box.innerHTML = `<div class="receipt" style="margin-top:12px">${'<div class="skel"></div>'.repeat(3)}</div>`;
  try {
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    if (seq !== state.searchSeq) return;
    const qq = q.trim();
    // найвигідніший зараз — за ціною за кг/л (серед найпоширенішої одиниці), інакше за ціною
    const inStock = results.filter((r) => r.inStock);
    const unitOf = (r) => (r.packSize && r.packUnit ? r.packUnit : null);
    const counts = {};
    for (const r of inStock) if (unitOf(r)) counts[unitOf(r)] = (counts[unitOf(r)] ?? 0) + 1;
    const mainUnit = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
    const pool = mainUnit ? inStock.filter((r) => unitOf(r) === mainUnit) : inStock;
    const cheapest = pool.slice().sort((a, b) => (mainUnit ? a.price / a.packSize - b.price / b.packSize : a.price - b.price))[0];
    box.innerHTML = `
      <button class="generic" data-add-query="${esc(qq)}">
        <span class="t"><b>${esc(qq[0].toUpperCase() + qq.slice(1))} — будь-який бренд</b><span class="g-sub sub">Щодня підбиратиму найвигідніше.${cheapest ? ` Зараз це ${esc(cheapest.name)} — <span class="num">${esc(money(cheapest.price))}</span>` : ""}</span></span>
        <span class="plus" aria-hidden="true">${ICON.plus}</span>
      </button>
      ${
        results.length
          ? `<span class="lbl" style="display:block;margin:20px 0 8px">Або конкретний товар</span>
             <div class="receipt">${results
               .map(
                 (r) => `<button class="res" data-add-product="${esc(r.productId)}">
                  ${r.imageUrl ? `<img class="thumb sm" src="${esc(r.imageUrl)}" alt="" loading="lazy">` : `<span class="thumb sm">фото</span>`}
                  <span style="flex:1;min-width:0"><span class="nm">${esc(r.name)}</span><span class="g-sub"><span class="num" style="font-weight:700;color:var(--ink)">${money(r.price)}</span>${r.regularPrice ? ` <s class="num">${fmt(r.regularPrice)}</s>` : ""}${r.inStock ? "" : " · немає в наявності"}</span></span>
                  <span class="plus ${addedNow.has(r.productId) ? "added" : ""}" aria-label="Додати">${addedNow.has(r.productId) ? ICON.check : ICON.plus}</span>
                </button>`,
               )
               .join("")}</div>`
          : `<div class="empty">У Сільпо нічого не знайшлося — але можна додати «будь-який бренд».</div>`
      }`;
  } catch (e) {
    box.innerHTML = "";
    fail(e);
  }
}

async function loadSuggestions() {
  const box = $("#sugg");
  const cached = ls.get("sugg", null);
  const fresh = cached && Date.now() - cached.at < 24 * 3600_000;
  const draw = (list) => {
    if (!$("#sugg")) return;
    const inList = new Set(state.items.map((i) => i.main?.product.id));
    const items = list.filter((s) => !inList.has(s.productId) && !addedNow.has(s.productId)).slice(0, 10);
    box.innerHTML = items.length
      ? `<span class="lbl" style="display:block;margin:20px 0 8px">Ви часто купуєте</span><div class="chips">${items.map((s) => `<button class="chip" data-sugg="${esc(s.productId)}">+ ${esc(s.name)}</button>`).join("")}</div>`
      : "";
  };
  if (cached) draw(cached.list);
  if (fresh) return;
  try {
    const { suggestions } = await api("/suggestions");
    ls.set("sugg", { at: Date.now(), list: suggestions });
    draw(suggestions);
  } catch {
    /* немає підключення до Сільпо — просто без підказок */
  }
}

async function addToList(body, msg = "Додано") {
  try {
    const item = await api(`/lists/${state.listId}/items`, { method: "POST", body });
    const idx = state.items.findIndex((i) => i.id === item.id);
    if (idx >= 0) state.items[idx] = item;
    else state.items.unshift(item);
    saveItemsCache();
    if (body.productId) addedNow.add(body.productId);
    redraw();
    toast(`${msg}: ${item.title}`, {
      label: "Скасувати",
      fn: async () => {
        state.items = state.items.filter((x) => x.id !== item.id);
        if (body.productId) addedNow.delete(body.productId);
        saveItemsCache();
        redraw();
        enqueue({ method: "DELETE", path: `/items/${item.id}` });
        const b = $(`[data-add-product="${CSS.escape(body.productId ?? "")}"] .plus`);
        if (b) {
          b.classList.remove("added");
          b.innerHTML = ICON.plus;
        }
      },
    });
    // Ціна АТБ збирається на сервері у фоні — підтягуємо її за кілька секунд.
    if (!item.atb) setTimeout(() => refreshSilently(), 7000);
    return item;
  } catch (e) {
    fail(e);
  }
}
async function refreshSilently() {
  try {
    const { items } = await api(`/lists/${state.listId}/items`);
    state.items = applyQueue(items);
    saveItemsCache();
    if ($("#sheet").hidden && route.current !== "add") redraw();
  } catch {
    /* не критично */
  }
}

/* ───────── Асистент ───────── */
const SECTIONS = [
  { id: "now", title: "Варто купити зараз", sub: (xs) => (xs.some((x) => x.o.analysis.verdict === "record") ? "рекордні ціни у вашому списку" : "ціни нижчі, ніж зазвичай") },
  { id: "swap", title: "Дешевша заміна", sub: (xs) => { const s = xs.reduce((a, x) => a + Math.max(0, (x.o.price - x.alt.best.price) * x.i.quantity), 0); return s >= 1 ? `разом мінус ${money(s)}` : "дешевше за кілограм чи літр"; } },
  { id: "wait", title: "Краще почекати", sub: (xs) => `найближча акція ~${ddmm(xs.map((x) => x.day).sort()[0])}` },
  { id: "fake", title: "Не ведіться", sub: () => "«акції» зі звичайною ціною" },
];
function assistantData() {
  const open = state.items.filter((i) => !i.checked);
  const out = { now: [], swap: [], wait: [], fake: [] };
  for (const i of open) {
    const o = shownOffer(i);
    if (!o) continue;
    const a = o.analysis;
    if (a.verdict === "record" || a.verdict === "great") out.now.push({ i, o });
    if (a.verdict === "fake") out.fake.push({ i, o });
    if (a.nextPromoInDays != null && a.nextPromoInDays <= 4 && !inPromo(o) && state.me?.today) out.wait.push({ i, o, day: addDays(state.me.today, a.nextPromoInDays) });
    const alt = i.alternatives?.[0];
    if (alt?.best) out.swap.push({ i, o, alt });
  }
  return out;
}
function paintAssistantDot() {
  const d = $("#asst-dot");
  if (!d || !state.items.length) return;
  const data = assistantData();
  const plan = computePlan();
  d.hidden = !(data.now.length || (plan.best && optSaving(plan.best) >= 1));
}

async function renderAssistant() {
  if (!state.items.length) state.items = ls.get(`items:${state.listId}`, []);
  drawAssistant();
  await loadItems();
  if (route.current === "assistant") drawAssistant();
}

function drawAssistant() {
  const list = state.lists.find((l) => l.id === state.listId);
  const plan = computePlan();
  const data = assistantData();
  const openState = ls.get("asstOpen", { now: true });
  const best = plan.best;
  const others = plan.options.filter((o) => o !== best).slice(0, 3);
  const hero = best
    ? `<div class="hero">
        <div class="lbl">Де купити цей список</div>
        <div class="hero-title">${esc(optTitle(best))}</div>
        <div class="hero-line"><span class="saving">${optSaving(best) >= 1 ? `Заощадите ${money(optSaving(best))}` : "Найвигідніше для цього списку"}</span><span class="num">${money(best.rank)}</span></div>
        ${best.missing ? `<div class="sub">Там немає ${plural(best.missing, "товару", "товарів", "товарів")} — враховано за ціною іншого магазину</div>` : ""}
        ${best.kind === "split" ? `<a class="btn block" style="margin-top:12px" href="#/plan/${encodeURIComponent(best.store.id)}">Подивитися план</a>` : `<button class="btn block" style="margin-top:12px" data-start="${esc(best.key)}">${ICON.cart}Іду в магазин</button>`}
        ${others.length ? `<div style="margin-top:12px">${others.map((o) => `<div class="alt-opt"><span>${o.kind === "split" ? `<a href="#/plan/${encodeURIComponent(o.store.id)}">${esc(optTitle(o))}</a>` : esc(optTitle(o))}${o.missing ? ` <span class="sub">· немає ${o.missing}</span>` : ""}</span><span class="num">${money(o.rank)}</span></div>`).join("")}</div>` : ""}
      </div>`
    : `<div class="empty"><b>Поки нічого порівнювати</b>Додайте товари в список і виберіть магазини в налаштуваннях.</div>`;
  const secs = SECTIONS.filter((s) => data[s.id].length)
    .map((s) => {
      const xs = data[s.id];
      const opened = !!openState[s.id];
      return `<div class="sec">
        <button class="sec-h" data-sec="${s.id}" aria-expanded="${opened}"><span class="cnt">${xs.length}</span><span class="sec-t">${esc(s.title)}<small>${esc(s.sub(xs))}</small></span>${ICON.down}</button>
        ${opened ? `<div class="sec-b">${xs.map((x) => secRow(s.id, x)).join("")}</div>` : ""}
      </div>`;
    })
    .join("");
  view.innerHTML = `
    <div class="topbar"><span class="h1">Асистент</span><span id="status" class="status"></span></div>
    <div class="sub">Поради за списком «${esc(list?.name ?? "")}»</div>
    ${hero}
    ${secs || (best ? `<div class="empty" style="padding-top:24px">Інших порад зараз немає — ціни у вашому списку звичайні.</div>` : "")}
  `;
  paintStatus();
}

function secRow(sec, { i, o, alt, day }) {
  const name = esc(i.main?.product.name ?? i.title);
  if (sec === "now") {
    const extra = [o.analysis.verdict === "record" && o.analysis.daysOfHistory >= 7 ? `найнижча ціна за ${plural(o.analysis.daysOfHistory, "день", "дні", "днів")}` : "", o.promoUntil ? `до ${ddmm(o.promoUntil)}` : "", i.stockable ? "можна взяти про запас" : ""].filter(Boolean).join(", ");
    return `<div class="r-row"><button class="r-main" data-open="${i.id}"><span class="nm">${name}</span>${extra ? `<span class="g-sub">${esc(extra[0].toUpperCase() + extra.slice(1))}</span>` : ""}</button><span class="pr" style="color:${o.analysis.verdict === "record" ? "var(--rec)" : "var(--save)"}">${fmt(o.price)}${was(o) ? `<span class="was">${fmt(was(o))}</span>` : ""}</span></div>`;
  }
  if (sec === "swap") {
    const per = alt.best.unit && o.unit && alt.best.unit.unit === o.unit.unit ? ` · ${money(alt.best.unit.value)}/${alt.best.unit.unit} замість ${money(o.unit.value)}` : "";
    return `<div class="r-row"><span style="flex:1;min-width:0"><span class="nm">${esc(alt.product.name)}</span><span class="g-sub">замість «${esc(i.title)}» (${fmt(o.price)})${esc(per)}</span></span><span style="display:flex;flex-direction:column;align-items:flex-end;gap:6px"><span class="pr">${fmt(alt.best.price)}</span><button class="btn line small" data-swap-item="${i.id}" data-swap-to="${esc(alt.product.id)}">Замінити</button></span></div>`;
  }
  if (sec === "wait") {
    const cyc = o.analysis.promoCycleDays;
    return `<div class="r-row"><button class="r-main" data-open="${i.id}"><span class="nm">${name}</span><span class="g-sub">Наступна акція ~${ddmm(day)}${cyc ? `, буває кожні ~${cyc} дн.` : ""}</span></button><span class="pr">${fmt(o.price)}</span></div>`;
  }
  return `<div class="r-row"><button class="r-main" data-open="${i.id}"><span class="nm">${name}</span><span class="g-sub">Позначено як акція, але ${money(o.price)} — звичайна ціна</span></button><span class="pr">${fmt(o.price)}</span></div>`;
}

/* ───────── Розділений кошик ───────── */
async function renderPlan(storeId) {
  document.body.classList.add("fullscreen");
  if (!state.items.length) state.items = ls.get(`items:${state.listId}`, []);
  drawPlan(storeId);
  await loadItems();
  if (route.current === "plan") drawPlan(storeId);
}
function drawPlan(storeId) {
  const plan = computePlan();
  const opt = plan.options.find((o) => o.key === `split:${storeId}`) ?? plan.options.find((o) => o.kind === "split");
  if (!opt) {
    view.innerHTML = `<a class="back" href="#/assistant">${ICON.back}Асистент</a><div class="empty"><b>В АТБ зараз нічого не дешевше</b>Купуйте все в Сільпо — так вигідніше.</div>`;
    return;
  }
  const single = plan.options.find((o) => o.key === `one:${opt.store.id}`);
  const line = (x, atb) => `<div class="r-row"><span style="flex:1;min-width:0"><span class="nm" style="font-weight:600">${esc(x.i.title)}${x.i.quantity !== 1 ? ` <span class="qty">×${x.i.quantity}</span>` : ""}</span>${atb && x.silpo != null ? `<span class="was num">у Сільпо ${fmt(x.silpo * x.i.quantity)}</span>` : atb ? `<span class="g-sub">у Сільпо немає</span>` : ""}</span><span class="pr">${fmt(x.price * x.i.quantity)}</span></div>`;
  const showAll = state.planAll;
  view.innerHTML = `
    <a class="back" href="#/assistant">${ICON.back}Асистент</a>
    <div class="plan-h">Купіть у двох магазинах — заощадите ${money(opt.saving)}</div>
    <div class="sub">Порівняно з покупкою всього списку на ${esc(storeLabel(opt.store))}</div>
    <div class="plan-card">
      <div class="row"><span style="display:flex;align-items:center;gap:8px"><span class="atb-mark">АТБ</span><span class="nm">${goods(opt.atb.length)}</span></span><span class="sub">тут дешевше</span></div>
      <div style="margin-top:8px">${opt.atb.map((x) => line(x, true)).join("")}</div>
      <div class="r-total"><span class="lbl">За АТБ</span><span class="num">${money(opt.atbTotal)}</span></div>
    </div>
    <div class="plan-card">
      <div class="row"><span style="display:flex;align-items:center;gap:8px"><span class="silpo-mark">СІЛЬПО</span><span class="nm">${goods(opt.silpo.length)}</span></span><span class="sub">${esc(storeLabel(opt.store))}</span></div>
      <div style="margin-top:8px">${(showAll ? opt.silpo : opt.silpo.slice(0, 4)).map((x) => line(x, false)).join("")}
        ${!showAll && opt.silpo.length > 4 ? `<button class="r-more" style="padding:0" data-plan-all>Ще ${goods(opt.silpo.length - 4)}${ICON.down}</button>` : ""}</div>
      <div class="r-total"><span class="lbl">За Сільпо</span><span class="num">${money(opt.silpoTotal)}</span></div>
    </div>
    ${opt.missing ? `<div class="note cau">${plural(opt.missing, "товару", "товарів", "товарів")} немає ні тут, ні в АТБ.</div>` : ""}
    <div class="grand"><span class="lbl" style="color:var(--ink);font-size:14px">Разом</span><span class="num">${money(opt.total)}</span></div>
    <div class="row" style="font-weight:800;color:var(--save);font-size:14px;margin-top:4px"><span>Ви заощадите</span><span class="num">${money(opt.saving)}</span></div>
    <div class="stack" style="margin-top:22px">
      <button class="btn block big" data-start="${esc(opt.key)}">Іду за цим планом</button>
      ${single ? `<button class="btn line block" data-start="${esc(single.key)}">Куплю все в Сільпо</button>` : ""}
      <div class="sub" style="text-align:center">Товари, яких в АТБ немає, лишаються в Сільпо</div>
    </div>`;
}

/* ───────── «Іду в магазин» і режим покупок ───────── */
function openGoShop() {
  const plan = computePlan();
  if (!plan.options.length) {
    startShop(null);
    return;
  }
  let sel = plan.best.key;
  const draw = () =>
    plan.options
      .map(
        (o) => `<button class="opt ${o.key === sel ? "on" : ""}" data-opt="${esc(o.key)}"><span class="rad"></span><span class="t"><span class="nm">${esc(o.kind === "split" ? `${storeLabel(o.store)}, потім АТБ` : isDelivery(o.store) ? "Замовляю доставку" : `Тільки ${storeLabel(o.store)}`)}</span>${o === plan.best && plan.options.length > 1 ? `<span class="best">Найвигідніше${optSaving(o) >= 1 ? ` · заощадите ${money(optSaving(o))}` : ""}</span>` : ""}${isDelivery(o.store) ? `<span class="g-sub">відмічайте, що вже додали в кошик Сільпо</span>` : ""}${o.missing ? `<span class="g-sub">немає ${plural(o.missing, "товару", "товарів", "товарів")} — враховано за ціною іншого магазину</span>` : ""}</span><span class="pr">${fmt(o.rank)}</span></button>`,
      )
      .join("");
  openSheet(`
    <h2>Куди йдете?</h2>
    <p class="sub" style="margin:0 0 14px">Список розкладеться по відділах магазину</p>
    <div id="opts">${draw()}</div>
    <button class="btn block big" style="margin-top:18px" id="go">Почати покупки</button>
    <div class="sub" style="text-align:center;margin-top:10px">Список працюватиме і без інтернету</div>`);
  $("#sheet-content").onclick = (e) => {
    const b = e.target.closest("[data-opt]");
    if (b) {
      sel = b.dataset.opt;
      $("#opts").innerHTML = draw();
    }
    if (e.target.closest("#go")) {
      closeSheet();
      startShop(sel);
    }
  };
}

function startShop(key) {
  const plan = computePlan();
  const opt = plan.options.find((o) => o.key === key);
  const open = state.items.filter((i) => !i.checked);
  const priceIn = (i, sid) => offerAt(i, sid)?.price ?? shownOffer(i)?.price ?? null;
  let stages;
  if (opt?.kind === "split") {
    const atbIds = new Set(opt.atb.map((x) => x.i.id));
    stages = [
      { title: `Сільпо, ${storeLabel(opt.store)}`, kind: "silpo", items: open.filter((i) => !atbIds.has(i.id)).map((i) => ({ id: i.id, price: priceIn(i, opt.store.id), away: !offerAt(i, opt.store.id) })) },
      { title: "АТБ", kind: "atb", items: opt.atb.map((x) => ({ id: x.i.id, price: x.price })) },
    ];
  } else if (opt) {
    stages = [{ title: isDelivery(opt.store) ? "Доставка Сільпо" : `Сільпо, ${storeLabel(opt.store)}`, kind: isDelivery(opt.store) ? "delivery" : "silpo", items: open.map((i) => ({ id: i.id, price: priceIn(i, opt.store.id), away: !offerAt(i, opt.store.id) })) }];
  } else {
    stages = [{ title: "Покупки", kind: "silpo", items: open.map((i) => ({ id: i.id, price: shownOffer(i)?.price ?? null })) }];
  }
  state.shop = { listId: state.listId, stages, stage: 0 };
  ls.set("shop", state.shop);
  location.hash = "#/shop";
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    /* браузер не підтримує — не критично */
  }
}
document.addEventListener("visibilitychange", () => route.current === "shop" && document.visibilityState === "visible" && keepAwake(true));

async function renderShop() {
  document.body.classList.add("shopping");
  if (!state.shop) {
    location.hash = "#/";
    return;
  }
  if (state.shop.listId !== state.listId) state.listId = state.shop.listId;
  if (!state.items.length) state.items = ls.get(`items:${state.listId}`, []);
  keepAwake(true);
  drawShop();
  loadItems().then(() => route.current === "shop" && drawShop()).catch(() => {});
}

function drawShop() {
  const sh = state.shop;
  const st = sh.stages[sh.stage];
  const rows = st.items.map((x) => ({ ...x, i: state.items.find((i) => i.id === x.id) })).filter((x) => x.i);
  const todo = rows.filter((x) => !x.i.checked);
  const done = rows.filter((x) => x.i.checked);
  const sumDone = done.reduce((a, x) => a + (x.price ?? 0) * x.i.quantity, 0);
  const groups = new Map();
  for (const x of todo) {
    const d = deptOf(x.i);
    if (!groups.has(d.k)) groups.set(d.k, { name: d.name, rows: [] });
    groups.get(d.k).rows.push(x);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g);
  const next = sh.stages[sh.stage + 1];
  const nextSum = next ? next.items.reduce((a, x) => a + (x.price ?? 0) * (state.items.find((i) => i.id === x.id)?.quantity ?? 1), 0) : 0;
  const prev = sh.stages[sh.stage - 1];
  const row = (x) => `<button class="s-row ${x.i.checked ? "done" : ""}" data-check="${x.i.id}">
      <span class="cb ${x.i.checked ? "on" : ""}">${x.i.checked ? ICON.check : ""}</span>
      <span class="nm">${esc(x.i.title)}${x.i.quantity !== 1 ? ` <span class="qty">×${x.i.quantity}</span>` : ""}${x.i.query && x.i.main && st.kind !== "atb" ? `<span class="g-sub">${esc(x.i.main.product.name)}</span>` : ""}${x.away && !x.i.checked ? `<span class="g-sub">тут, можливо, немає в наявності</span>` : ""}</span>
      <span class="pr">${x.price != null ? fmt(x.price * x.i.quantity) : "—"}</span>
    </button>`;
  view.innerHTML = `
    <div class="shop-head">
      <div class="row"><button class="link" data-endshop>Завершити</button><span class="small" style="opacity:.75">${navigator.onLine ? "працює без інтернету" : "без інтернету — зміни збережуться"}</span></div>
      <h1>${esc(st.title)}</h1>
      <div class="row small" style="margin-top:4px;font-size:14px"><span>${done.length} з ${rows.length} у кошику</span><span class="num">${money(sumDone)}</span></div>
      <div class="bar"><i style="width:${rows.length ? Math.round((done.length / rows.length) * 100) : 0}%"></i></div>
    </div>
    ${st.kind === "delivery" ? `<div class="note cau">Відмічайте товари, які вже додали в кошик на silpo.ua — застосунок кошик не змінює.</div>` : ""}
    ${prev ? `<button class="back" data-stage="-1" style="margin-top:6px">${ICON.back}${esc(prev.title)}</button>` : ""}
    ${ordered.map((g) => `<div class="dept lbl">${esc(g.name)}</div><div class="s-list">${g.rows.map(row).join("")}</div>`).join("")}
    ${!todo.length ? `<div class="empty"><b>${next ? "Тут усе куплено" : "Усе куплено"}</b>${next ? `Далі — ${esc(next.title)}.` : "Гарних покупок!"}</div>` : ""}
    ${
      done.length
        ? state.showDone
          ? `<div class="dept lbl">У кошику · ${done.length}</div><div class="s-list">${done.map(row).join("")}</div>`
          : `<button class="r-more" style="margin-top:14px;border:1px solid var(--line);border-radius:var(--radius);background:var(--card)" data-showdone>У кошику · ${done.length}${ICON.down}</button>`
        : ""
    }
    ${
      next
        ? `<button class="next-stage" data-stage="1"><span><span style="display:flex;align-items:center;gap:6px">${next.kind === "atb" ? `<span class="atb-mark">АТБ</span>` : ""}<b>Далі — ${goods(next.items.length)}</b></span><span class="g-sub">${esc(next.items.map((x) => state.items.find((i) => i.id === x.id)?.title).filter(Boolean).slice(0, 4).join(", "))}</span></span><span class="num" style="font-weight:700">${money(nextSum)}</span></button>`
        : !todo.length
          ? `<button class="btn block big" style="margin-top:16px" data-endshop>Завершити покупки</button>`
          : ""
    }
    <div class="sub" style="text-align:center;padding:16px 0 20px">Тап по рядку — у кошику. Екран не гасне.</div>`;
}

/* ───────── Налаштування ───────── */
async function renderSettings() {
  view.innerHTML = `<div class="topbar"><span class="h1">Налаштування</span></div><div class="set-card">${'<div class="skel"></div>'.repeat(3)}</div>`;
  const [{ stores }, { lists, defaultListId }] = await Promise.all([api("/stores"), api("/lists")]);
  state.stores = stores;
  state.lists = lists;
  ls.set("stores", stores);
  const me = state.me;
  const silpo = me.mode === "mcp" ? await api("/silpo/status").catch(() => null) : null;
  view.innerHTML = `
    <div class="topbar"><span class="h1">Налаштування</span></div>

    <span class="lbl" style="display:block;margin:14px 0 8px">Мої магазини</span>
    <div class="set-card">
      ${stores.map((s) => `<div class="set-row"><span class="nm" style="font-weight:600">${esc(storeLabel(s))}</span><span><button class="icon-btn danger" data-rmstore="${esc(s.id)}" aria-label="Прибрати ${esc(storeLabel(s))}">${ICON.trash}</button></span></div>`).join("") || `<div class="sub">Магазинів ще немає.</div>`}
      <input class="field" id="storeq" style="margin-top:10px" placeholder="Додати магазин: вулиця чи місто">
      <div id="storeres"></div>
    </div>

    <span class="lbl" style="display:block;margin:22px 0 8px">Списки</span>
    <div class="set-card">
      ${lists
        .map(
          (l) => `<div class="set-row"><span><span class="nm" style="font-weight:600">${esc(`${l.emoji ? `${l.emoji} ` : ""}${l.name}`)}</span>${l.id === defaultListId ? `<span class="g-sub">сюди додає Telegram-бот</span>` : `<button class="linkish small" style="font-weight:600;color:var(--muted)" data-deflist="${l.id}">зробити списком для бота</button>`}</span>
            <span><button class="icon-btn" data-renlist="${l.id}" aria-label="Перейменувати">${ICON.edit}</button><button class="icon-btn danger" data-dellist="${l.id}" aria-label="Видалити">${ICON.trash}</button></span></div>`,
        )
        .join("")}
      <button class="btn line block" style="margin-top:10px" data-newlist>${ICON.plus}Новий список</button>
    </div>

    ${
      silpo
        ? `<span class="lbl" style="display:block;margin:22px 0 8px">Акаунт Сільпо</span>
      <div class="set-card stack">
        ${
          silpo.connected
            ? `<div class="ok-line">Підключено</div><div class="sub">Застосунок лише читає ціни й історію покупок — кошик і замовлення не змінює.</div>`
            : `<div class="sub">Увійдіть у свій акаунт Сільпо, щоб бачити ціни ваших магазинів. Застосунок лише читає дані.</div><button class="btn block" data-silpo-connect>Підключити Сільпо</button>`
        }
        ${silpo.error ? `<div class="note cau">${esc(silpo.error)}</div>` : ""}
      </div>`
        : ""
    }

    <span class="lbl" style="display:block;margin:22px 0 8px">Telegram</span>
    <div class="set-card stack">
      ${
        !me.telegramConfigured
          ? `<div class="sub">Бот ще не налаштований.</div>`
          : me.telegramLinked
            ? `<div class="ok-line">Ранкові поради щодня о 8:00</div><button class="btn line block" data-tgtest>Надіслати зараз</button>`
            : `<div class="sub">Отримуйте ранкові поради й додавайте товари з Telegram.</div><button class="btn block" data-tglink>Підключити Telegram</button>`
      }
      <div id="tglink"></div>
    </div>

    <details class="tech">
      <summary>Технічне ${ICON.down}</summary>
      <div class="tech-body stack">
        <div class="row"><span>Джерело даних</span><b>${me.mode === "mock" ? "тестові дані" : "MCP Сільпо"}</b></div>
        <div class="row"><span>Остання перевірка цін</span><span class="num">${esc(me.lastCheck ? new Date(me.lastCheck.replace(" ", "T") + "Z").toLocaleString("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "ще не було")}</span></div>
        <button class="btn line block" data-collect>Оновити ціни зараз</button>
        ${silpo?.connected ? `<div class="row"><button class="btn line small" data-silpo-connect>Підключити Сільпо заново</button><button class="btn danger small" data-silpo-disconnect>Відключити</button></div>` : ""}
        <b style="display:block;margin-top:14px">Telegram</b>
        ${me.telegramConfigured ? `<div id="tgstatus" class="sub">Перевіряю…</div><div class="row"><button class="btn line small" data-tgwebhook>Зареєструвати вебхук</button>${me.telegramLinked ? `<button class="btn line small" data-tglink>Інший чат</button>` : ""}</div>` : `<div class="sub">Не налаштований на сервері.</div>`}
        <b style="display:block;margin-top:14px">АТБ</b>
        <div id="atb"><span class="sub">Завантаження…</span></div>
        ${me.mode === "mock" ? `<button class="btn line block" data-seed>Заповнити демо-даними</button>` : ""}
      </div>
    </details>
  `;
  $("details.tech").addEventListener("toggle", (e) => {
    if (!e.target.open) return;
    if (me.telegramConfigured) loadTgStatus();
    loadAtb();
  });
  const chosen = new Set(stores.map((s) => s.id));
  const searchStores = async (q) => {
    try {
      const { stores: found } = await api(`/stores/search?q=${encodeURIComponent(q)}`);
      const list = found.filter((s) => !chosen.has(s.id));
      $("#storeres").innerHTML = list.length
        ? (!q ? `<div class="sub" style="margin:10px 0 4px">Поруч і доставка за вашою адресою:</div>` : "") +
          `<div class="receipt" style="margin-top:8px">${list.map((s) => `<button class="res" data-addstore='${esc(JSON.stringify(s))}'><span class="nm" style="flex:1;font-weight:600">${esc(storeLabel(s))}</span><span class="plus">${ICON.plus}</span></button>`).join("")}</div>`
        : q
          ? `<div class="sub" style="margin-top:8px">Нічого не знайдено</div>`
          : "";
    } catch (err) {
      $("#storeres").innerHTML = `<div class="sub" style="margin-top:8px">${esc(err.message)}</div>`;
    }
  };
  if (me.mode === "mcp" && silpo?.connected && stores.length < 4) searchStores("");
  let t;
  $("#storeq").oninput = (e) => {
    clearTimeout(t);
    t = setTimeout(() => searchStores(e.target.value.trim()), 350);
  };
}

async function loadAtb() {
  const box = $("#atb");
  if (!box) return;
  try {
    const s = await api("/atb/status");
    const m = s.server;
    const mode = !m
      ? `<div class="sub">Спосіб збору ще не визначено.</div>`
      : m.method === "none"
        ? `<div class="warn-line">АТБ зараз не пускає сервер${m.detail ? ` (${esc(m.detail)})` : ""}. Перевірю знову автоматично.</div>`
        : `<div class="ok-line">Ціни АТБ збираються автоматично (${m.method === "fetch" ? "звичайний запит" : "браузер Cloudflare"})</div>`;
    const r = s.run;
    const last = r?.verdict === "ok" ? `<div class="sub">Товарів у списках: ${s.tracked} · сьогодні ще без цін АТБ: ${s.pending}</div>` : "";
    box.innerHTML = `${mode}${last}
      <div class="row" style="justify-content:flex-start;margin-top:8px"><button class="btn line small" data-atb-refresh>Оновити ціни АТБ</button><button class="btn line small" data-atb-server>Перевірити доступ</button></div>
      <div id="atb-server" class="stack" style="margin-top:8px"></div>`;
  } catch (e) {
    box.innerHTML = `<span class="sub">${esc(e.message)}</span>`;
  }
}

async function loadTgStatus() {
  const box = $("#tgstatus");
  if (!box) return;
  try {
    const s = await api("/telegram/status");
    const lines = [`Бот: @${esc(s.bot)}`];
    if (!s.secret) lines.push("Немає секрету TELEGRAM_WEBHOOK_SECRET");
    if (!s.webhookUrl) lines.push("Вебхук не зареєстрований");
    else if (s.webhookUrl !== s.expectedUrl) lines.push(`Вебхук вказує на іншу адресу: ${esc(s.webhookUrl)}`);
    else lines.push("Вебхук зареєстрований");
    if (s.pending) lines.push(`Повідомлень у черзі: ${s.pending}`);
    if (s.lastError) lines.push(`Остання помилка: ${esc(s.lastError)}`);
    box.innerHTML = lines.join("<br>");
  } catch (e) {
    box.textContent = `Не вдалося перевірити бота: ${e.message}`;
  }
}

/* ───────── Делегування подій ───────── */
document.addEventListener("click", async (e) => {
  const el = (s) => e.target.closest(s);
  try {
    if (el("[data-check]")) toggleCheck(Number(el("[data-check]").dataset.check));
    else if (el("[data-open]")) openItem(Number(el("[data-open]").dataset.open));
    else if (el("[data-go]")) location.hash = el("[data-go]").dataset.go;
    else if (el("[data-pick-list]")) pickList();
    else if (el("[data-pick-store]")) pickStore();
    else if (el("[data-home]")) {
      ls.set("homeStore", el("[data-home]").dataset.home);
      closeSheet();
      redraw();
    } else if (el("[data-list]")) {
      state.listId = Number(el("[data-list]").dataset.list);
      ls.set("listId", state.listId);
      state.items = ls.get(`items:${state.listId}`, []);
      closeSheet();
      if (route.current === "assistant") await renderAssistant();
      else {
        location.hash = "#/";
        await renderList();
      }
    } else if (el("[data-goshop]")) openGoShop();
    else if (el("[data-start]")) startShop(el("[data-start]").dataset.start);
    else if (el("[data-stage]")) {
      state.shop.stage = Math.max(0, Math.min(state.shop.stages.length - 1, state.shop.stage + Number(el("[data-stage]").dataset.stage)));
      state.showDone = false;
      ls.set("shop", state.shop);
      drawShop();
      scrollTo(0, 0);
    } else if (el("[data-showdone]")) {
      state.showDone = true;
      drawShop();
    } else if (el("[data-endshop]")) {
      state.shop = null;
      ls.set("shop", null);
      keepAwake(false);
      location.hash = "#/";
    } else if (el("[data-plan-all]")) {
      state.planAll = true;
      drawPlan(decodeURIComponent((location.hash.split("/")[2] ?? "")));
    } else if (el("[data-sec]")) {
      const id = el("[data-sec]").dataset.sec;
      const o = ls.get("asstOpen", { now: true });
      o[id] = !o[id];
      ls.set("asstOpen", o);
      drawAssistant();
    } else if (el("[data-swap-item]")) {
      const b = el("[data-swap-item]");
      const it = state.items.find((x) => x.id === Number(b.dataset.swapItem));
      b.disabled = true;
      await api(`/items/${it.id}`, { method: "DELETE" });
      state.items = state.items.filter((x) => x.id !== it.id);
      await addToList({ productId: b.dataset.swapTo, quantity: it.quantity, stockable: it.stockable }, "Замінено");
    } else if (el("[data-clear]")) {
      const done = state.items.filter((i) => i.checked);
      state.items = state.items.filter((i) => !i.checked);
      saveItemsCache();
      drawList();
      const timer = setTimeout(() => enqueue({ method: "POST", path: `/lists/${state.listId}/clear-checked` }), 5000);
      toast(`Прибрано: ${goods(done.length)}`, {
        label: "Скасувати",
        fn: () => {
          clearTimeout(timer);
          state.items.push(...done);
          saveItemsCache();
          drawList();
        },
      });
    } else if (el("[data-add-product]")) {
      const b = el("[data-add-product]");
      const pid = b.dataset.addProduct;
      if (addedNow.has(pid)) return;
      const plus = b.querySelector(".plus");
      plus.classList.add("added");
      plus.innerHTML = ICON.check;
      const item = await addToList({ productId: pid });
      if (!item) {
        plus.classList.remove("added");
        plus.innerHTML = ICON.plus;
      }
    } else if (el("[data-add-query]")) {
      await addToList({ query: el("[data-add-query]").dataset.addQuery });
      clearSearch();
    } else if (el("[data-sugg]")) {
      const b = el("[data-sugg]");
      b.disabled = true;
      const r = await api("/suggestions/accept", { method: "POST", body: { listId: state.listId, productIds: [b.dataset.sugg] } });
      addedNow.add(b.dataset.sugg);
      b.remove();
      toast(r.added ? `Додано: ${b.textContent.replace(/^\+\s*/, "")}` : "Не вдалося додати");
      refreshSilently();
    } else if (el("[data-addstore]")) {
      const s = JSON.parse(el("[data-addstore]").dataset.addstore);
      await api("/stores", { method: "POST", body: s });
      await refreshMe();
      await renderSettings();
      toast("Магазин додано — ціни почнуть збиратися");
    } else if (el("[data-rmstore]")) {
      const id = el("[data-rmstore]").dataset.rmstore;
      if (!(await askConfirm("Прибрати магазин?", `${storeLabel(storeById(id))} — ціни в ньому більше не збиратимуться.`, "Прибрати"))) return;
      await api(`/stores/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refreshMe();
      await renderSettings();
    } else if (el("[data-newlist]")) {
      const name = await askText("Новий список", "", "Створити");
      if (!name) return;
      const l = await api("/lists", { method: "POST", body: { name } });
      state.listId = l.id;
      ls.set("listId", l.id);
      state.items = [];
      location.hash = "#/";
    } else if (el("[data-deflist]")) {
      await api(`/lists/${el("[data-deflist]").dataset.deflist}`, { method: "PATCH", body: { makeDefault: true } });
      await renderSettings();
    } else if (el("[data-renlist]")) {
      const id = el("[data-renlist]").dataset.renlist;
      const name = await askText("Нова назва", state.lists.find((l) => l.id == id)?.name ?? "");
      if (!name) return;
      await api(`/lists/${id}`, { method: "PATCH", body: { name } });
      await renderSettings();
    } else if (el("[data-dellist]")) {
      const id = el("[data-dellist]").dataset.dellist;
      const l = state.lists.find((x) => x.id == id);
      if (!(await askConfirm("Видалити список?", `«${l?.name ?? ""}» зникне разом з усіма товарами.`, "Видалити"))) return;
      await api(`/lists/${id}`, { method: "DELETE" });
      await renderSettings();
    } else if (el("[data-tglink]")) {
      const r = await api("/telegram/link", { method: "POST" });
      $("#tglink").innerHTML = `<a class="btn block" href="${esc(r.link)}" target="_blank" rel="noopener">Відкрити бота в Telegram</a><div class="sub" style="margin-top:6px">Натисніть «Start» у боті. Посилання діє 1 годину.</div>`;
    } else if (el("[data-atb-refresh]")) {
      const b = el("[data-atb-refresh]");
      b.disabled = true;
      b.textContent = "Оновлюю…";
      const r = await api("/atb/refresh", { method: "POST" });
      toast(r.method === "none" ? "АТБ зараз не пускає сервер" : r.processed ? `Оновлено ${goods(r.processed)} АТБ` : "Усі ціни АТБ на сьогодні вже свіжі");
      loadAtb();
    } else if (el("[data-atb-server]")) {
      const b = el("[data-atb-server]");
      b.disabled = true;
      b.textContent = "Перевіряю… (до 40 с)";
      const out = $("#atb-server");
      try {
        const { results } = await api("/atb/server-probe", { method: "POST" });
        const label = { fetch: "Звичайний запит", browser: "Браузер Cloudflare" };
        out.innerHTML = results.map((r) => `<div class="${r.ok ? "ok-line" : "warn-line"}">${label[r.method]}: ${r.ok ? `пускає, ${r.cards} товарів` : esc(r.verdict)}${r.status ? ` · HTTP ${r.status}` : ""} · ${r.ms} мс${r.note ? ` · ${esc(r.note)}` : ""}</div>`).join("");
      } catch (err) {
        out.innerHTML = `<div class="warn-line">${esc(err.message)}</div>`;
      }
      loadAtb();
    } else if (el("[data-silpo-connect]")) {
      el("[data-silpo-connect]").disabled = true;
      const r = await api("/silpo/connect", { method: "POST" });
      location.href = r.url;
    } else if (el("[data-silpo-disconnect]")) {
      if (!(await askConfirm("Відключити Сільпо?", "Ціни перестануть оновлюватися, доки не підключите знову.", "Відключити"))) return;
      await api("/silpo/disconnect", { method: "POST" });
      await refreshMe();
      await renderSettings();
      toast("Сільпо відключено");
    } else if (el("[data-tgwebhook]")) {
      const r = await api("/telegram/webhook", { method: "POST" });
      toast(`Вебхук зареєстровано: ${r.url}`);
      loadTgStatus();
    } else if (el("[data-tgtest]")) {
      const r = await api("/telegram/test", { method: "POST" });
      toast(r.result === "sent" ? "Надіслано в Telegram" : r.result === "nothing" ? "Вигідного зараз немає — надіслала про це повідомлення" : "Чат не підключено");
    } else if (el("[data-collect]")) {
      const b = el("[data-collect]");
      b.disabled = true;
      const r = await api("/collect", { method: "POST" });
      toast(`Перевірено ${r.checked} цін`);
      await refreshMe();
      b.disabled = false;
    } else if (el("[data-seed]")) {
      const btn = el("[data-seed]");
      btn.disabled = true;
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
    searchTimer = setTimeout(() => doSearch(e.target.value), 300);
  }
});

/* ───────── Маршрутизація ───────── */
async function refreshMe() {
  try {
    state.me = await api("/me");
    ls.set("me", state.me);
    state.offline = false;
  } catch (e) {
    if (!e.offline || !state.me) throw e;
    state.offline = true;
  }
  document.body.classList.remove("locked");
}

async function route() {
  closeSheet();
  const h = location.hash || "#/";
  if (h.startsWith("#/deals")) {
    location.replace("#/assistant");
    return;
  }
  const name = h.startsWith("#/assistant") ? "assistant" : h.startsWith("#/settings") ? "settings" : h.startsWith("#/add") ? "add" : h.startsWith("#/shop") ? "shop" : h.startsWith("#/plan") ? "plan" : "lists";
  route.current = name;
  document.body.classList.remove("shopping", "fullscreen");
  if (name !== "shop") keepAwake(false);
  if (name !== "plan") state.planAll = false;
  const tab = name === "plan" ? "assistant" : name;
  $$(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  scrollTo(0, 0);
  try {
    if (!state.me) await refreshMe();
    else refreshMe().then(paintStatus).catch(() => {});
    if (name === "assistant") await renderAssistant();
    else if (name === "settings") await renderSettings();
    else if (name === "add") renderAdd();
    else if (name === "shop") await renderShop();
    else if (name === "plan") await renderPlan(decodeURIComponent(h.split("/")[2] ?? ""));
    else await renderList();
  } catch (e) {
    if (e.login) return drawLogin();
    view.innerHTML = `<div class="empty"><b>Щось пішло не так</b>${esc(e.message)}<div style="margin-top:14px"><button class="btn line" onclick="location.reload()">Спробувати ще раз</button></div></div>`;
  }
}

/* ───────── Вхід за паролем ───────── */
function drawLogin(error = "") {
  document.body.classList.add("locked");
  view.innerHTML = `
    <form class="login" id="login">
      <span class="wm" style="font-size:28px">Silpopo</span>
      <h1>Вхід</h1>
      <div class="stack">
        <label class="sub" for="pw">Пароль</label>
        <input class="field" id="pw" type="password" autocomplete="current-password" required autofocus>
        ${error ? `<div class="small" style="color:var(--bad);font-weight:700">${esc(error)}</div>` : ""}
        <button class="btn block big" type="submit">Увійти</button>
        <div class="sub">Пароль запам'ятається на цьому пристрої на рік.</div>
      </div>
    </form>`;
  $("#login").onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button");
    btn.disabled = true;
    try {
      await api("/login", { method: "POST", body: { password: $("#pw").value } });
      state.me = null;
      await route();
    } catch (err) {
      drawLogin(err.message);
    }
  };
}

/* Повернення після входу в Сільпо */
(() => {
  const q = new URLSearchParams(location.search);
  const r = q.get("silpo");
  if (!r) return;
  history.replaceState(null, "", location.pathname + location.hash);
  setTimeout(() => toast(r === "ok" ? "Сільпо підключено. Тепер виберіть магазини" : "Не вдалося підключити Сільпо — деталі в налаштуваннях"), 300);
})();

// Робота без інтернету: оболонка застосунку кешується service worker'ом.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

window.addEventListener("hashchange", route);
route();
flush();
