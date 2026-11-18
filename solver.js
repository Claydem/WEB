import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';

export const minSize = 20;
export const maxSize = 1200;
export const maxTime = 30_000;
export const tolerances = [1e-4, 1e-6, 1e-8];

const ratio = 0.994;
const maxIterations = 12_000;

export function validInput(input) {
  return Number.isInteger(input?.size) &&
    input.size >= minSize && input.size <= maxSize &&
    tolerances.includes(input.tolerance);
}

export async function solve({ size, tolerance }, report, signal) {
  const started = performance.now();
  const coefficients = new Float64Array(size * size);
  const right = new Float64Array(size);
  const example = Float64Array.from({ length: size }, (_, i) => 1 + (i % 10) / 10);
  let current = new Float64Array(size);
  let next = new Float64Array(size);

  function checkTime() {
    signal?.throwIfAborted();
    if (performance.now() - started >= maxTime) {
      throw new Error('Перевищено ліміт часу обчислення (30 с).');
    }
  }

  report(1, 'Побудова матриці');
  for (let i = 0; i < size; i++) {
    const offset = i * size;
    let sum = 0;
    for (let j = 0; j < size; j++) {
      if (i === j) continue;
      const weight = 1 + ((i * 7 + j * 11) % 17);
      coefficients[offset + j] = weight;
      sum += weight;
    }
    let value = example[i];
    for (let j = 0; j < size; j++) {
      const weight = coefficients[offset + j] * ratio / sum;
      coefficients[offset + j] = weight;
      value -= weight * example[j];
    }
    right[i] = value;
    if (i % 64 === 63) {
      await setImmediate();
      checkTime();
    }
  }

  report(5, 'Ітерації Якобі');
  let lastYield = performance.now();
  let lastProgress = 5;
  let initialBound;

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let change = 0;
    for (let i = 0; i < size; i++) {
      const offset = i * size;
      let value = right[i];
      for (let j = 0; j < size; j++) {
        value += coefficients[offset + j] * current[j];
      }
      next[i] = value;
      change = Math.max(change, Math.abs(value - current[i]));
    }
    [current, next] = [next, current];
    const errorBound = change * ratio / (1 - ratio);
    initialBound ??= errorBound;

    if (errorBound <= tolerance) {
      checkTime();
      report(100, 'Готово');
      return {
        values: Array.from(current),
        iterations: iteration,
        errorBound,
        durationMs: Math.round(performance.now() - started),
      };
    }
    if (performance.now() - lastYield >= 30) {
      const fraction = Math.log(initialBound / errorBound) / Math.log(initialBound / tolerance);
      const progress = Math.min(99, 5 + Math.floor(fraction * 94));
      if (progress > lastProgress) {
        report(progress, 'Ітерації Якобі');
        lastProgress = progress;
      }
      await setImmediate();
      checkTime();
      lastYield = performance.now();
    }
  }
  throw new Error('Перевищено ліміт ітерацій.');
}
