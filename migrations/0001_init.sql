-- Магазини (і доставка як окремий "магазин"), за якими стежимо.
CREATE TABLE stores (
  id            TEXT PRIMARY KEY,          -- id магазину в Сільпо, або 'delivery'
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'store' CHECK (kind IN ('store', 'delivery')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Каталог товарів, які нас цікавлять (з її списків і схожі на них).
CREATE TABLE products (
  id            TEXT PRIMARY KEY,          -- id товару в Сільпо
  name          TEXT NOT NULL,
  brand         TEXT,
  category      TEXT,
  pack_size     REAL,                      -- 0.9
  pack_unit     TEXT,                      -- 'kg' | 'l' | 'pcs'
  image_url     TEXT,
  url           TEXT,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE lists (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  emoji         TEXT,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Позиція у списку: або конкретний товар (product_id), або загальний запит (query),
-- напр. "молоко 2,5% 900 мл, будь-який бренд".
CREATE TABLE list_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id       INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id),
  query         TEXT,
  title         TEXT NOT NULL,             -- як показувати в списку
  quantity      REAL NOT NULL DEFAULT 1,
  note          TEXT,
  stockable     INTEGER NOT NULL DEFAULT 0, -- можна запастися (кава, хімія)
  checked       INTEGER NOT NULL DEFAULT 0, -- відмічено як куплене
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (product_id IS NOT NULL OR query IS NOT NULL)
);
CREATE INDEX idx_list_items_list ON list_items(list_id);
CREATE INDEX idx_list_items_product ON list_items(product_id);

-- Кандидати для загальних позицій і "схожі товари" для конкретних.
CREATE TABLE item_candidates (
  item_id       INTEGER NOT NULL REFERENCES list_items(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id),
  source        TEXT NOT NULL DEFAULT 'search' CHECK (source IN ('search', 'similar')),
  found_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (item_id, product_id)
);

-- Історія цін: один рядок на товар × магазин × день (останнє спостереження дня + мінімум дня).
CREATE TABLE price_snapshots (
  product_id    TEXT NOT NULL REFERENCES products(id),
  store_id      TEXT NOT NULL REFERENCES stores(id),
  day           TEXT NOT NULL,             -- 'YYYY-MM-DD' за Києвом
  price         REAL NOT NULL,             -- ціна, яку платиш (з акцією)
  regular_price REAL,                      -- стара/звичайна ціна, якщо є акція
  promo_type    TEXT,
  promo_until   TEXT,
  in_stock      INTEGER NOT NULL DEFAULT 1,
  min_price     REAL NOT NULL,             -- мінімум за день
  checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, store_id, day)
);
CREATE INDEX idx_snapshots_store_day ON price_snapshots(store_id, day);

-- Коли товар востаннє перевіряли в кожному магазині (черга збирача).
CREATE TABLE collect_state (
  product_id    TEXT NOT NULL,
  store_id      TEXT NOT NULL,
  last_checked  TEXT NOT NULL,
  last_error    TEXT,
  PRIMARY KEY (product_id, store_id)
);

-- Прості налаштування ключ-значення: telegram chat, коди прив'язки, дата останнього дайджесту тощо.
CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth-токени для MCP Сільпо (зберігаються лише тут, ніколи не в коді).
CREATE TABLE oauth_tokens (
  provider      TEXT PRIMARY KEY,          -- 'silpo'
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TEXT,
  meta          TEXT,                      -- JSON: client_id, scope тощо
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO lists (name, emoji, position) VALUES ('Тижнева закупівля', '🛒', 0);
