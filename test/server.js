// Мок бэкенда по тому же контракту, что в промпте.
const http = require('http');
let doc = { updated_at: 0, lines: [] };
http.createServer((req, res) => {
  if (req.headers['x-api-key'] !== 'test-key') { res.writeHead(401); return res.end('{"error":"bad key"}'); }
  if (req.method === 'GET') { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(JSON.stringify(doc)); }
  let b=''; req.on('data', c => b += c); req.on('end', () => {
    const d = JSON.parse(b);
    if (d.updated_at > doc.updated_at) doc = d;
    console.log('POST', d.lines.length, 'lines');
    res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok: true, updated_at: doc.updated_at }));
  });
}).listen(8787, () => console.log('mock on 8787'));
