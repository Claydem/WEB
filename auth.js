import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './database.js';
import { HttpError } from './http.js';

const deriveKey = promisify(scrypt);
const sessionSeconds = 86_400;

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const key = await deriveKey(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function readToken(request) {
  return request.headers.cookie?.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function writeCookie(request, response, token, age) {
  const secure = request.socket.encrypted ? '; Secure' : '';
  response.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`);
}

export function currentUser(request) {
  const token = readToken(request);
  if (!token) return null;
  return db.prepare(`
    SELECT users.name, users.admin FROM users JOIN sessions ON users.name = sessions.username
    WHERE sessions.token = ? AND sessions.expires > ?
  `).get(tokenHash(token), Date.now()) ?? null;
}

export async function signIn(request, response, details, register) {
  const name = typeof details?.name === 'string' ? details.name.trim().toLowerCase() : '';
  const password = details?.password;
  if (!/^[a-z0-9_-]{3,24}$/.test(name) || typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, 'Логін має містити 3–24 латинські літери, цифри, дефіс або підкреслення. Пароль має містити 8–128 символів.');
  }

  const user = db.prepare('SELECT name, password, admin FROM users WHERE name = ?').get(name);
  if (register) {
    if (user) throw new HttpError(409, 'Цей логін уже зайнятий.');
    const saved = db.prepare('INSERT OR IGNORE INTO users (name, password) VALUES (?, ?)').run(name, await hashPassword(password));
    if (!saved.changes) throw new HttpError(409, 'Цей логін уже зайнятий.');
  } else {
    const candidate = await hashPassword(password, user?.password.split(':')[0]);
    if (!user || !timingSafeEqual(Buffer.from(user.password), Buffer.from(candidate))) {
      throw new HttpError(401, 'Неправильний логін або пароль.');
    }
  }

  signOut(request, response);
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
  const token = randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, username, expires) VALUES (?, ?, ?)')
    .run(tokenHash(token), name, Date.now() + sessionSeconds * 1000);
  writeCookie(request, response, token, sessionSeconds);
  return { name, admin: user?.admin ?? 0 };
}

export function signOut(request, response) {
  const token = readToken(request);
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash(token));
  writeCookie(request, response, '', 0);
}
