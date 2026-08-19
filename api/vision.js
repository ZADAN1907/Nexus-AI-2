
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
  // NOT: Google, Haziran 2026'dan itibaren yeni üretilen key'leri eski
  // "AIza..." formatından yeni "AQ...." (Auth key) formatına geçirdi.
  // Bu yeni key'ler x-goog-api-key HEADER'ı ile gönderildiğinde bazı
  // hesaplarda 401 ACCESS_TOKEN_TYPE_UNSUPPORTED hatası veriyor
  // (bilinen, Google tarafı bir sorun). Key'i header yerine ?key=
  // query param olarak göndermek bu durumda daha güvenilir çalışıyor.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  // Gemini bazen "model aşırı yüklü" anlamına gelen 503 (bazen 429) döner.
  // Bu geçici bir durumdur; birkaç kez, artan bekleme süreleriyle tekrar deneriz.
  const MAX_ATTEMPTS = 3;
  let geminiRes, data;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      geminiRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS) {
        res.status(502).json({ error: { message: "Gemini API'ye ulaşılamadı: " + (e?.message || 'ağ hatası') } });
        return;
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
      continue;
    }

    if (geminiRes.ok) {
      data = await geminiRes.json().catch(() => null);
      break;
    }

    const retryable = geminiRes.status === 503 || geminiRes.status === 429;
    if (retryable && attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, 700 * attempt)); // 700ms, 1400ms...
      continue;
    }

    data = await geminiRes.json().catch(() => null);
    res.status(geminiRes.status).json(
      data || { error: { message: 'Gemini API hatası (HTTP ' + geminiRes.status + '). Model şu an aşırı yüklü olabilir, birazdan tekrar deneyin.' } }
    );
    return;
  }

  // Gemini'nin cevabı zaten frontend'in beklediği şekilde
  // ({ candidates: [{ content: { parts: [{ text }] } }] }) — olduğu gibi ilet.
  res.status(200).json(data);
}
