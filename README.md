# Кошик (silpopo)

Особистий застосунок для списків покупок у «Сільпо»: стежить за цінами й акціями на товари зі списків,
підказує справжні знижки, дешевші схожі товари й найкращий момент для покупки, щоранку надсилає дайджест у Telegram.

## Що вміє

- **Списки** — кілька списків; позиція може бути конкретним товаром або загальною («молоко 2,5%, будь-який бренд» — тоді показується найвигідніший варіант).
- **Ціни по магазинах** — 1–2 улюблені магазини + доставка; видно, де дешевше.
- **Аналітика** — «звичайна» ціна за 90 днів, перевірка, чи акція справжня, рекордні мінімуми, ціна за кг/л, цикли акцій («наступна акція орієнтовно через 3 дні»).
- **Telegram-бот** — щоденний дайджест о 8:00 за Києвом; додавання товарів текстом або посиланням із silpo.ua; `/digest`.
- **Стартовий список з історії замовлень** у «Сільпо».

## Як влаштовано

Усе працює на безкоштовному тарифі Cloudflare:

| Частина | Де |
|---|---|
| Веб-інтерфейс (`public/`) | Cloudflare Workers static assets |
| API, бот, збирач (`src/`) | Cloudflare Worker (TypeScript, Hono) |
| База даних | Cloudflare D1 (`migrations/`) |
| Розклад | Cron Triggers: збір цін кожні 15 хв невеликими порціями, дайджест щогодини перевіряє 8:00 Києва |
| Вхід | Cloudflare Access (код на пошту) + перевірка JWT у Worker |
| Дані «Сільпо» | Офіційний MCP `https://mcp.silpo.ua/mcp` (OAuth від імені акаунта) |

Режим `SILPO_MODE`:
- `mock` — тестові дані (для розробки й демо, кнопка «Заповнити демо-даними» в налаштуваннях);
- `mcp` — справжні дані через MCP «Сільпо» (**в процесі**: див. `src/silpo/mcp.ts`, `TOOL_MAP`).

## Розгортання (один раз)

1. **Cloudflare → Workers & Pages → D1 → Create** базу `silpopo`. Скопіювати її ID у `wrangler.jsonc` → `d1_databases[0].database_id`.
2. **Workers & Pages → Create → Import a repository** → вибрати `aapharvey/silpopo`.
   - Build command: `npm ci`
   - Deploy command: `npx wrangler d1 migrations apply silpopo --remote && npx wrangler deploy`
   Після цього кожен push у `main` автоматично оновлює застосунок.
3. **Секрети** (Worker → Settings → Variables and Secrets → *Secret*):
   - `TELEGRAM_BOT_TOKEN` — токен від @BotFather;
   - `TELEGRAM_WEBHOOK_SECRET` — будь-який довгий випадковий рядок.
4. **Вхід через Cloudflare Access** (Zero Trust → Access → Applications → Add → Self-hosted):
   домен — адреса воркера (`silpopo.<акаунт>.workers.dev`), політика *Allow* для потрібних email,
   **виключити шлях `/telegram/webhook`** (окремий застосунок з політикою *Bypass* для цього шляху).
   Потім у змінних воркера задати `ALLOWED_EMAILS`, `ACCESS_TEAM_DOMAIN` (`<команда>.cloudflareaccess.com`) і `ACCESS_AUD` (Application Audience tag).
5. Відкрити застосунок → **Налаштування**: додати магазини, натиснути «Підключити Telegram».
   Спершу натиснути «Зареєструвати вебхук бота» (один раз), потім «Підключити Telegram».

## Локальна розробка

```bash
npm install
echo "DEV_NO_AUTH=1" > .dev.vars        # вимкнути перевірку входу локально
npm run db:migrate:local
npm run dev                             # http://localhost:8787
npm test && npm run typecheck
```

## Ліміти безкоштовного Cloudflare, які враховано

- 10 мс CPU на запуск → збирач обробляє `COLLECT_BATCH` (12) пар «товар × магазин» за раз, кожні 15 хв;
- 50 підзапитів на запуск (запити до БД теж рахуються) → пакетні `db.batch(...)`;
- 5 cron-тригерів на акаунт → використано 2;
- до 4 активних магазинів.
