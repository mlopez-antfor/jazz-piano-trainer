// Biblioteca del iPad: partituras y audios de iReal importados, guardados en
// IndexedDB (localStorage se queda corto: ~5 MB; cada partitura ocupa ~80 KB
// y cada audio ~3 MB).
// Los originales están en iCloud Drive: si iOS borra estos datos, basta con
// volver a importar.

const DB_NAME = 'jazz-piano-trainer';
const STORE = 'scores';
const AUDIO = 'audios';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('Este navegador no permite guardar partituras.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      // v1: partituras; v2: audios. Crear solo lo que falte (las partituras ya guardadas se conservan).
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'name' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña actualiza la base de datos, cerrar y reabrir después.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error || new Error('No se pudo abrir el almacenamiento.')); };
    req.onblocked = () => { dbPromise = null; reject(new Error('Almacenamiento bloqueado. Cierra otras pestañas de la app.')); };
  });
  return dbPromise;
}

function tx(mode, fn, storeName = STORE) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const req = fn(store);
    if (req) req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('Error de almacenamiento.'));
    t.onabort = () => reject(t.error || new Error('No hay espacio suficiente para guardar.'));
  }));
}

/** @returns {Promise<Array<{name:string, added:number}>>} sin el XML */
export async function listScores() {
  const all = await tx('readonly', (s) => s.getAll());
  return (all || [])
    .map(({ name, added }) => ({ name, added }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
}

export async function getScoreXml(name) {
  const rec = await tx('readonly', (s) => s.get(name));
  if (!rec) throw new Error(`La partitura "${name}" ya no está guardada. Vuelve a importarla.`);
  return rec.xml;
}

/** @returns {Promise<boolean>} true si sustituyó a una existente */
export async function putScore(name, xml) {
  const existed = (await tx('readonly', (s) => s.count(name))) > 0;
  await tx('readwrite', (s) => s.put({ name, xml, added: Date.now() }));
  return existed;
}

export function deleteScore(name) {
  return tx('readwrite', (s) => s.delete(name));
}

// ---------- Audios ----------
// Se guardan como ArrayBuffer + tipo (más fiable en Safari que guardar Blob).

/** @returns {Promise<Array<{name:string, size:number}>>} sin los datos */
export async function listAudios() {
  const names = await tx('readonly', (s) => s.getAllKeys(), AUDIO);
  return (names || []).sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
}

/** @returns {Promise<Blob|null>} */
export async function getAudio(name) {
  const rec = await tx('readonly', (s) => s.get(name), AUDIO);
  return rec ? new Blob([rec.data], { type: rec.type || 'audio/mp4' }) : null;
}

/** @returns {Promise<boolean>} true si sustituyó a uno existente */
export async function putAudio(name, file) {
  const data = await file.arrayBuffer();
  const existed = (await tx('readonly', (s) => s.count(name), AUDIO)) > 0;
  await tx('readwrite', (s) => s.put({ name, data, type: file.type || 'audio/mp4', added: Date.now() }), AUDIO);
  return existed;
}

export function deleteAudio(name) {
  return tx('readwrite', (s) => s.delete(name), AUDIO);
}

/** Pide al navegador que no borre estos datos por su cuenta (si lo permite). */
export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* no soportado */ }
  return false;
}
