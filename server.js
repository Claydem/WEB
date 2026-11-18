import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { currentUser, setupAdmin, signIn, signOut } from './auth.js';
import { activeJobs, cancelJob, createJob, jobResult, listJobs, queueLimit } from './database.js';
import { HttpError, json, readJson, serveFile } from './http.js';
import { dispatch, poolStatus, queueTimes, startQueue, stopJob, stopQueue } from './queue.js';
import { maxSize, minSize, validInput } from './solver.js';

async function handle(request, response) {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    const method = request.method;
    if (await serveFile(request, response, path)) return;
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (method === 'GET' && path === '/api/me') {
      return json(response, 200, { user: currentUser(request) });
    }
    if (method === 'POST' && (path === '/api/register' || path === '/api/login')) {
      const user = await signIn(request, response, await readJson(request), path === '/api/register');
      return json(response, 200, { user });
    }
    if (method === 'POST' && path === '/api/logout') {
      signOut(request, response);
      return json(response, 200, { ok: true });
    }

    const user = currentUser(request);
    if (!user && path.startsWith('/api/')) throw new HttpError(401, 'Увійдіть до свого облікового запису.');
    if (method === 'GET' && path === '/api/admin') {
      if (!user.admin) throw new HttpError(403, 'Потрібні права адміністратора.');
      return json(response, 200, { ...poolStatus(), jobs: activeJobs(), queueLimit });
    }
    if (method === 'GET' && path === '/api/jobs') {
      const times = queueTimes();
      const jobs = listJobs(user.name).map(job => ({ ...job, wait: times.get(job.id) }));
      return json(response, 200, { jobs });
    }
    if (method === 'POST' && path === '/api/jobs') {
      const input = await readJson(request);
      if (!validInput(input)) {
        throw new HttpError(400, `Вкажіть від ${minSize} до ${maxSize} невідомих і виберіть точність.`);
      }
      const job = createJob(user.name, input);
      if (job.error) throw new HttpError(429, job.error);
      dispatch();
      return json(response, 202, job);
    }

    const match = /^\/api\/jobs\/(\d{1,15})\/(result|cancel)$/.exec(path);
    if (match) {
      const id = Number(match[1]);
      if (method === 'GET' && match[2] === 'result') {
        const result = jobResult(id, user.name);
        if (!result) throw new HttpError(404, 'Результат недоступний.');
        return json(response, 200, result);
      }
      if (method === 'POST' && match[2] === 'cancel') {
        if (!cancelJob(id, user.name)) throw new HttpError(404, 'Задачу не знайдено або її вже завершено.');
        stopJob(id);
        dispatch();
        return json(response, 200, { ok: true });
      }
    }
    throw new HttpError(404, 'Сторінку не знайдено.');
  } catch (error) {
    if (!error.status) console.error(error);
    json(response, error.status ?? 500, { error: error.status ? error.message : 'Внутрішня помилка сервера.' });
  }
}

await setupAdmin();

const { TLS_CERT, TLS_KEY } = process.env;
if (Boolean(TLS_CERT) !== Boolean(TLS_KEY)) {
  throw new Error('Вкажіть обидва шляхи TLS_CERT і TLS_KEY.');
}
const server = TLS_CERT
  ? createHttpsServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, handle)
  : createServer(handle);
const port = Number(process.env.PORT ?? 3000);
server.listen(port, '127.0.0.1', () => {
  console.log(`http${TLS_CERT ? 's' : ''}://127.0.0.1:${server.address().port}`);
  startQueue();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    stopQueue();
    server.close();
  });
}
