import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service_role, обходит RLS
);

// helper: получить или создать юзера по telegram_id
export async function getOrCreateUser(telegram_id, { username, first_name } = {}) {
  let { data } = await supabase.from('users').select('*').eq('telegram_id', telegram_id).single();
  if (data) return data;
  const { data: created, error } = await supabase.from('users').insert({
    telegram_id, username, first_name
  }).select().single();
  if (error) throw error;
  return created;
}

// freemium проверки
export async function canUseVoice(user) {
  if (user.is_premium) return true;
  const today = new Date().toISOString().slice(0,10);
  if (user.voice_limit_date !== today) {
    await supabase.from('users').update({ voice_used_today: 0, voice_limit_date: today }).eq('id', user.id);
    return true;
  }
  return (user.voice_used_today || 0) < 2;
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
}
export async function incVoice(user) {
  if (user.is_premium) return;
  await supabase.from('users').update({ voice_used_today: (user.voice_used_today||0)+1 }).eq('id', user.id);
}
export async function isHistoryLimited(user) {
  return !user.is_premium;
}
