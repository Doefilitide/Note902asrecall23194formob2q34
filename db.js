/**
 * NoteRecall PWA Storage Engine
 * Persistent, offline-first IndexedDB wrapper for packs & review logs.
 */

const DB_NAME = 'NoteRecallPwaDB';
const DB_VERSION = 1;

let _dbPromise = null;

function getDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('packs')) {
        db.createObjectStore('packs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('reviews')) {
        const reviewStore = db.createObjectStore('reviews', { keyPath: 'id', autoIncrement: true });
        reviewStore.createIndex('by_pack', 'packId', { unique: false });
        reviewStore.createIndex('by_card', 'cardId', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

window.NoteRecallDB = {
  async savePack(pack) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['packs', 'meta'], 'readwrite');
      const packStore = tx.objectStore('packs');
      const metaStore = tx.objectStore('meta');

      pack.id = pack.packId || 'current_pack';
      packStore.put(pack);
      metaStore.put({ key: 'active_pack_id', value: pack.id });

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getActivePack() {
    const db = await getDB();
    const activeId = await new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const req = tx.objectStore('meta').get('active_pack_id');
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });

    if (!activeId) return null;

    return new Promise((resolve, reject) => {
      const tx = db.transaction('packs', 'readonly');
      const req = tx.objectStore('packs').get(activeId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async saveReview(entry) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('reviews', 'readwrite');
      const store = tx.objectStore('reviews');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        const exists = all.some(r => r.cardId === entry.cardId && r.timestamp === entry.timestamp);
        if (exists) {
          return resolve(false);
        }
        const addReq = store.add({
          ...entry,
          createdAt: Date.now()
        });
        addReq.onsuccess = () => resolve(true);
        addReq.onerror = () => reject(addReq.error);
      };
      req.onerror = () => reject(req.error);
    });
  },

  async appendReview(entry) {
    return this.saveReview(entry);
  },

  async getReviewsForPack(packId) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('reviews', 'readonly');
      const store = tx.objectStore('reviews');
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        if (!packId) return resolve(all);
        resolve(all.filter(r => r.packId === packId));
      };
      req.onerror = () => reject(req.error);
    });
  },

  async deleteReviewById(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('reviews', 'readwrite');
      tx.objectStore('reviews').delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  },

  async clearActivePackData() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['packs', 'reviews', 'meta'], 'readwrite');
      tx.objectStore('packs').clear();
      tx.objectStore('reviews').clear();
      tx.objectStore('meta').clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }
};
