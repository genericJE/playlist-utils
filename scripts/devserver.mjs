import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const types = { '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };

createServer(async (req, res) => {
  const name = (req.url || '/').split('?')[0].replace(/^\/+/, '') || 'content.js';
  try {
    const body = await readFile(join(dist, name));
    const ext = name.slice(name.lastIndexOf('.'));
    res.writeHead(200, {
      'Content-Type': types[ext] || 'text/plain',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
}).listen(8787, '127.0.0.1', () => console.log('dev server on http://127.0.0.1:8787'));
