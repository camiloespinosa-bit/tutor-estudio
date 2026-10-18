// Almacenamiento local en IndexedDB. Todo vive en el navegador de este dispositivo.

const DB_NAME = 'tutor-estudio';
const DB_VERSION = 1;
const STORES = ['docs', 'cards', 'chats'];

let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cards')) {
          const cards = db.createObjectStore('cards', { keyPath: 'id' });
          cards.createIndex('docId', 'docId');
        }
        if (!db.objectStoreNames.contains('chats')) db.createObjectStore('chats', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const result = fn(s);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, id) => tx(store, 'readonly', (s) => s.get(id)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  put: (store, value) => tx(store, 'readwrite', (s) => { s.put(value); }),
  del: (store, id) => tx(store, 'readwrite', (s) => { s.delete(id); }),
  putMany: (store, values) => tx(store, 'readwrite', (s) => { values.forEach((v) => s.put(v)); }),

  async byDoc(docId) {
    return tx('cards', 'readonly', (s) => s.index('docId').getAll(docId));
  },

  async deleteDoc(docId) {
    const cards = await this.byDoc(docId);
    await tx('cards', 'readwrite', (s) => { cards.forEach((c) => s.delete(c.id)); });
    const chats = (await this.all('chats')).filter((c) => c.docId === docId);
    await tx('chats', 'readwrite', (s) => { chats.forEach((c) => s.delete(c.id)); });
    await this.del('docs', docId);
  },

  async exportAll() {
    const out = { app: 'tutor-estudio', version: 1, exportedAt: new Date().toISOString() };
    for (const store of STORES) out[store] = await this.all(store);
    return out;
  },

  async importAll(data) {
    if (!data || data.app !== 'tutor-estudio') throw new Error('Este archivo no es una copia de seguridad del Tutor.');
    for (const store of STORES) {
      if (Array.isArray(data[store])) await this.putMany(store, data[store]);
    }
  },
};

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}
