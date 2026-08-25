# Flux — Telegram Bot + Mini App (iOS 26 glassmorphism)

Монорепо: `/bot` (grammy) + `/backend` (Fastify + Supabase + Gemini via OpenRouter) + `/miniapp` (React + Tailwind)

**Вариант А (без VPN):** Gemini идёт через `https://openrouter.ai/api/v1` с `GEMINI_API_KEY=sk-or-v1...` — обходит блок `Google AI Studio is not available in your region`.

## Быстрый старт
1. `supabase/schema.sql` → выполни в Supabase SQL Editor
2. `cp .env.example .env` → заполни 3 ключа (Telegram, Supabase, OpenRouter)
3. `npm install` в `backend`, `bot`, `miniapp`
4. `npm run dev` (или `npm --workspace=backend run dev` и т.д.)

## Деплой бесплатно
- `backend` + `bot` → Railway/Render (Dockerfile есть, Variables из `.env`)
- `miniapp` → Vercel: `Import GitHub repo` → Root `miniapp` → `VITE_BACKEND_URL` = твой Railway URL
- В @BotFather → `/mybots` → `Menu Button` → URL твоего Vercel

## Freemium
Free: 10 войсов/день, 7 дней истории, без аналитики. Paid: безлимит, вся история, `/analytics` с ИИ-инсайтами. Проверка в `supabase.js` → `canUseVoice`/`isPremium`.

## Voice → Gemini
Бот скачивает `voice.ogg` → `FormData` → `POST /parse` → Gemini парсит аудио напрямую без STT.
