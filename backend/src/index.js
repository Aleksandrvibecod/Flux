import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cron from 'node-cron';
import 'dotenv/config';
import { supabase, getOrCreateUser, canUseVoice, incVoice, canUseMessage, incMessage } from './supabase.js';
import { parseWithGemini, generateInsights, parseReceiptImage, parseFoodImage } from './gemini.js';

async function handleCoffeeStreak(user) {
  try {
    const today = moscowDayRange(0);
    // был ли кофе сегодня?
    const { data: coffeeToday } = await supabase.from('transactions').select('id').eq('user_id', user.id).eq('type','expense').ilike('category','%кофе%').gte('created_at', today.start).lte('created_at', today.end).limit(1);
    const hadCoffee = (coffeeToday?.length||0) > 0;
    const { data: st } = await supabase.from('streaks').select('*').eq('user_id', user.id).eq('habit','no_coffee_500').maybeSingle();
    let streak = st?.streak || 0;
    let best = st?.best_streak || 0;
    const lastDate = st?.last_date;
    const todayStr = moscowDateStr(0);
    if (hadCoffee) {
      streak = 0;
    } else {
      if (lastDate !== todayStr) {
        streak = (lastDate === moscowDateStr(-1) ? streak : 0) + 1;
        best = Math.max(best, streak);
      }
    }
    if (st?.id) await supabase.from('streaks').update({ streak, best_streak: best, last_date: todayStr, updated_at: new Date().toISOString() }).eq('id', st.id);
    else await supabase.from('streaks').insert({ user_id: user.id, habit:'no_coffee_500', streak, best_streak: best, last_date: todayStr });
    return { streak, best };
  } catch(e){ console.warn('streak fail',e.message); return {streak:0} }
}

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 18 * 1024 * 1024 } });

// health
app.get('/health', async () => ({ ok: true }));

// Telegram WebApp auth — проверяем initData (упрощённо, для MVP доверяем telegram_id)
app.addHook('preHandler', async (req) => {
  // initData будет проверяться в боте, тут берём telegram_id из header/query/body
  req.telegramId = Number(req.headers['x-telegram-id'] || req.query.telegram_id || req.body?.telegram_id || 0);
});

// POST /parse — текст или аудио (multipart) → JSON -> запись в БД
app.post('/parse', async (req, reply) => {
  const telegramId = req.telegramId;
  if (!telegramId) return reply.code(401).send({ error: 'no telegram_id' });
  const user = await getOrCreateUser(telegramId, {});

  // лимиты: free 2 голоса + 5 текстов, premium безлимит
  const isAudio = req.isMultipart();
  if (isAudio) {
    const ok = await canUseVoice(user);
    if (!ok) return reply.code(403).send({ error: 'voice limit 2/day, need premium' });
  } else {
    const ok = await canUseMessage(user);
    if (!ok) return reply.code(403).send({ error: 'message limit 5/day, need premium' });
  }

  let text = '';
  let audioBase64 = null;
  let audioMime = 'audio/ogg';
  let imageBase64 = null;
  let imageMime = null;
  let isImage = false;
  if (isAudio) {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: 'no file' });
    const buf = await data.toBuffer();
    const mime = data.mimetype || 'application/octet-stream';
    if (mime.startsWith('image/')) {
      isImage = true;
      imageBase64 = buf.toString('base64');
      imageMime = mime;
      text = data.fields?.text?.value || data.fields?.type?.value || '';
    } else {
      audioBase64 = buf.toString('base64');
      audioMime = mime;
      text = data.fields?.text?.value || '';
    }
  } else {
    text = req.body?.text || '';
    // поддержка base64 image в JSON (миниап шлет {imageBase64, mime})
    if (req.body?.imageBase64) { imageBase64 = req.body.imageBase64; imageMime = req.body.mime || 'image/jpeg'; isImage = true; }
  }

  let parsed;
  try {
    if (isImage) {
      const hint = (text || '').toLowerCase();
      if (hint.includes('чек') || hint.includes('receipt')) parsed = await parseReceiptImage({ imageBase64, mime: imageMime });
      else if (hint.includes('еда') || hint.includes('ккал') || hint.includes('food')) parsed = await parseFoodImage({ imageBase64, mime: imageMime });
      else {
        // авто: пробуем чек, если total>0 считаем чеком, иначе еда
        const r = await parseReceiptImage({ imageBase64, mime: imageMime });
        if (r.type==='receipt' && r.total) parsed = r;
        else parsed = await parseFoodImage({ imageBase64, mime: imageMime });
      }
    } else {
      parsed = await parseWithGemini({ text, audioBase64, audioMime });
    }
  } catch (e) {
    const raw = e.error?.error?.message || e.error?.message || e.message || String(e);
    const details = JSON.stringify(e.error || raw).slice(0,800);
    app.log.error({ err: e, raw, telegramId, audioMime, hasAudio: !!audioBase64, isImage }, 'parseWithGemini failed');
    return reply.code(400).send({ error: `AI error: ${raw}`, details, provider: e.error?.error?.metadata?.provider_name || null });
  }
  if (!isImage) {
    if (isAudio) await incVoice(user);
    else await incMessage(user);
  }

  // запись по типу
  let saved = null;
  let bonusInfo = null;
  try {
    if (parsed.type === 'expense' || parsed.type === 'income') {
      const { data } = await supabase.from('transactions').insert({
        user_id: user.id, type: parsed.type, amount: parsed.amount, category: parsed.category || 'прочее', note: parsed.note || text
      }).select().single();
      saved = data;
      bonusInfo = await handleCoffeeStreak(user);
    } else if (parsed.type === 'calories') {
      const { data } = await supabase.from('calories').insert({
        user_id: user.id, dish: parsed.dish, kcal: parsed.kcal, protein: parsed.protein||0, fat: parsed.fat||0, carbs: parsed.carbs||0
      }).select().single();
      saved = data;
    } else if (parsed.type === 'receipt') {
      // чек: создаем несколько транзакций
      const items = parsed.items || [];
      for (const it of items.slice(0,10)) {
        await supabase.from('transactions').insert({ user_id: user.id, type:'expense', amount: Number(it.amount)||0, category: it.name?.slice(0,32) || 'прочее', note: `чек ${parsed.shop||''}`.trim() });
      }
      saved = { items, total: parsed.total, shop: parsed.shop };
      bonusInfo = await handleCoffeeStreak(user);
    } else if (parsed.type === 'note' || parsed.type === 'task' || parsed.type === 'idea') {
      const kind = parsed.kind || 'note';
      const { data } = await supabase.from('notes').insert({
        user_id: user.id, kind, title: parsed.title || text.slice(0,60), content: parsed.content || ''
      }).select().single();
      saved = data;
    } else if (parsed.type === 'reminder') {
      const { data } = await supabase.from('reminders').insert({
        user_id: user.id, text: parsed.text, remind_at: parsed.remind_at
      }).select().single();
      saved = data;
    }
  } catch (e) { app.log.error(e); }

  return { parsed, saved, premium: user.is_premium, streak: bonusInfo };
});

// GET /history — для Mini App
app.get('/history', async (req, reply) => {
  const uid = req.telegramId;
  if (!uid) return reply.code(401).send({error:'no id'});
  const user = await getOrCreateUser(uid);
  const since = new Date(); since.setDate(since.getDate() - (user.is_premium ? 365 : 7));
  const [tx, cal, notes] = await Promise.all([
    supabase.from('transactions').select('*').eq('user_id', user.id).gte('created_at', since.toISOString()).order('created_at', {ascending:false}).limit(50),
    supabase.from('calories').select('*').eq('user_id', user.id).gte('created_at', since.toISOString()).order('created_at', {ascending:false}).limit(50),
    supabase.from('notes').select('*').eq('user_id', user.id).order('created_at', {ascending:false}).limit(50),
  ]);
  // streaks & bonuses
  const { data: streaks } = await supabase.from('streaks').select('*').eq('user_id', user.id);
  const { data: bonuses } = await supabase.from('bonuses').select('*').eq('user_id', user.id).order('created_at',{ascending:false}).limit(10);
  return { transactions: tx.data, calories: cal.data, notes: notes.data, is_premium: user.is_premium, monthly_budget: user.monthly_budget || 20000, streaks, bonuses, bonus_balance: user.bonus_balance||0 };
});

// бюджет месяца: GET/POST /budget
app.get('/budget', async (req,reply)=>{
  const user = await getOrCreateUser(req.telegramId);
  return { budget: user.monthly_budget || 20000 };
});
app.post('/budget', async (req,reply)=>{
  try{
    const user = await getOrCreateUser(req.telegramId);
    const b = Math.max(1000, Math.min(1000000, Number(req.body?.budget || req.body?.amount || 20000)));
    const { error } = await supabase.from('users').update({ monthly_budget: b }).eq('id', user.id);
    if (error) {
      if (error.message?.includes('monthly_budget')) {
        return reply.code(500).send({ error: 'column monthly_budget missing', hint: 'Выполни в Supabase SQL Editor: alter table public.users add column if not exists monthly_budget int default 20000;' });
      }
      throw error;
    }
    return { budget: b };
  }catch(e){
    app.log.error(e);
    return reply.code(500).send({ error: e.message });
  }
});

app.get('/analytics', async (req) => {
  const user = await getOrCreateUser(req.telegramId);
  if (!user.is_premium) return { error: 'premium only', premium: false };
  const since = new Date(); since.setDate(since.getDate()-7);
  const { data: tx } = await supabase.from('transactions').select('*').eq('user_id', user.id).gte('created_at', since.toISOString());
  const { data: cal } = await supabase.from('calories').select('*').eq('user_id', user.id).gte('created_at', since.toISOString());
  const { data: notes } = await supabase.from('notes').select('*').eq('user_id', user.id).gte('created_at', since.toISOString());
  const insights = await generateInsights({ transactions: tx||[], calories: cal||[], notes: notes||[] });
  return { insights: insights.insights, transactions: tx, calories: cal };
});

app.delete('/transactions/:id', async (req,reply)=>{
  const uid = req.telegramId; if (!uid) return reply.code(401).send({error:'no id'});
  const user = await getOrCreateUser(uid);
  await supabase.from('transactions').delete().eq('id', req.params.id).eq('user_id', user.id);
  return {ok:true}
});
app.delete('/calories/:id', async (req,reply)=>{
  const uid = req.telegramId; if (!uid) return reply.code(401).send({error:'no id'});
  const user = await getOrCreateUser(uid);
  await supabase.from('calories').delete().eq('id', req.params.id).eq('user_id', user.id);
  return {ok:true}
});
app.delete('/notes/:id', async (req,reply)=>{
  const uid = req.telegramId; if (!uid) return reply.code(401).send({error:'no id'});
  const user = await getOrCreateUser(uid);
  await supabase.from('notes').delete().eq('id', req.params.id).eq('user_id', user.id);
  return {ok:true}
});

// helpers для московской даты (22:00 МСК)
function moscowDateStr(offsetDays = 0) {
  const t = Date.now() + offsetDays * 86400000;
  return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Moscow' }); // YYYY-MM-DD
}
function moscowDayRange(offsetDays = 0) {
  const dateStr = moscowDateStr(offsetDays);
  return {
    dateStr,
    start: new Date(`${dateStr}T00:00:00+03:00`).toISOString(),
    end: new Date(`${dateStr}T23:59:59.999+03:00`).toISOString(),
  };
}

async function buildDailySummary(user) {
  const today = moscowDayRange(0);
  const yesterday = moscowDayRange(-1);
  const tomorrow = moscowDayRange(1);

  const [{ data: todayTx }, { data: yestTx }, { data: tomorrowReminders }, { data: openTasks }] = await Promise.all([
    supabase.from('transactions').select('amount,category,type').eq('user_id', user.id).eq('type','expense').gte('created_at', today.start).lte('created_at', today.end),
    supabase.from('transactions').select('amount,category,type').eq('user_id', user.id).eq('type','expense').gte('created_at', yesterday.start).lte('created_at', yesterday.end),
    supabase.from('reminders').select('text,remind_at').eq('user_id', user.id).gte('remind_at', tomorrow.start).lte('remind_at', tomorrow.end).order('remind_at'),
    supabase.from('notes').select('title,kind').eq('user_id', user.id).eq('kind','task').eq('is_done', false).limit(10),
  ]);

  const sum = (arr) => arr?.reduce((s,t)=> s + Number(t.amount||0), 0) || 0;
  const byCat = (arr) => {
    const m={}; arr?.forEach(t=>{ const k=t.category||'прочее'; m[k]=(m[k]||0)+Number(t.amount||0) });
    return m;
  };
  const todaySum = sum(todayTx);
  const yestSum = sum(yestTx);
  const todayByCat = byCat(todayTx);
  const yestByCat = byCat(yestTx);

  const allCats = new Set([...Object.keys(todayByCat), ...Object.keys(yestByCat)]);
  let catLines = [];
  for (const cat of allCats) {
    const a = todayByCat[cat]||0, b = yestByCat[cat]||0;
    if (a===0 && b===0) continue;
    const diff = a-b;
    const pct = b ? Math.round(diff/b*100) : null;
    const sign = diff>0?'+':'' ;
    const arrow = diff>0?'🔺': diff<0?'✅':'—';
    const pctStr = pct===null ? 'новая' : `${sign}${pct}%`;
    catLines.push(`• ${cat}: ${a} ₽ vs ${b} ₽ (${sign}${diff} ₽, ${pctStr} ${arrow})`);
  }
  if (!catLines.length) catLines = ['• трат сегодня нет — так держать!'];

  const totalPct = yestSum ? Math.round((todaySum-yestSum)/yestSum*100) : null;
  const totalLine = yestSum || todaySum
    ? `💸 Расходы сегодня: ${todaySum} ₽ (вчера ${yestSum} ₽${totalPct!==null?`, ${totalPct>0?'+':''}${totalPct}%`:''})`
    : `💸 Сегодня без трат`;

  const tomorrowDate = new Date(tomorrow.dateStr).toLocaleDateString('ru-RU', {weekday:'long', day:'numeric', month:'short'});
  let tasksLines = [];
  if (tomorrowReminders?.length) {
    tasksLines.push(...tomorrowReminders.map(r=>{
      const t = new Date(r.remind_at).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow', hour:'2-digit', minute:'2-digit'});
      return `• ${t} — ${r.text}`;
    }));
  }
  if (openTasks?.length && tasksLines.length < 5) {
    tasksLines.push(...openTasks.slice(0, 5 - tasksLines.length).map(n=> `• задача: ${n.title}`));
  }
  if (!tasksLines.length) tasksLines = ['• дел на завтра нет — отдыхай 😴'];

  const header = `🌙 Вечерняя сводка FLUX — ${new Date().toLocaleDateString('ru-RU',{timeZone:'Europe/Moscow', day:'numeric', month:'short'})}`;
  return `${header}\n\n${totalLine}\n\nПо статьям:\n${catLines.slice(0,10).join('\n')}\n\n📅 На завтра (${tomorrowDate}):\n${tasksLines.join('\n')}`;
}

async function sendDailyToAll() {
  const botUrl = process.env.BOT_NOTIFY_URL;
  if (!botUrl) { app.log.warn('BOT_NOTIFY_URL не задан — daily сводка не отправится'); return; }
  const { data: users } = await supabase.from('users').select('id,telegram_id').limit(1000);
  if (!users?.length) return;
  for (const u of users) {
    try {
      const text = await buildDailySummary(u);
      await fetch(botUrl, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ telegram_id: u.telegram_id, text }) });
      await new Promise(r=>setTimeout(r,150)); // не спамим Telegram 429
    } catch (e) { app.log.error({err:e, telegram_id:u.telegram_id}, 'daily send failed'); }
  }
  app.log.info(`daily summary sent to ${users.length} users`);
}

// premium grant — вызывает бот после successful_payment (Stars / YooKassa)
app.post('/premium/grant', async (req,reply)=>{
  const tid = Number(req.body?.telegram_id || req.telegramId);
  if (!tid) return reply.code(400).send({error:'need telegram_id'});
  const provider = (req.body?.provider || 'telegram_stars').slice(0,32);
  const days = Math.max(1, Math.min(365, Number(req.body?.duration_days || 30)));
  const user = await getOrCreateUser(tid);
  // продление: если уже есть активная подписка — добавляем к ее концу, иначе от сейчас
  const { data: cur } = await supabase.from('subscriptions').select('expires_at').eq('user_id', user.id).eq('status','active').gt('expires_at', new Date().toISOString()).order('expires_at',{ascending:false}).limit(1).maybeSingle();
  let base = cur?.expires_at ? new Date(cur.expires_at) : new Date();
  if (base < new Date()) base = new Date();
  base.setDate(base.getDate() + days);
  const expires = base.toISOString();
  await supabase.from('users').update({ is_premium: true }).eq('id', user.id);
  await supabase.from('subscriptions').insert({ user_id: user.id, provider, status:'active', expires_at: expires });
  app.log.info({telegram_id: tid, provider, days, expires}, 'premium granted');
  return { ok:true, is_premium:true, expires_at: expires, days };
});
app.get('/premium/status', async (req,reply)=>{
  const tid = Number(req.query.telegram_id || req.telegramId);
  if (!tid) return reply.code(400).send({error:'need telegram_id'});
  const user = await getOrCreateUser(tid);
  const { data: sub } = await supabase.from('subscriptions').select('*').eq('user_id', user.id).eq('status','active').order('expires_at',{ascending:false}).limit(1).maybeSingle();
  if (sub?.expires_at) {
    const daysLeft = Math.max(0, Math.ceil((new Date(sub.expires_at) - new Date())/86400000));
    return { is_premium: !!user.is_premium, expires_at: sub.expires_at, provider: sub.provider, days_left: daysLeft, status: sub.status };
  }
  return { is_premium: !!user.is_premium, expires_at: null, provider: null, days_left: 0 };
});
// создание Stars инвойса из миниапа: POST /premium/create-invoice {telegram_id, plan: 1m|3m|6m}
app.post('/premium/create-invoice', async (req,reply)=>{
  const tid = Number(req.body?.telegram_id || req.telegramId);
  if (!tid) return reply.code(400).send({error:'need telegram_id'});
  const plan = (req.body?.plan || '1m');
  const plans = {
    '1m': { amount: 250, days: 30, label: 'Premium 1 месяц', rub: '299₽' },
    '3m': { amount: 650, days: 90, label: 'Premium 3 месяца', rub: '799₽' },
    '6m': { amount: 1300, days: 180, label: 'Premium 6 месяцев', rub: '1599₽' },
  };
  const p = plans[plan] || plans['1m'];
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return reply.code(500).send({error:'no bot token on backend'});
  const payload = `premium_${plan}_${tid}_${Date.now()}`;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/createInvoiceLink`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: p.label,
      description: 'Безлимит голос, вся история 365д, сводка 22:00, ИИ-аналитика',
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: p.label, amount: p.amount }],
    }),
  }).then(r=>r.json());
  if (!res.ok) {
    app.log.error({res}, 'createInvoiceLink failed');
    return reply.code(400).send({ error: res.description || 'createInvoice failed', raw: res });
  }
  return { invoiceLink: res.result, plan, ...p, payload };
});

// тест руками: GET /daily-test?telegram_id=1072185171  или POST /daily-send (для админа)
app.get('/daily-test', async (req,reply)=>{
  const id = Number(req.query.telegram_id || req.telegramId);
  if (!id) return reply.code(400).send({error:'need telegram_id'});
  const user = await getOrCreateUser(id);
  const text = await buildDailySummary(user);
  return { telegram_id: id, text };
});
app.post('/daily-send', async (req,reply)=>{
  const id = Number(req.body?.telegram_id || req.telegramId);
  if (id) {
    const user = await getOrCreateUser(id);
    const text = await buildDailySummary(user);
    const botUrl = process.env.BOT_NOTIFY_URL;
    if (botUrl) await fetch(botUrl, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({telegram_id:id, text})});
    return { sent_to: id, text };
  }
  await sendDailyToAll();
  return { sent_to: 'all' };
});

// cron — каждую минуту проверяем напоминания
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString();
  const { data } = await supabase.from('reminders').select('*, users!inner(telegram_id)').eq('is_sent', false).lte('remind_at', now).limit(20);
  if (!data?.length) return;
  for (const r of data) {
    try {
      const botUrl = process.env.BOT_NOTIFY_URL; // http://bot:3001/notify
      if (botUrl) await fetch(botUrl, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ telegram_id: r.users.telegram_id, text: `⏰ Напоминание: ${r.text}` }) });
      await supabase.from('reminders').update({ is_sent: true }).eq('id', r.id);
    } catch (e) { app.log.error(e); }
  }
});

// cron — проверка просроченных подписок каждый час -> снимаем premium
cron.schedule('0 * * * *', async ()=>{
  try{
    const now = new Date().toISOString();
    const { data: expired } = await supabase.from('subscriptions').select('id,user_id').eq('status','active').lt('expires_at', now).limit(100);
    if (!expired?.length) return;
    for (const s of expired){
      await supabase.from('subscriptions').update({ status:'expired' }).eq('id', s.id);
      // если у юзера нет других активных подписок — снимаем premium
      const { data: active } = await supabase.from('subscriptions').select('id').eq('user_id', s.user_id).eq('status','active').gt('expires_at', now).limit(1);
      if (!active?.length) await supabase.from('users').update({ is_premium:false }).eq('id', s.user_id);
    }
    if (expired.length) app.log.info(`expired ${expired.length} subscriptions`);
  }catch(e){ app.log.error(e); }
});

// cron — стрик кофе: каждый день 23:55 МСК проверяем не покупал ли кофе
cron.schedule('55 23 * * *', async ()=>{
  try{
    const { data: users } = await supabase.from('users').select('id,bonus_balance').limit(500);
    if (!users?.length) return;
    for (const u of users) await handleCoffeeStreak(u);
    app.log.info(`coffee streak checked for ${users.length} users`);
  }catch(e){ app.log.error(e); }
}, { timezone: 'Europe/Moscow' });

// cron — каждый день в 22:00 МСК сводка по расходам + дела на завтра
cron.schedule('0 22 * * *', async () => {
  app.log.info('daily 22:00 cron start');
  try { await sendDailyToAll(); } catch(e){ app.log.error(e); }
}, { timezone: 'Europe/Moscow' });

const port = process.env.PORT || 3000;
app.listen({ port, host: '0.0.0.0' }).then(()=> app.log.info(`backend on ${port}`));
