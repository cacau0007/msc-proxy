const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

const MSC_HEADERS = {
  'accept': 'application/json, text/plain, */*',
  'content-type': 'application/json',
  'origin': 'https://www.msc.com',
  'referer': 'https://www.msc.com/en/search-a-schedule',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'x-requested-with': 'XMLHttpRequest'
};

app.get('/api/schedules', async (req, res) => {
  try {
    const { fromPortId, toPortId, fromDate } = req.query;
    if (!fromPortId || !toPortId) return res.status(400).json({ error: 'missing params' });
    const r = await fetch('https://www.msc.com/api/feature/tools/SearchSailingRoutes', {
      method: 'POST',
      headers: MSC_HEADERS,
      body: JSON.stringify({
        FromDate: fromDate || new Date().toISOString().split('T')[0],
        fromPortId: parseInt(fromPortId),
        toPortId: parseInt(toPortId),
        language: 'pt-BR',
        dataSourceId: '{E9CCBD25-6FBA-4C5C-85F6-FC4F9E5A931F}'
      })
    });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ports', async (req, res) => {
  try {
    const { search } = req.query;
    if (!search) return res.status(400).json({ error: 'missing search' });
    const r = await fetch('https://www.msc.com/api/feature/tools/SearchLocations?term=' + encodeURIComponent(search) + '&language=pt-BR', { headers: MSC_HEADERS });
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log('Rodando na porta ' + PORT));
