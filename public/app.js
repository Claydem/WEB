const byId = id => document.getElementById(id);
const login = byId('login-form');
const taskForm = byId('job-form');
const workspace = byId('workspace');
const notice = byId('notice');
const jobs = byId('jobs');
const adminPanel = byId('admin-panel');
const adminToggle = byId('admin-toggle');
const rows = new Map();
const labels = {
  queued: 'У черзі',
  running: 'Виконується',
  done: 'Готово',
  cancelled: 'Скасовано',
  failed: 'Помилка',
};
const precision = { 0.0001: '10⁻⁴', 0.000001: '10⁻⁶', 0.00000001: '10⁻⁸' };
const dateFormat = new Intl.DateTimeFormat('uk-UA', { dateStyle: 'short', timeStyle: 'short' });
let user = null;
let revision = 0;
let updating = false;
let adminView = false;

async function api(path, method = 'GET', body) {
  const response = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error), { status: response.status });
  return data;
}

function showError(message = '') {
  notice.textContent = message;
  notice.hidden = !message;
}

function setUser(value) {
  user = value;
  byId('login-panel').hidden = Boolean(user);
  byId('account').hidden = !user;
  byId('username').textContent = user?.name ?? '';
  adminToggle.hidden = !user?.admin;
  rows.clear();
  jobs.replaceChildren();
  byId('empty').hidden = false;
  byId('job-count').textContent = '';
  byId('result-dialog').close();
  setView(false);
}

function setView(admin) {
  revision++;
  adminView = admin;
  adminPanel.hidden = !admin;
  workspace.hidden = !user || admin;
  adminToggle.setAttribute('aria-pressed', String(admin));
  adminToggle.textContent = admin ? 'Мої задачі' : 'Моніторинг';
  refresh();
}

adminToggle.addEventListener('click', () => setView(!adminView));

login.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = new FormData(login);
  const button = event.submitter;
  const buttons = login.querySelectorAll('button');
  buttons.forEach(control => { control.disabled = true; });
  showError();
  try {
    const data = await api('/' + (button?.value ?? 'login'), 'POST', {
      name: fields.get('name'),
      password: fields.get('password'),
    });
    login.reset();
    setUser(data.user);
  } catch (error) {
    showError(error.message);
  } finally {
    buttons.forEach(control => { control.disabled = false; });
  }
});

byId('logout').addEventListener('click', async () => {
  try {
    await api('/logout', 'POST');
    showError();
    setUser(null);
  } catch (error) {
    showError(error.message);
  }
});

taskForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = new FormData(taskForm);
  const button = taskForm.querySelector('button');
  button.disabled = true;
  showError();
  try {
    await api('/jobs', 'POST', { size: Number(fields.get('size')), tolerance: Number(fields.get('tolerance')) });
    await refresh();
  } catch (error) {
    showError(error.message);
  } finally {
    button.disabled = false;
  }
});

function createRow(id) {
  const row = byId('job-row').content.firstElementChild.cloneNode(true);
  row.querySelector('h3').textContent = 'Задача №' + id;
  row.querySelector('.job-result').addEventListener('click', () => showResult(id));
  const cancel = row.querySelector('.job-cancel');
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    showError();
    try {
      await api(`/jobs/${id}/cancel`, 'POST');
      await refresh();
    } catch (error) {
      showError(error.message);
    } finally {
      cancel.disabled = false;
    }
  });
  return row;
}

function updateRow(row, job) {
  const badge = row.querySelector('.badge');
  badge.textContent = labels[job.status];
  badge.dataset.status = job.status;
  const meta = [`${job.size} невідомих`, precision[job.tolerance], dateFormat.format(job.createdAt)];
  if (job.worker) meta.push('Сервер ' + job.worker.split('-').at(-1));
  row.querySelector('.job-meta').textContent = meta.join(' · ');
  const active = job.status === 'running' || job.status === 'queued';
  row.querySelector('.job-progress').hidden = !active;
  row.querySelector('.stage').textContent = job.wait ? `Місце в черзі: ${job.wait.position}` : job.stage;
  row.querySelector('.percent').textContent = job.wait ? `≈ ${job.wait.seconds} с` : job.progress + '%';
  row.querySelector('progress').value = job.progress;
  const error = row.querySelector('.job-error');
  error.textContent = job.error ?? '';
  error.hidden = !job.error;
  row.querySelector('.job-result').hidden = job.status !== 'done';
  row.querySelector('.job-cancel').hidden = !active;
  row.querySelector('.actions').hidden = !active && job.status !== 'done';
}

function fillTable(target, rows) {
  const elements = rows.map(values => {
    const row = document.createElement('tr');
    for (const value of values) {
      const cell = row.insertCell();
      cell.textContent = value;
    }
    return row;
  });
  byId(target).replaceChildren(...elements);
}

function showAdmin(data) {
  const states = { starting: 'Запускається', idle: 'Вільний', busy: 'Зайнятий', stopping: 'Зупиняється' };
  byId('server-count').textContent = `${data.workers.length} / ${data.max}`;
  fillTable('server-rows', data.workers.map(worker => [
    worker.name, worker.pid ?? '—', states[worker.state], worker.jobId ?? '—',
    worker.cpu === null ? '—' : worker.cpu + '%',
    worker.memory === null ? '—' : worker.memory + ' МБ',
  ]));
  const waiting = data.jobs.filter(job => job.status === 'queued').length;
  byId('active-count').textContent = `${data.jobs.length} / ${data.queueLimit} · у черзі ${waiting}`;
  byId('admin-empty').hidden = data.jobs.length > 0;
  byId('active-table').hidden = data.jobs.length === 0;
  fillTable('active-rows', data.jobs.map(job => [
    job.id, job.username, labels[job.status], job.worker ?? '—', job.progress + '%',
  ]));
}

async function refresh() {
  if (!user || updating) return;
  updating = true;
  const snapshot = revision;
  try {
    const data = await api(adminView ? '/admin' : '/jobs');
    if (snapshot !== revision) return;
    if (adminView) return showAdmin(data);
    const current = new Set(data.jobs.map(job => job.id));
    for (const [id, row] of rows) {
      if (current.has(id)) continue;
      row.remove();
      rows.delete(id);
    }
    data.jobs.forEach((job, index) => {
      if (!rows.has(job.id)) rows.set(job.id, createRow(job.id));
      const row = rows.get(job.id);
      updateRow(row, job);
      if (jobs.children[index] !== row) jobs.insertBefore(row, jobs.children[index] ?? null);
    });
    byId('empty').hidden = data.jobs.length > 0;
    byId('job-count').textContent = data.jobs.length ? `${data.jobs.length} / 30` : '';
  } catch (error) {
    if (snapshot !== revision) return;
    if (error.status === 401) setUser(null);
    showError(error.message);
  } finally {
    updating = false;
    if (snapshot !== revision) refresh();
  }
}

async function showResult(id) {
  const snapshot = revision;
  try {
    const result = await api(`/jobs/${id}/result`);
    if (snapshot !== revision) return;
    byId('result-title').textContent = 'Розв’язок задачі №' + id;
    byId('result-details').textContent = `${result.iterations} ітерацій · ${(result.durationMs / 1000).toFixed(2)} с · похибка до ${result.errorBound.toExponential(2)}`;
    const items = result.values.map((value, index) => {
      const item = document.createElement('li');
      item.textContent = `x[${index + 1}] = ${value.toFixed(8)}`;
      return item;
    });
    byId('result-values').replaceChildren(...items);
    if (!byId('result-dialog').open) byId('result-dialog').showModal();
  } catch (error) {
    showError(error.message);
  }
}

try {
  setUser((await api('/me')).user);
} catch (error) {
  setUser(null);
  showError(error.message);
}
setInterval(refresh, 800);
