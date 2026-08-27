import { Bot, InlineKeyboard } from 'grammy';
import 'dotenv/config';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!token) {
  console.error('❌ Нет TELEGRAM_BOT_TOKEN! Добавь его в Railway -> bot -> Variables');
  // не падаем сразу, чтобы видеть логи
}
const bot = new Bot(token || '123456:TEST_TOKEN_DO_NOT_USE');
const BACKEND = (process.env.BACKEND_URL || 'http://localhost:3000').trim();
const MINIAPP_URL = (process.env.MINIAPP_URL || 'https://your-vercel.app').trim();

// /start
bot.command('start', async (ctx) => {
  await ctx.reply(
    '⚡️ Flux — твой трекер всего\n\nГолосом скажи: "потратил 500 на обед", "съел 2 яйца", "напомни завтра в 10 позвонить врачу"',
    {
      reply_markup: new InlineKeyboard()
        .webApp('📱 Открыть Flux', MINIAPP_URL)
        .row()
        .text('💎 Premium', 'premium')
    }
  );
});

bot.callbackQuery('premium', async (ctx) => {
  await ctx.answerCallbackQuery();
  // Telegram Stars оплата — заглушка, дальше подключить @BotFather Payments
  await ctx.reply('💎 Premium — безлимит голос, вся история, ИИ-отчёты.\nОплата через Stars скоро. Сейчас free-лимит 2 голоса и 5 текстов в день.');
});

// текст
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  await ctx.replyWithChatAction('typing');
  try {
    const res = await fetch(`${BACKEND}/parse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-id': String(ctx.from.id) },
      body: JSON.stringify({ text, telegram_id: ctx.from.id })
    }).then(r=>r.json());
    if (res.error) return ctx.reply(`⚠️ ${res.error}`);
    const p = res.parsed;
    let msg = '✅ Сохранено: ';
    if (p.type==='expense' || p.type==='income') msg += `${p.type==='expense'?'Расход':'Доход'} ${p.amount}₽ • ${p.category}`;
    else if (p.type==='calories') msg += `КБЖУ ${p.dish} — ${p.kcal} ккал`;
    else if (p.type==='reminder') msg += `Напомню ${p.remind_at}: ${p.text}`;
    else msg += p.title || 'заметка';
    await ctx.reply(msg, { reply_markup: new InlineKeyboard().webApp('Открыть', MINIAPP_URL) });
  } catch (e) {
    await ctx.reply('⚠️ Ошибка обработки, попробуй ещё раз');
  }
});

// voice / audio / video_note — шлём как аудио в Gemini
bot.on(['message:voice', 'message:audio', 'message:video_note'], async (ctx) => {
  const fileId = ctx.message.voice?.file_id || ctx.message.audio?.file_id || ctx.message.video_note?.file_id;
  if (!fileId) return;
  await ctx.replyWithChatAction('typing');
  const file = await ctx.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const buf = Buffer.from(await fetch(url).then(r=>r.arrayBuffer()));
  const blob = new Blob([buf], { type: 'audio/ogg' });
  const fd = new FormData();
  fd.append('file', blob, 'voice.ogg');
  try {
    const res = await fetch(`${BACKEND}/parse`, {
      method: 'POST',
      headers: { 'x-telegram-id': String(ctx.from.id) },
      body: fd
    }).then(r=>r.json());
    if (res.error) return ctx.reply(`⚠️ ${res.error}\nЛимит free — 2 голосовых и 5 текстов в день.`);
    const p = res.parsed;
    await ctx.reply(`🎙 Распознал: ${p.title || p.dish || p.text || p.note || JSON.stringify(p)}`);
  } catch (e) {
    await ctx.reply('⚠️ Не расслышал, попробуй ещё раз');
  }
});

// уведомления от backend (cron)
import http from 'http';
http.createServer(async (req, res) => {
  if (req.url==='/notify' && req.method==='POST') {
    let body=''; req.on('data',c=>body+=c); req.on('end', async ()=>{
      const { telegram_id, text } = JSON.parse(body);
      try { await bot.api.sendMessage(telegram_id, text); } catch {}
      res.writeHead(200); res.end('ok');
    });
  } else { res.writeHead(404); res.end(); }
}).listen(3001, ()=> console.log('bot notify on 3001'));

bot.start({ onStart:()=> console.log('bot started') });
