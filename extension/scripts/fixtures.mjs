import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('../tests/fixtures');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
http.createServer(async (req, res) => {
  // Simulated agent endpoint for investigation runs (the real tunnel is down,
  // or the run must be deterministic). Mirrors the reported model latency
  // (39–41 s) and answers with a valid finish plan over the production wire
  // shape ({ response: { thought, output } }).
  if (req.method === 'POST' && req.url === '/agent') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const delayMs = Number(new URL(req.url, 'http://localhost').searchParams.get('delayMs')) || 50_000;
    const linkMatch = /id=(\S+) role=link/.exec(body.page_info ?? '');
    const observation = /Observation (\S+?)\./.exec(body.page_info ?? '')?.[1] ?? '';
    // Element ids are minted as `${observationId}_e${n}`; rebuild the full id
    // for the first link so the reply passes the panel's plan validation.
    const suffix = linkMatch ? /_e\d+$/.exec(linkMatch[1])?.[0] ?? '_e1' : '_e1';
    const firstLink = observation ? `${observation}${suffix}` : linkMatch?.[1] ?? 'e1';
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: {
          thought: `Simulated model after ${delayMs} ms of thinking; clicking the first course link.`,
          output: [{ action: 'click', id: firstLink, className: null, xpath: null, value: null }],
        },
      }));
    }, delayMs);
    return;
  }
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!file.startsWith(root + sep)) throw new Error('Invalid path');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1', () => console.log('Synthetic portal: http://127.0.0.1:4173'));
