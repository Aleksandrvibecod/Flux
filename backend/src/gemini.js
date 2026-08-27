import OpenAI, { toFile } from 'openai';
import 'dotenv/config';

// Используем OpenRouter как прокси для Gemini — обходит региональный блок
// GEMINI_API_KEY = твой OpenRouter ключ sk-or-v1..., GEMINI_BASE_URL = https://openrouter.ai/api/v1
const client = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GEMINI_BASE_URL || 'https://openrouter.ai/api/v1',
});
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'google/gemini-2.5-flash';

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
  // Логи в Railway показывали: Audio inp... 400 от Google AI Studio + 429 gemma — прямой Gemini audio на ogg сломан
  if (audioBase64) {
    let transcribed = null;
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    // Пробуем несколько Whisper-моделей OpenRouter (ogg поддерживает)
    const whisperModels = ['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3', 'openai/whisper-1'];
    for (const m of whisperModels) {
      try {
        const file = await toFile(audioBuffer, 'voice.ogg', { type: audioMime || 'audio/ogg' });
        const tr = await client.audio.transcriptions.create({ model: m, file, language: 'ru' });
        transcribed = tr.text?.trim();
        if (transcribed) { console.log(`Whisper ${m} ok:`, transcribed.slice(0,120)); break; }
      } catch (e) {
        const meta = e.error?.error?.message || e.message || String(e);
        console.warn(`Whisper ${m} failed:`, JSON.stringify(e.error || meta).slice(0,500));
        // если 400 с первой моделью — пробуем следующую
      }
    }
    if (transcribed) {
      text = text ? `${text} ${transcribed}` : transcribed;
    } else {
      // fallback — пробуем Gemini напрямую c input_audio (требует wav/mp3, ogg часто 400)
      // Конвертировать ogg->wav без ffmpeg нельзя, поэтому пробуем заявить как mp3 — иногда OpenRouter транскодит
      console.warn('All Whisper failed, trying Gemini input_audio fallback');
      let userContent = [];
      if (text) userContent.push({ type: 'text', text });
      userContent.push({ type: 'text', text: 'Расшифруй аудио и спарси как JSON по системе.' });
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
        const mm = raw.match(/\{[\s\S]*\}/);
        if (mm) raw = mm[0];
        try { return JSON.parse(raw); } catch { return { type: 'note', kind: 'note', title: text||'заметка', content: raw }; }
      } catch (e2) {
        console.error('Gemini input_audio also failed:', JSON.stringify(e2.error || e2.message).slice(0,800));
        // бросаем исходную ошибку Whisper с деталями чтобы фронт показал реальную причину, а не generic 400
        throw e2;
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

export async function parseReceiptImage({ imageBase64, mime = 'image/jpeg' }) {
  const system = `Ты — OCR парсер чеков. Верни ТОЛЬКО JSON. Формат: {"type":"receipt","items":[{"name":string,"amount":number}],"total":number,"shop":string}
Если чек не читается — {"type":"note","kind":"note","title":"чек не распознан","content":""}`;
  const res = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: 'Распознай чек, вытащи все позиции и итог.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }
      ] }
    ],
    temperature: 0.1,
    max_tokens: 1000,
  });
  let raw = res.choices[0]?.message?.content?.trim() || '{}';
  const m = raw.match(/\{[\s\S]*\}/); if (m) raw = m[0];
  try { return JSON.parse(raw); } catch { return { type:'note', kind:'note', title:'чек', content: raw }; }
}

export async function parseFoodImage({ imageBase64, mime = 'image/jpeg' }) {
  const system = `Ты — диетолог. По фото блюда оцени КБЖУ. Верни ТОЛЬКО JSON: {"type":"calories","dish":string,"kcal":number,"protein":number,"fat":number,"carbs":number,"weight":number}
Если не еда — {"type":"note","kind":"note","title":"не еда","content":""}`;
  const res = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: [
        { type: 'text', text: 'Оцени блюдо на фото, дай КБЖУ.' },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}` } }
      ] }
    ],
    temperature: 0.3,
    max_tokens: 600,
  });
  let raw = res.choices[0]?.message?.content?.trim() || '{}';
  const m = raw.match(/\{[\s\S]*\}/); if (m) raw = m[0];
  try { return JSON.parse(raw); } catch { return { type:'note', kind:'note', title:'еда', content: raw }; }
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
