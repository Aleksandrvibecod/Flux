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
// Для аудио: передаём как input_audio / audio_url — Gemini через OpenRouter понимает оба
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

  let userContent = [];
  if (text) userContent.push({ type: 'text', text });
  if (audioBase64) {
    userContent.push({ type: 'text', text: 'Расшифруй аудио и спарси как JSON по системе.' });
    // OpenRouter Gemini принимает аудио как base64 в image_url поле — пробуем оба варианта
    userContent.push({ type: 'image_url', image_url: { url: `data:${audioMime};base64,${audioBase64}` } });
  }
  if (userContent.length === 0) userContent = [{ type: 'text', text: 'пусто' }];

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
