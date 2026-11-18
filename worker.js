import { createServer } from 'node:http';
import { HttpError, json, readJson } from './http.js';
import { solve, validInput } from './solver.js';

const secret = process.env.WORKER_KEY;
if (!secret || !process.send) process.exit(1);
let active;

const server = createServer(async (request, response) => {
  try {
    if (request.headers.authorization !== 'Bearer ' + secret) {
      throw new HttpError(403, 'Доступ заборонено.');
    }
    const route = /^\/run\/(\d+)$/.exec(request.url);
    if (!route) throw new HttpError(404, 'Запит не знайдено.');
    const id = Number(route[1]);

    if (request.method === 'DELETE') {
      if (active?.id === id) active.controller.abort();
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== 'POST') throw new HttpError(405, 'Метод не підтримується.');
    const input = await readJson(request);
    if (!validInput(input)) throw new HttpError(400, 'Некоректні параметри задачі.');
    if (active) throw new HttpError(409, 'Сервер зайнятий.');

    const controller = new AbortController();
    active = { id, controller };
    response.once('close', () => controller.abort());
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    response.flushHeaders();

    const write = value => response.write(JSON.stringify(value) + '\n');
    let terminal;
    try {
      const result = await solve(input, (progress, stage) => {
        if (progress < 100) write({ progress, stage });
      }, controller.signal);
      terminal = { result };
    } catch (error) {
      terminal = { error: controller.signal.aborted ? 'Задачу скасовано.' : error.message };
    } finally {
      active = undefined;
      if (!response.destroyed) response.end(JSON.stringify(terminal) + '\n');
    }
  } catch (error) {
    json(response, error.status ?? 500, { error: error.status ? error.message : 'Помилка сервера обчислень.' });
  }
});

server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));

let usage = process.cpuUsage();
let sampledAt = performance.now();
setInterval(() => {
  if (!process.connected) return;
  const now = performance.now();
  const current = process.cpuUsage();
  const delta = current.user - usage.user + current.system - usage.system;
  const cpu = Math.min(100, Math.round(delta / (now - sampledAt) / 10));
  process.send({ cpu, memory: Math.round(process.memoryUsage.rss() / 1024 / 1024) });
  usage = current;
  sampledAt = now;
}, 1000).unref();

process.once('disconnect', () => process.exit());
