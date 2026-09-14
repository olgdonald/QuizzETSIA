import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { seedStore, type Store } from './domain.js';

const file = resolve(process.cwd(), 'data', 'store.json');

/** JSON adapter for local development. Replace this module with a PostgreSQL repository in production. */
export async function loadStore(): Promise<Store> {
  try { const store = JSON.parse(await readFile(file, 'utf8')) as Store; return { ...store, attempts: store.attempts ?? [] }; }
  catch { const store = seedStore(); await saveStore(store); return store; }
}
export const saveStore = (store: Store) => writeFile(file, JSON.stringify(store, null, 2), 'utf8');
