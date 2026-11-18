import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

export function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Очікується JSON.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on('data', chunk => {
      length += chunk.length;
      if (length <= 8192) chunks.push(chunk);
      else reject(new HttpError(413, 'Запит завеликий.'));
    });
    request.on('error', reject);
    request.on('end', () => {
      if (length > 8192) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Некоректний JSON.'));
      }
    });
  });
}

export async function serveFile(request, response, path) {
  const file = files.get(path);
  if (request.method !== 'GET' || !file) return false;
  const [name, type] = file;
  const content = await readFile(new URL(`./public/${name}`, import.meta.url));
  response.writeHead(200, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': 'no-cache',
  });
  response.end(content);
  return true;
}
