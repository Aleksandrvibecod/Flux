import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cron from 'node-cron';
import 'dotenv/config';
import { supabase, getOrCreateUser, canUseVoice, incVoice, canUseMessage, incMessage } from './supabase.js';
import { parseWithGemini, generateInsights } from './gemini.js';

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

  // лимит voice
  if (isAudio) {
  const ok = await canUseVoice(user);
  if (!ok) return reply.code(403).send({ error: 'voice limit 10/day, need premium' });
}

  let text = '';
  let audioBase64 = null;
  let audioMime = 'audio/ogg';
  if (isAudio) {
    const data = await req.file();
    const buf = await data.toBuffer();
    audioBase64 = buf.toString('base64');
    audioMime = data.mimetype || 'audio/ogg';
    text = data.fields?.text?.value || '';
  } else {
    text = req.body?.text || '';
  }

  const parsed = await parseWithGemini({ text, audioBase64, audioMime });
  if (isAudio) await incVoice(user);

  // запись по типу
  let saved = null;
  try {
    if (parsed.type === 'expense' || parsed.type === 'income') {
      const { data } = await supabase.from('transactions').insert({
        user_id: user.id, type: parsed.type, amount: parsed.amount, category: parsed.category || 'прочее', note: parsed.note || text
      }).select().single();
      saved = data;
    } else if (parsed.type === 'calories') {
      const { data } = await supabase.from('calories').insert({
        user_id: user.id, dish: parsed.dish, kcal: parsed.kcal, protein: parsed.protein||0, fat: parsed.fat||0, carbs: parsed.carbs||0
      }).select().single();
      saved = data;
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

  return { parsed, saved, premium: user.is_premium };
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
  return { transactions: tx.data, calories: cal.data, notes: notes.data, is_premium: user.is_premium };
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

const port = process.env.PORT || 3000;
app.listen({ port, host: '0.0.0.0' }).then(()=> app.log.info(`backend on ${port}`));
