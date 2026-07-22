// api/proxy-sheets.js

export default async function handler(req, res) {
  // อนุญาตเฉพาะ POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const WEB_APP_URL = process.env.GAS_WEB_APP_URL;

  if (!WEB_APP_URL) {
    return res.status(500).json({ error: 'GAS_WEB_APP_URL is not configured' });
  }

  try {
    const gasResponse = await fetch(WEB_APP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(req.body),
    });

    const data = await gasResponse.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Proxy to Apps Script failed:', err);
    return res.status(502).json({ error: 'Failed to reach Google Apps Script', detail: err.message });
  }
}
