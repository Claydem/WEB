import { solve } from './solver.js';
import { failJob, finishJob, queuedJobs, startJob, updateJob } from './database.js';

let active;

export function dispatch() {
  if (active) return;
  const [job] = queuedJobs();
  if (!job) return;

  const controller = new AbortController();
  active = { id: job.id, controller };
  startJob(job.id, 'server-1');
  solve(job, (progress, stage) => updateJob(job.id, progress, stage), controller.signal)
    .then(result => finishJob(job.id, result))
    .catch(error => failJob(job.id, error.message))
    .finally(() => {
      active = undefined;
      dispatch();
    });
}

export function stopJob(id) {
  if (active?.id === id) active.controller.abort();
}
