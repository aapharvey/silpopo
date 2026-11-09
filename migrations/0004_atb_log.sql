-- Коли кожну позицію списку востаннє успішно перевіряли в АТБ (щоб черга містила лише «несвіжі»).
CREATE TABLE atb_search_log (
  ref        TEXT PRIMARY KEY,   -- id товару Сільпо або "q:<запит>"
  q          TEXT,
  last_ok    TEXT,               -- день останньої успішної перевірки (за Києвом)
  fail_day   TEXT,
  fails      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
