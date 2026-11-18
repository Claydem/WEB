import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { maxTime } from './solver.js';

const workerFile = fileURLToPath(new URL('./worker.js', import.meta.url));
const minWorkers = 2;
const maxWorkers = 4;
const idleLimit = 30_000;

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
    this.timer ??= setInterval(() => this.trim(), 1000).unref();
  }

  spawn() {
    let number = 1;
    while (this.workers.some(worker => worker.name === 'server-' + number)) number++;
    const child = fork(workerFile, {
      env: { ...process.env, WORKER_KEY: this.key, ADMIN_PASSWORD: '' },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const worker = {
      name: 'server-' + number,
      child,
      port: 0,
      lastUsed: 0,
      idleSince: Date.now(),
      active: null,
      stopping: false,
      cpu: null,
      memory: null,
    };
    this.workers.push(worker);
    const startup = setTimeout(() => this.retire(worker), 5000);

    child.on('message', message => {
      if (this.closed || worker.stopping) return;
      if (message.port) {
        clearTimeout(startup);
        worker.port = message.port;
        worker.idleSince = Date.now();
        this.onReady();
      } else {
        worker.cpu = message.cpu;
        worker.memory = message.memory;
      }
    });
    child.on('error', error => console.error(worker.name, error.message));
    child.on('exit', () => {
      worker.port = 0;
      worker.stopping = true;
    });
    child.once('close', () => {
      clearTimeout(startup);
      this.workers.splice(this.workers.indexOf(worker), 1);
      if (!this.closed) setTimeout(() => this.start(), 500).unref();
    });
  }

  scale(pending) {
    if (this.closed) return;
    const starting = this.workers.filter(worker => !worker.port && !worker.stopping).length;
    const extra = Math.min(pending - starting, maxWorkers - this.workers.length);
    for (let i = 0; i < extra; i++) this.spawn();
  }

  trim() {
    const cutoff = Date.now() - idleLimit;
    for (const worker of this.workers.slice(minWorkers)) {
      if (worker.port && !worker.active && worker.idleSince < cutoff) this.retire(worker);
    }
  }

  retire(worker) {
    worker.stopping = true;
    worker.port = 0;
    worker.child.kill();
  }

  availableIn(now, average) {
    const slots = this.workers.filter(worker => !worker.stopping).map(worker => {
      if (worker.active) return Math.max(1000, average - (now - worker.active.started));
      return worker.port ? 0 : 1000;
    });
    return slots.length ? slots : [1000];
  }

  status() {
    return {
      min: minWorkers,
      max: maxWorkers,
      workers: this.workers.map(worker => ({
        name: worker.name,
        pid: worker.child.pid,
        state: worker.stopping ? 'stopping' : !worker.port ? 'starting' : worker.active ? 'busy' : 'idle',
        jobId: worker.active?.id ?? null,
        cpu: worker.cpu,
        memory: worker.memory,
      })),
    };
  }

  next() {
    if (this.closed) return undefined;
    return this.workers.filter(worker => worker.port && !worker.active)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
  }

  async run(worker, job, report) {
    const controller = new AbortController();
    worker.active = { id: job.id, controller, started: Date.now() };
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
        this.retire(worker);
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
        this.retire(worker);
        throw new Error('Сервер обчислень не відповів.');
      }
      throw error;
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }
  }

  release(worker) {
    worker.active = null;
    worker.idleSince = Date.now();
    if (!this.closed) this.onReady();
  }

  cancel(id) {
    this.workers.find(worker => worker.active?.id === id)?.active.controller.abort();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const worker of this.workers) this.retire(worker);
  }
}
