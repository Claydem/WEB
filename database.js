import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const userLimit = 3;
export const queueLimit = 10;
export const historyLimit = 30;

const directory = resolve(process.env.DATA_DIR ?? 'data');
mkdirSync(directory, { recursive: true });
export const db = new DatabaseSync(resolve(directory, 'tasks.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    name TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    admin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES users(name),
    expires INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL REFERENCES users(name),
    size INTEGER NOT NULL,
    tolerance REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'Очікування',
    worker TEXT,
    result TEXT,
    error TEXT,
    createdAt INTEGER NOT NULL,
    startedAt INTEGER,
    finishedAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS jobs_by_user ON jobs(username, id DESC);
  CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status, id);
`);

db.prepare(`
  UPDATE jobs
  SET status = 'failed', stage = 'Зупинено', error = 'Сервер перезапустився під час обчислення.', finishedAt = ?
  WHERE status = 'running'
`).run(Date.now());

export function createJob(username, { size, tolerance }) {
  const userCount = db.prepare(`
    SELECT COUNT(*) AS count FROM jobs WHERE username = ? AND status IN ('queued', 'running')
  `).get(username).count;
  if (userCount >= userLimit) return { error: `Одночасно можна мати до ${userLimit} незавершених задач.` };

  const total = db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running')`).get().count;
  if (total >= queueLimit) return { error: 'Черга заповнена. Спробуйте згодом.' };

  const id = db.prepare('INSERT INTO jobs (username, size, tolerance, createdAt) VALUES (?, ?, ?, ?)')
    .run(username, size, tolerance, Date.now()).lastInsertRowid;
  db.prepare(`
    DELETE FROM jobs WHERE username = ? AND status NOT IN ('queued', 'running') AND id IN (
      SELECT id FROM jobs WHERE username = ? ORDER BY id DESC LIMIT -1 OFFSET ?
    )
  `).run(username, username, historyLimit);
  return { id };
}

export function listJobs(username) {
  return db.prepare(`
    SELECT id, size, tolerance, status, progress, stage, worker, error, createdAt, startedAt, finishedAt
    FROM jobs WHERE username = ? ORDER BY id DESC
  `).all(username);
}

export function queuedJobs() {
  return db.prepare(`SELECT id, size, tolerance FROM jobs WHERE status = 'queued' ORDER BY id`).all();
}

export function startJob(id, worker) {
  db.prepare(`UPDATE jobs SET status = 'running', stage = 'Запуск', worker = ?, startedAt = ? WHERE id = ?`)
    .run(worker, Date.now(), id);
}

export function updateJob(id, progress, stage) {
  db.prepare(`UPDATE jobs SET progress = ?, stage = ? WHERE id = ? AND status = 'running'`)
    .run(progress, stage, id);
}

export function finishJob(id, result) {
  db.prepare(`
    UPDATE jobs SET status = 'done', stage = 'Готово', progress = 100, result = ?, finishedAt = ?
    WHERE id = ? AND status = 'running'
  `).run(JSON.stringify(result), Date.now(), id);
}

export function failJob(id, message) {
  db.prepare(`
    UPDATE jobs SET status = 'failed', stage = 'Помилка', error = ?, finishedAt = ?
    WHERE id = ? AND status = 'running'
  `).run(message, Date.now(), id);
}

export function cancelJob(id, username) {
  return db.prepare(`
    UPDATE jobs SET status = 'cancelled', stage = 'Скасовано', finishedAt = ?
    WHERE id = ? AND username = ? AND status IN ('queued', 'running')
  `).run(Date.now(), id, username).changes > 0;
}

export function jobResult(id, username) {
  const row = db.prepare(`SELECT result FROM jobs WHERE id = ? AND username = ? AND status = 'done'`)
    .get(id, username);
  return row ? JSON.parse(row.result) : null;
}
