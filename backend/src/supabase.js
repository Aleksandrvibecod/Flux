import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';
import ws from 'ws';

const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
const supabaseKey = (process.env.SUPABASE_SERVICE_KEY || '').trim();

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ Нет SUPABASE_URL или SUPABASE_SERVICE_KEY! Зайди в Railway -> Variables и добавь их.');
  console.error('Сейчас SUPABASE_URL =', JSON.stringify(supabaseUrl));
}

export const supabase = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, { realtime: { transport: ws } })
  : new Proxy({}, {
      get() { throw new Error('Supabase не настроен: добавь SUPABASE_URL и SUPABASE_SERVICE_KEY в Railway Variables'); }
    });

// helper: получить или создать юзера по telegram_id
export async function getOrCreateUser(telegram_id, { username, first_name } = {}) {
  let { data } = await supabase.from('users').select('*').eq('telegram_id', telegram_id).single();
  if (data) {
    if (!data.referral_code) {
      const code = 'ref' + telegram_id.toString(36);
      await supabase.from('users').update({ referral_code: code }).eq('id', data.id);
      data.referral_code = code;
    }
    return data;
  }
  const code = 'ref' + telegram_id.toString(36);
  const { data: created, error } = await supabase.from('users').insert({
    telegram_id, username, first_name, referral_code: code
  }).select().single();
  if (error) throw error;
  return created;
}

// freemium проверки - Free: 2 голоса, 5 текстов; Premium: безлимит
export async function canUseVoice(user) {
  if (user.is_premium) return true;
  const today = new Date().toISOString().slice(0,10);
  if (user.voice_limit_date !== today) {
    await supabase.from('users').update({ voice_used_today: 0, voice_limit_date: today }).eq('id', user.id);
    return true;
  }
  return (user.voice_used_today || 0) < 2;
}
export async function incVoice(user) {
  if (user.is_premium) return;
  await supabase.from('users').update({ voice_used_today: (user.voice_used_today||0)+1 }).eq('id', user.id);
}
export async function canUseMessage(user) {
  if (user.is_premium) return true;
  const today = new Date().toISOString().slice(0,10);
  if (user.message_limit_date !== today) {
    await supabase.from('users').update({ message_used_today: 0, message_limit_date: today }).eq('id', user.id);
    return true;
  }
  return (user.message_used_today || 0) < 5;
}
export async function incMessage(user) {
  if (user.is_premium) return;
  await supabase.from('users').update({ message_used_today: (user.message_used_today||0)+1 }).eq('id', user.id);
}
export async function isHistoryLimited(user) {
  return !user.is_premium;
}
