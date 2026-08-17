// /api/chat.js
// Nexus AI frontend'inin beklediği endpoint. Groq'un OpenAI-uyumlu
// /chat/completions endpoint'ine proxy yapar. API anahtarı burada,
// sunucu tarafında (Vercel environment variable) kalır — tarayıcıya
// hiçbir zaman gönderilmez.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Sadece POST desteklenir.' });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: 'GROQ_API_KEY ortam değişkeni ayarlanmamış. Vercel > Project Settings > Environment Variables kısmından ekleyin.'
    });
    return;
  }

  const { model, messages, temperature, max_tokens } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages alanı gerekli (dizi olmalı).' });
    return;
  }

  // Frontend'de tanımlı olmayan / artık aktif olmayan modeller gelirse
  // sessizce güncel bir Groq modeline düş.
  const ALLOWED_MODELS = new Set([
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768'
  ]);
  const safeModel = ALLOWED_MODELS.has(model) ? model : 'llama-3.3-70b-versatile';

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: safeModel,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.7,
        max_tokens: max_tokens || 4096,
        stream: true
      })
    });
  } catch (e) {
    res.status(502).json({ error: "Groq API'ye ulaşılamadı: " + (e?.message || 'ağ hatası') });
    return;
  }

  if (!groqRes.ok || !groqRes.body) {
    let detail = '';
    try { detail = await groqRes.text(); } catch (_) {}
    res.status(groqRes.status || 502).json({ error: 'Groq API hatası', detail });
    return;
  }

  // Frontend, "data: {...}\n\n" satırlarını ve sonunda "data: [DONE]" bekliyor.
  // Groq zaten tam olarak bu formatta stream ediyor, olduğu gibi aktarıyoruz.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const reader = groqRes.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    // İstemci bağlantıyı kapatmış olabilir, sessizce bitir.
  } finally {
    res.end();
  }
}
