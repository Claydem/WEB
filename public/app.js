const form = document.querySelector('#task');
const status = document.querySelector('#status');
const progress = document.querySelector('progress');
const result = document.querySelector('#result');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  result.textContent = '';
  progress.value = 0;
  status.textContent = 'Запуск…';
  try {
    const fields = new FormData(form);
    const response = await fetch('/api/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size: Number(fields.get('size')), tolerance: Number(fields.get('tolerance')) }),
    });
    if (!response.ok) throw new Error((await response.json()).error);
    let remainder = '';
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      const lines = (remainder + chunk).split('\n');
      remainder = lines.pop();
      for (const line of lines) {
        const update = JSON.parse(line);
        if (update.error) throw new Error(update.error);
        if (update.result) {
          const { values, iterations, durationMs } = update.result;
          result.textContent = `${iterations} ітерацій, ${durationMs} мс\nПерші значення: ${values.slice(0, 8).map(value => value.toFixed(6)).join(', ')}`;
        } else {
          progress.value = update.progress;
          status.textContent = `${update.stage} · ${update.progress}%`;
        }
      }
    }
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});
