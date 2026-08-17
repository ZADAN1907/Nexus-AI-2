// /api/vision.js
// Nexus AI frontend'i görsel yüklendiğinde bu endpoint'e zaten tam
// Gemini formatında bir istek atıyor: { contents: [{ parts: [...] }] }
// ve aynı formatta bir cevap bekliyor. Burada tek iş: isteği API key'i
// EKLEYEREK gerçek Gemini API'sine iletmek. Anahtar sadece bu sunucu
// tarafı kodda kalır, tarayıcıya hiç gönderilmez.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Sadece POST desteklenir.' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      error: { message: 'GEMINI_API_KEY ortam değişkeni ayarlanmamış. Vercel > Project Settings > Environment Variables kısmından ekleyin.' }
    });
    return;
  }

  const body = req.body;
  if (!body?.contents?.[0]?.parts) {
    res.status(400).json({ error: { message: 'Geçersiz istek gövdesi (contents[0].parts bekleniyordu).' } });
    return;
  }

  // "latest" takma adı Google tarafından en güncel stabil sürüme otomatik
  // yönlendirilir; model kaldırılır/değişirse GEMINI_MODEL env var'ı ile override edilebilir.
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  let geminiRes;
  try {
    geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    res.status(502).json({ error: { message: "Gemini API'ye ulaşılamadı: " + (e?.message || 'ağ hatası') } });
    return;
  }

  const data = await geminiRes.json().catch(() => null);

  if (!geminiRes.ok) {
    res.status(geminiRes.status).json(
      data || { error: { message: 'Gemini API hatası (HTTP ' + geminiRes.status + ')' } }
    );
    return;
  }

  // Gemini'nin cevabı zaten frontend'in beklediği şekilde
  // ({ candidates: [{ content: { parts: [{ text }] } }] }) — olduğu gibi ilet.
  res.status(200).json(data);
}
