const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/api/schedules', async (req, res) => {
  try {
    const { fromPortId, toPortId, fromDate } = req.query;
    if (!fromPortId || !toPortId) {
      return res.status(400).json({ error: 'fromPortId e toPortId são obrigatórios' });
    }
    const response = await fetch('https://www.msc.com/api/feature/tools/SearchSailingRoutes', {
      method: 'POST',
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/json',
        'origin': 'https://www.msc.com',
        'referer': 'https://www.msc.com/en/search-a-schedule',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'x-requested-with': 'XMLHttpRequest'
      },
      body: JSON.stringify({
        FromDate: fromDate || new Date().toISOString().split('T')[0],
        fromPortId: parseInt(fromPortId),
        toPortId: parseInt(toPortId),
        language: 'pt-BR',
        dataSourceId: '{E9CCBD25-6FBA-4C5C-85F6-FC4F9E5A931F}'
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MSC Schedule Proxy' });
});

app.listen(PORT, () => {
  console.log(`MSC Proxy rodando na porta ${PORT}`);
});
