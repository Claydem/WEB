import { failJob, finishJob, queuedJobs, startJob, updateJob } from './database.js';
import { WorkerPool } from './workers.js';

const pool = new WorkerPool(dispatch);

export function startQueue() {
  pool.start();
}

export function dispatch() {
  for (const job of queuedJobs()) {
    const worker = pool.next();
    if (!worker) break;
    startJob(job.id, worker.name);
    pool.run(worker, job, (progress, stage) => updateJob(job.id, progress, stage))
      .then(result => finishJob(job.id, result))
      .catch(error => failJob(job.id, error.message))
      .finally(() => pool.release(worker));
  }
}

export function stopJob(id) {
  pool.cancel(id);
}

export function stopQueue() {
  pool.close();
}
