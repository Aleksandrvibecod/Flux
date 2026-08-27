import { supabase, getOrCreateUser, canUseVoice, incVoice, canUseMessage, incMessage } from './supabase.js';

// ...

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

  // ... дальше как было
  const parsed = await parseWithGemini({ text, audioBase64, audioMime });
  if (isAudio) await incVoice(user);
  else await incMessage(user);  }
  return (user.message_used_today || 0) < 5;
}

export async function incMessage(user) {
  if (user.is_premium) return;
  await supabase.from('users').update({ message_used_today: (user.message_used_today||0)+1 }).eq('id', user.id);
}

export async function incVoice(user) {
  if (user.is_premium) return;
  await supabase.from('users').update({ voice_used_today: (user.voice_used_today||0)+1 }).eq('id', user.id);
}

export async function isHistoryLimited(user) {
  return !user.is_premium;
}
