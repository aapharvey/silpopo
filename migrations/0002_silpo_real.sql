-- Перехід на справжні дані Сільпо.
ALTER TABLE products ADD COLUMN slug TEXT;

-- Прибираємо тестові (mock) дані: товари m-*, тестові магазини й доставку.
DELETE FROM item_candidates WHERE product_id LIKE 'm-%';
DELETE FROM list_items WHERE product_id LIKE 'm-%';
DELETE FROM price_snapshots WHERE product_id LIKE 'm-%' OR store_id LIKE 'mock-%' OR store_id = 'delivery';
DELETE FROM collect_state WHERE product_id LIKE 'm-%' OR store_id LIKE 'mock-%' OR store_id = 'delivery';
DELETE FROM products WHERE id LIKE 'm-%';
DELETE FROM stores WHERE id LIKE 'mock-%' OR id = 'delivery';
DELETE FROM settings WHERE key LIKE 'similar_none:%' OR key IN ('digest_last_day', 'tg_pending_query');
-- Загальні позиції ("будь-який бренд") лишаються: збирач підбере для них справжні товари.
