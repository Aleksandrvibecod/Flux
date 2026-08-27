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
  // показываем выбор тарифа в чате
  await ctx.reply(
    '💎 FLUX Premium — снимает все лимиты:\n• безлимит голос и текст\n• вся история 365д\n• сводка 22:00 + ИИ-аналитика',
    {
      reply_markup: new InlineKeyboard()
        .text('1 мес — 250 Stars (~299₽)', 'buy_1m')
        .row()
        .text('3 мес — 650 Stars (799₽) 🔥', 'buy_3m')
        .row()
        .text('6 мес — 1300 Stars (1599₽) ⭐', 'buy_6m')
    }
  );
});
async function sendStarsInvoice(ctx, plan) {
  const map = {
    '1m': { title: 'FLUX Premium — 1 месяц', desc: 'Безлимит 30 дней', amount: 250, payload: `premium_1m_${ctx.from.id}` },
    '3m': { title: 'FLUX Premium — 3 месяца', desc: 'Безлимит 90 дней, выгода 20%', amount: 650, payload: `premium_3m_${ctx.from.id}` },
    '6m': { title: 'FLUX Premium — 6 месяцев', desc: 'Безлимит 180 дней, выгода 30%', amount: 1300, payload: `premium_6m_${ctx.from.id}` },
  };
  const p = map[plan] || map['1m'];
  await ctx.replyWithInvoice(p.title, p.desc, p.payload, '', 'XTR', [{ label: p.title, amount: p.amount }]);
}
bot.callbackQuery('buy_1m', async (ctx) => { await ctx.answerCallbackQuery(); try { await sendStarsInvoice(ctx,'1m'); } catch(e){ await ctx.reply('⚠️ '+e.message); } });
bot.callbackQuery('buy_3m', async (ctx) => { await ctx.answerCallbackQuery(); try { await sendStarsInvoice(ctx,'3m'); } catch(e){ await ctx.reply('⚠️ '+e.message); } });
bot.callbackQuery('buy_6m', async (ctx) => { await ctx.answerCallbackQuery(); try { await sendStarsInvoice(ctx,'6m'); } catch(e){ await ctx.reply('⚠️ '+e.message); } });

// обязательны для Stars
bot.on('pre_checkout_query', async (ctx) => {
  try { await ctx.answerPreCheckoutQuery(true); } catch {}
});
bot.on('message:successful_payment', async (ctx) => {
  const pay = ctx.message.successful_payment;
  console.log('successful_payment', pay, 'from', ctx.from.id);
  const payload = pay.invoice_payload || '';
  let days = 30;
  if (payload.includes('3m')) days = 90;
  else if (payload.includes('6m')) days = 180;
  else if (payload.includes('1m')) days = 30;
  try {
    const res = await fetch(`${BACKEND}/premium/grant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegram_id: ctx.from.id, provider: 'telegram_stars', charge_id: pay.provider_payment_charge_id, payload, duration_days: days }),
    }).then(r=>r.json());
    if (res.ok) await ctx.reply(`✅ Оплата принята! Premium на ${days} дней активирован (до ${new Date(res.expires_at).toLocaleDateString('ru-RU')}) — лимиты сняты.`);
    else await ctx.reply('✅ Оплата прошла, но не смог активировать — напиши @support, id: ' + ctx.from.id);
  } catch (e) {
    console.error('premium grant failed', e);
    await ctx.reply('✅ Оплата прошла! Если Premium не включился — напиши поддержку с ID ' + ctx.from.id);
  }
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
