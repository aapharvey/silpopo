-- АТБ: товари, історія цін і зіставлення з позиціями списків.
CREATE TABLE atb_products (
  id          TEXT PRIMARY KEY,      -- data-productid на atbmarket.com
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  brand       TEXT,
  category    TEXT,
  pack_size   REAL,
  pack_unit   TEXT,
  per_kg      INTEGER NOT NULL DEFAULT 0,
  image_url   TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE atb_prices (
  product_id  TEXT NOT NULL REFERENCES atb_products(id),
  shop_id     TEXT NOT NULL DEFAULT '',
  day         TEXT NOT NULL,
  price       REAL NOT NULL,
  old_price   REAL,
  label       TEXT,
  min_price   REAL NOT NULL,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (product_id, shop_id, day)
);

-- ref = id товару Сільпо або "q:<запит>" для загальних позицій.
CREATE TABLE atb_matches (
  ref         TEXT NOT NULL,
  atb_id      TEXT NOT NULL REFERENCES atb_products(id),
  kind        TEXT NOT NULL CHECK (kind IN ('same', 'analog')),
  status      TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected', 'auto')),
  score       REAL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ref, atb_id)
);
CREATE INDEX idx_atb_matches_ref ON atb_matches(ref);
