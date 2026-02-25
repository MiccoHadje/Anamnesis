import type { StorageBackend } from './interface.js';
import { PgStorage } from './pg.js';

export type { StorageBackend, Transaction } from './interface.js';

let _instance: StorageBackend | null = null;

/** Get the singleton storage backend. */
export function getStorage(): StorageBackend {
  if (!_instance) {
    _instance = new PgStorage();
  }
  return _instance;
}

/** Close the storage backend and release resources. */
export async function closeStorage(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}
