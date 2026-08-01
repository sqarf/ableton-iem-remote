import { readFile } from 'node:fs/promises';

const configUrl = new URL('../config/band.json', import.meta.url);

export async function exampleConfig() {
  return JSON.parse(await readFile(configUrl, 'utf8'));
}

export function clone(value) {
  return structuredClone(value);
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
