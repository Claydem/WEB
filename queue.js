import { averageDuration, failJob, finishJob, queuedJobs, startJob, updateJob } from './database.js';
import { WorkerPool } from './workers.js';

const pool = new WorkerPool(dispatch);

export function startQueue() {
  pool.start();
}

export function dispatch() {
  const queued = queuedJobs();
  let pending = queued.length;
  for (const job of queued) {
    const worker = pool.next();
    if (!worker) break;
    pending--;
    startJob(job.id, worker.name);
    pool.run(worker, job, (progress, stage) => updateJob(job.id, progress, stage))
      .then(result => finishJob(job.id, result))
      .catch(error => failJob(job.id, error.message))
      .finally(() => pool.release(worker));
  }
  pool.scale(pending);
}

export function queueTimes() {
  const jobs = queuedJobs();
  if (jobs.length === 0) return new Map();

  const now = Date.now();
  const average = averageDuration();
  const slots = pool.availableIn(now, average);
  return new Map(jobs.map((job, index) => {
    slots.sort((a, b) => a - b);
    const seconds = Math.max(1, Math.ceil(slots[0] / 1000));
    slots[0] += average;
    return [job.id, { position: index + 1, seconds }];
  }));
}

export function poolStatus() {
  return pool.status();
}

export function stopJob(id) {
  pool.cancel(id);
}

export function stopQueue() {
  pool.close();
}
