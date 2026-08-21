// /api/vision.js
// Nexus AI frontend'i görsel yüklendiğinde bu endpoint'e Gemini formatında
// bir istek atıyor: { contents: [{ parts: [...] }] } ve aynı formatta
// ({ candidates: [{ content: { parts: [{ text }] } }] }) bir cevap bekliyor.
//
// Gemini API sürekli hata verdiği (503/429/ACCESS_TOKEN_TYPE_UNSUPPORTED vb.)
// için görsel analizi artık GROQ'un multimodal (vision) modeline yapılıyor.
// Frontend HİÇ değişmedi: burada tek iş, gelen Gemini-şekilli isteği Groq'un
// OpenAI-uyumlu chat/completions formatına çevirmek, Groq'a atmak ve dönen
// cevabı tekrar Gemini şekline sarıp frontend'e iletmek.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Sadece POST desteklenir.' } });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: 'GROQ_API_KEY ortam değişkeni ayarlanmamış. Vercel > Project Settings > Environment Variables kısmından ekleyin.' }
    });
    return;
  }

  const body = req.body;
  const parts = body?.contents?.[0]?.parts;
  if (!Array.isArray(parts)) {
    res.status(400).json({ error: { message: 'Geçersiz istek gövdesi (contents[0].parts bekleniyordu).' } });
    return;
  }

  const imagePart = parts.find(p => p?.inline_data?.data);
  const textPart = parts.find(p => typeof p?.text === 'string');

  if (!imagePart) {
    res.status(400).json({ error: { message: 'Görsel verisi bulunamadı (inline_data.data bekleniyordu).' } });
    return;
  }

  const mimeType = imagePart.inline_data.mime_type || 'image/jpeg';
  const base64 = imagePart.inline_data.data;
  const promptText = textPart?.text || 'Bu görseli Türkçe olarak ayrıntılı biçimde analiz et.';

  // Groq'un vision destekleyen modelleri. Birincisi kota/limit ya da
  // deprecation nedeniyle hata verirse ikincisine düşülür.
  const VISION_MODELS = [
    process.env.GROQ_VISION_MODEL,
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'meta-llama/llama-4-maverick-17b-128e-instruct'
  ].filter(Boolean);

  const groqBody = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]
      }
    ],
    temperature: 0.4,
    max_tokens: 2048
  };

  let lastErr = null;

  for (const model of VISION_MODELS) {
    let groqRes;
    try {
      groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({ ...groqBody, model })
      });
    } catch (e) {
      lastErr = "Groq API'ye ulaşılamadı: " + (e?.message || 'ağ hatası');
      continue;
    }

    if (!groqRes.ok) {
      let detail = '';
      try { detail = (await groqRes.json())?.error?.message || ''; } catch (_) {}
      lastErr = `Groq görsel analizi başarısız (${model}, HTTP ${groqRes.status})${detail ? ': ' + detail : ''}`;
      // Model kaldırılmış/geçersizse ya da aşırı yüklüyse sıradaki modele geç.
      if ([400, 404, 429, 503].includes(groqRes.status)) continue;
      break;
    }

    const data = await groqRes.json().catch(() => null);
    const text = data?.choices?.[0]?.message?.content;
    if (!text) {
      lastErr = `Groq boş yanıt döndürdü (${model}).`;
      continue;
    }

    // Frontend'in beklediği Gemini-şekilli cevap.
    res.status(200).json({
      candidates: [
        { content: { parts: [{ text }] } }
      ]
    });
    return;
  }

  res.status(502).json({
    error: { message: lastErr || 'Görsel analiz edilemedi.' }
  });
}
