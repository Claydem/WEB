import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { maxTime } from './solver.js';

const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
const minWorkers = 2;

export class WorkerPool {
  workers = [];
  closed = false;
  sequence = 0;
  key = randomBytes(24).toString('hex');

  constructor(onReady) {
    this.onReady = onReady;
  }

  start() {
    if (this.closed) return;
    while (this.workers.length < minWorkers) this.spawn();
  }

  spawn() {
    let number = 1;
    while (this.workers.some(worker => worker.name === 'server-' + number)) number++;
    const child = fork(workerFile, {
      env: { ...process.env, WORKER_KEY: this.key, ADMIN_PASSWORD: '' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker = { name: 'server-' + number, child, port: 0, lastUsed: 0, active: null };
    this.workers.push(worker);
    const startup = setTimeout(() => child.kill(), 5000);

    child.on('message', message => {
      if (this.closed || !message.port) return;
      clearTimeout(startup);
      worker.port = message.port;
      this.onReady();
    });
    child.on('error', error => console.error(worker.name, error.message));
    child.on('exit', () => { worker.port = 0; });
    child.once('close', () => {
      clearTimeout(startup);
      this.workers.splice(this.workers.indexOf(worker), 1);
      if (!this.closed) setTimeout(() => this.start(), 500).unref();
    });
  }

  next() {
    if (this.closed) return undefined;
    return this.workers.filter(worker => worker.port && !worker.active)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
  }

  async run(worker, job, report) {
    const controller = new AbortController();
    worker.active = { id: job.id, controller };
    worker.lastUsed = ++this.sequence;
    const url = `http://127.0.0.1:${worker.port}/run/${job.id}`;
    const authorization = 'Bearer ' + this.key;
    const cancel = () => {
      fetch(url, {
        method: 'DELETE',
        headers: { authorization },
        signal: AbortSignal.timeout(2000),
      }).catch(() => {
        if (worker.active?.id !== job.id) return;
        worker.port = 0;
        worker.child.kill();
      });
    };

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: job.size, tolerance: job.tolerance }),
        signal: AbortSignal.timeout(maxTime + 5000),
      });
      if (!response.ok) throw new Error((await response.json()).error);
      if (controller.signal.aborted) cancel();
      else controller.signal.addEventListener('abort', cancel, { once: true });

      const lines = createInterface({ input: Readable.fromWeb(response.body), crlfDelay: Infinity });
      let terminal;
      for await (const line of lines) {
        const event = JSON.parse(line);
        if (event.progress !== undefined) report(event.progress, event.stage);
        else terminal = event;
      }
      if (terminal?.result) return terminal.result;
      if (terminal?.error) throw new Error(terminal.error);
      throw new Error('Сервер завершив з’єднання.');
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError' || !worker.port || error instanceof TypeError) {
        worker.port = 0;
        worker.child.kill();
        throw new Error('Сервер обчислень не відповів.');
      }
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  release(worker) {
    worker.active = null;
    if (!this.closed) this.onReady();
  }

  cancel(id) {
    this.workers.find(worker => worker.active?.id === id)?.active.controller.abort();
  }

  close() {
    this.closed = true;
    for (const worker of this.workers) worker.child.kill();
  }
}
