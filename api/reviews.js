// Reviews API for javar-tattoo.vercel.app
// Storage: Upstash Redis (Vercel Marketplace). Uses the REST API, no npm packages needed.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'javar:reviews';

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error('storage ' + r.status);
  return r.json();
}

function clean(s, max) {
  return String(s || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function summary(list) {
  const n = list.length;
  const avg = n ? list.reduce((a, r) => a + r.rating, 0) / n : 0;
  return { count: n, average: Math.round(avg * 10) / 10 };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'not_configured' });
  try {
    if (req.method === 'GET') {
      const out = await redis([['LRANGE', KEY, '0', '199']]);
      const list = (out[0].result || []).map(x => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean);
      return res.status(200).json({ ...summary(list), reviews: list.slice(0, 60) });
    }
    if (req.method === 'POST') {
      let b = req.body;
      if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
      b = b || {};
      if (b.website) return res.status(200).json({ ok: true }); // honeypot: silently ignore bots
      const rating = parseInt(b.rating, 10);
      const name = clean(b.name, 60);
      const text = clean(b.text, 1000);
      if (!(rating >= 1 && rating <= 5) || name.length < 2 || text.length < 5) {
        return res.status(400).json({ error: 'invalid' });
      }
      const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
      const rl = await redis([['SET', 'javar:rl:' + ip, '1', 'NX', 'EX', '120']]);
      if (rl[0].result !== 'OK') return res.status(429).json({ error: 'slow_down' });
      const review = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), rating, name, text, date: new Date().toISOString() };
      await redis([['LPUSH', KEY, JSON.stringify(review)], ['LTRIM', KEY, '0', '499']]);
      return res.status(201).json({ ok: true, review });
    }
    if (req.method === 'DELETE') {
      // Remove a review: DELETE /api/reviews?id=<id> with header x-admin-key: <ADMIN_KEY>
      if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'unauthorized' });
      const id = String((req.query && req.query.id) || '');
      const out = await redis([['LRANGE', KEY, '0', '499']]);
      const raw = (out[0].result || []).find(x => { try { return JSON.parse(x).id === id; } catch (e) { return false; } });
      if (!raw) return res.status(404).json({ error: 'not_found' });
      await redis([['LREM', KEY, '1', raw]]);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'GET, POST, DELETE');
    return res.status(405).json({ error: 'method' });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
};
