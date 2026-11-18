import { createServer } from 'node:http';
import { HttpError, json, readJson, serveFile } from './http.js';
import { maxSize, minSize, solve, validInput } from './solver.js';

let busy = false;

const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (await serveFile(request, response, path)) return;
    if (request.method === 'POST' && path === '/api/solve') {
      const input = await readJson(request);
      if (!validInput(input)) {
        throw new HttpError(400, `Вкажіть від ${minSize} до ${maxSize} невідомих і виберіть точність.`);
      }
      if (busy) throw new HttpError(429, 'Сервер уже виконує задачу.');
      busy = true;
      const controller = new AbortController();
      response.once('close', () => controller.abort());
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
      const write = value => response.write(JSON.stringify(value) + '\n');
      try {
        const result = await solve(input, (progress, stage) => write({ progress, stage }), controller.signal);
        write({ result });
      } catch (error) {
        if (!controller.signal.aborted) write({ error: error.message });
      } finally {
        busy = false;
        response.end();
      }
      return;
    }
    throw new HttpError(404, 'Сторінку не знайдено.');
  } catch (error) {
    json(response, error.status ?? 500, { error: error.status ? error.message : 'Внутрішня помилка сервера.' });
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
