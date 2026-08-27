import OpenAI from 'openai';
import 'dotenv/config';

// Используем OpenRouter как прокси для Gemini — обходит региональный блок
// GEMINI_API_KEY = твой OpenRouter ключ sk-or-v1..., GEMINI_BASE_URL = https://openrouter.ai/api/v1
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL || 'https://openrouter.ai/api/v1',
});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'google/gemini-2.0-flash-lite-preview-02-05:free';

// Универсальный парсер: текст или аудио (base64) → JSON
export async function parseWithGemini({ text, audioBase64, audioMime = 'audio/ogg' }) {
  const system = `Ты — парсер для Flux. Верни ТОЛЬКО JSON без markdown.
Типы:
- expense: {"type":"expense","amount":number,"category":"еда|транспорт|жильё|развлечения|здоровье|прочее","note":string}
- income: {"type":"income","amount":number,"category":string,"note":string}
- calories: {"type":"calories","dish":string,"kcal":number,"protein":number,"fat":number,"carbs":number}
- note: {"type":"note","kind":"task|idea|note","title":string,"content":string}
- reminder: {"type":"reminder","text":string,"remind_at":"ISO8601"}
Если не распознал — {"type":"note","kind":"note","title":text,"content":""}
Категории расходов строго из списка. Сумму ищи как число. Дату парси как Europe/Moscow.`;

  // Если есть аудио — сначала транскрибируем через Whisper (надежнее чем Gemini audio через OpenRouter)
  // Логи в Railway показывали: Audio inp... 400 от Google AI Studio + 429 gemma-4-26b:free — прямой Gemini audio сломан
  if (audioBase64) {
    try {
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      // OpenRouter поддерживает openai/whisper-large-v3 и gpt-4o транскрибацию
      // Пробуем Whisper через OpenAI-совместимый endpoint
      const file = new File([audioBuffer], 'voice.ogg', { type: audioMime });
      const tr = await client.audio.transcriptions.create({
        model: 'openai/whisper-large-v3',
        file: file,
        language: 'ru',
      });
      const transcribed = tr.text?.trim();
      if (transcribed) {
        console.log('Whisper transcribed:', transcribed.slice(0,120));
        text = text ? `${text} ${transcribed}` : transcribed;
      }
    } catch (e) {
      console.warn('Whisper failed, fallback to Gemini input_audio:', e.message?.slice(0,200));
      // fallback — пробуем Gemini напрямую c input_audio (требует wav/mp3, не ogg)
      let userContent = [];
      if (text) userContent.push({ type: 'text', text });
      userContent.push({ type: 'text', text: 'Расшифруй аудио и спарси как JSON по системе.' });
      // костыль: заявляем mp3 — OpenRouter часто транскодит ogg->mp3 сам
      const fmt = audioMime.includes('wav') ? 'wav' : 'mp3';
      userContent.push({ type: 'input_audio', input_audio: { data: audioBase64, format: fmt } });
      try {
        const resp = await client.chat.completions.create({
          model: GEMINI_MODEL,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: userContent }
          ],
          temperature: 0.2,
          max_tokens: 800,
        });
        let raw = resp.choices[0]?.message?.content?.trim() || '{}';
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) raw = m[0];
        try { return JSON.parse(raw); } catch { return { type: 'note', kind: 'note', title: text||'заметка', content: raw }; }
      } catch (e2) {
        // если и это упало — все равно парсим text (хоть пустой)
        console.error('Gemini input_audio also failed:', e2.message?.slice(0,300));
      }
    }
  }

  let userContent = [];
  if (text) userContent.push({ type: 'text', text });

  const resp = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent }
    ],
    temperature: 0.2,
    max_tokens: 800,
  });
  let raw = resp.choices[0]?.message?.content?.trim() || '{}';
  // вытащить JSON из markdown если есть
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) raw = m[0];
  try { return JSON.parse(raw); } catch { return { type: 'note', kind: 'note', title: text||'заметка', content: raw }; }
}

export async function generateInsights({ transactions, calories, notes }) {
  const prompt = `На основе данных за 7 дней дай 3 коротких инсайта (до 15 слов каждый) в JSON {"insights":[string]}.
Транзакции: ${JSON.stringify(transactions.slice(0,30))}
Калории: ${JSON.stringify(calories.slice(0,30))}
Заметки: ${JSON.stringify(notes.slice(0,20))}`;
  const resp = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.5,
    max_tokens: 400,
  });
  let raw = resp.choices[0]?.message?.content || '{"insights":[]}';
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) raw = m[0];
  try { return JSON.parse(raw); } catch { return { insights: [] }; }
}
