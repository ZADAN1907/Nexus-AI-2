// /api/search.js
// Nexus AI'nin web arama özelliği eskiden tamamen TARAYICI tarafında,
// halka açık SearXNG instance'larına ve ücretsiz CORS proxy'lerine
// (corsproxy.io, allorigins.win, codetabs...) doğrudan bağlanmaya
// çalışıyordu. Bu proxy'ler/instance'lar sürekli değişiyor, kapanıyor,
// CORS header'ı vermiyor ya da DNS çözülmüyor -> ERR_CONNECTION_RESET,
// ERR_NAME_NOT_RESOLVED, "blocked by CORS policy" hataları.
//
// Çözüm: aynı işi burada, SUNUCU tarafında yapmak. Node'dan atılan
// bir fetch, hedef siteye server-to-server bağlanır; CORS tarayıcıya
// özgü bir kural olduğu için burada hiç devreye girmez.

const TIMEOUT_MS = 8000;

function fetchWithTimeout(url, ms, init) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(t));
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function normalizeUrlKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname).replace(/\/$/, '').toLowerCase();
  } catch (e) {
    return url;
  }
}

function dedupeResults(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || !r.url || !r.title) continue;
    const key = normalizeUrlKey(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------- SEARXNG (JSON API, sunucudan) ----------
const SEARXNG_INSTANCES = [
  'https://searx.bndkt.io',
  'https://search.im-in.space',
  'https://search.indst.eu',
  'https://ooglester.com',
  'https://search.hbubli.cc',
  'https://priv.au',
  'https://searx.be',
  'https://nyc1.sx.ggtyler.dev'
];

function parseSearXNGJson(data) {
  return (data?.results || []).slice(0, 8).map(r => ({
    title: decodeHtmlEntities((r.title || 'Kaynak').trim()).substring(0, 100),
    url: r.url,
    snippet: decodeHtmlEntities((r.content || '').trim()).substring(0, 320),
    source: 'SearXNG' + (r.engine ? ` (${r.engine})` : '')
  })).filter(r => r.url && r.title);
}

async function searchSearXNG(query, timeoutMs) {
  const q = encodeURIComponent(query);
  const attempts = SEARXNG_INSTANCES.map(base =>
    fetchWithTimeout(`${base}/search?q=${q}&format=json&language=auto`, timeoutMs, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusAI/1.0)' }
    }).then(async r => {
      if (!r.ok) throw new Error('http ' + r.status);
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('json değil');
      const results = parseSearXNGJson(await r.json());
      if (results.length === 0) throw new Error('sonuç yok');
      return results;
    })
  );
  try { return await Promise.any(attempts); } catch (e) { return []; }
}

// ---------- Wikipedia ----------
async function searchWikipedia(query, lang, timeoutMs) {
  try {
    const q = encodeURIComponent(query);
    const r = await fetchWithTimeout(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${q}&format=json&origin=*&srlimit=3`,
      timeoutMs
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data?.query?.search || []).map(s => ({
      title: s.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(s.title.replace(/ /g, '_'))}`,
      snippet: decodeHtmlEntities((s.snippet || '').replace(/<[^>]+>/g, '')).substring(0, 320),
      source: 'Wikipedia'
    }));
  } catch (e) { return []; }
}

// ---------- DuckDuckGo Instant Answer ----------
async function searchDuckDuckGoIA(query, timeoutMs) {
  try {
    const q = encodeURIComponent(query);
    const r = await fetchWithTimeout(`https://api.duckduckgo.com/?q=${q}&format=json&t=nexusai&no_html=1`, timeoutMs);
    if (!r.ok) return [];
    const data = await r.json();
    const out = [];
    if (data.AbstractText?.length > 50) {
      out.push({ title: data.Heading || 'Özet', url: data.AbstractURL || `https://duckduckgo.com/?q=${q}`, snippet: data.AbstractText.substring(0, 300), source: 'DuckDuckGo' });
    }
    (data.RelatedTopics || []).slice(0, 3).forEach(t => {
      if (t.Text && t.FirstURL) out.push({ title: t.Text.split(' - ')[0]?.substring(0, 60) || 'Kaynak', url: t.FirstURL, snippet: t.Text.substring(0, 250), source: 'DuckDuckGo' });
    });
    return out;
  } catch (e) { return []; }
}

// ---------- GitHub repo arama ----------
async function searchGitHub(query, timeoutMs) {
  try {
    const r = await fetchWithTimeout(
      'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&order=desc&per_page=4',
      timeoutMs,
      { headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'NexusAI' } }
    );
    if (!r.ok) return [];
    const data = await r.json();
    return (data.items || []).map(repo => ({
      title: repo.full_name + (repo.stargazers_count ? ` ⭐${repo.stargazers_count}` : ''),
      url: repo.html_url,
      snippet: decodeHtmlEntities(repo.description || 'Açıklama yok').substring(0, 300) + (repo.language ? ` [${repo.language}]` : ''),
      source: 'GitHub'
    }));
  } catch (e) { return []; }
}

// ---------- Sayfa tam metni (basit, dependency-free HTML->metin) ----------
function htmlToText(html) {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|header|footer|aside|noscript|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  out = decodeHtmlEntities(out);
  out = out.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return out;
}

async function fetchPageFullText(url, timeoutMs) {
  try {
    const r = await fetchWithTimeout(url, timeoutMs, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NexusAI/1.0)' }
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('text/html')) return null;
    const html = await r.text();
    if (!html || html.length < 200) return null;
    const text = htmlToText(html);
    if (!text || text.length < 150) return null;
    return text.substring(0, 4000);
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Sadece POST desteklenir.' });
    return;
  }

  const { query, language, deepRead } = req.body || {};
  if (!query || typeof query !== 'string') {
    res.status(400).json({ error: 'query alanı gerekli.' });
    return;
  }

  const wikiLang = language === 'tr' ? 'tr' : 'en';

  const [searxngRes, wikiRes, ddgIaRes, githubRes] = await Promise.all([
    searchSearXNG(query, TIMEOUT_MS),
    searchWikipedia(query, wikiLang, TIMEOUT_MS),
    searchDuckDuckGoIA(query, TIMEOUT_MS),
    searchGitHub(query, TIMEOUT_MS)
  ]);

  let results = dedupeResults([...searxngRes, ...githubRes, ...wikiRes, ...ddgIaRes]);

  if (results.length === 0) {
    res.status(200).json({
      results: [{
        title: 'Arama sonucu bulunamadı',
        url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}`,
        snippet: `"${query}" için arama motorunda sonuçları görüntülemek üzere tıklayın.`,
        source: '—'
      }]
    });
    return;
  }

  results = results.slice(0, 8);

  if (deepRead !== false) {
    const deepReadCandidates = results.filter(r => (r.source || '').startsWith('SearXNG') || r.source === 'GitHub').slice(0, 3);
    await Promise.all(deepReadCandidates.map(async r => {
      const text = await fetchPageFullText(r.url, 9000);
      if (text) r.fullText = text;
    }));
  }

  res.status(200).json({ results });
}
