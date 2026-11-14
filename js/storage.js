// Datos de la app (ajustes, historial de rondas).
//
// La copia buena está en el Mac (servidor.py los guarda en datos/), porque
// iOS puede borrar el almacenamiento del navegador. localStorage queda como
// copia rápida y de respaldo: la app lee de ahí de forma síncrona y cada
// cambio se sube al Mac. Si el Mac no responde, el cambio queda pendiente y
// se reintenta; al arrancar, lo pendiente se sube antes de leer nada.

const PREFIX = 'jpt.';
const PENDING = PREFIX + '_pendiente';
const API = new URL('../api/datos/', import.meta.url).href; // relativo a la app, no a la página
const RETRY_MS = 30000;

// Solo cuando la app se sirve desde el Mac (servidor.py, http en la red de
// casa). Publicada en internet (https) no hay Mac: los datos viven en el
// iPad y su copia de seguridad es el archivo de «Guardar copia».
// Las páginas de prueba (index.html?pruebas) no tocan los datos del Mac.
const remoteEnabled = typeof location !== 'undefined' && location.protocol === 'http:' &&
  !/[?&]pruebas\b/.test(location.search);

let statusCb = () => {};
let retryTimer = 0;
const pushTimers = new Map();

/** cb(ok:boolean): false si hay cambios que no se han podido guardar en el Mac. */
export function onRemoteStatus(cb) { statusCb = cb; }

// Copia en memoria por si localStorage falla (sin espacio, modo privado).
const mem = new Map();

function readLocal(key) {
  if (mem.has(key)) return mem.get(key);
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}
function writeLocal(key, value) {
  mem.set(key, value);
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function pendingKeys() {
  try { return new Set(JSON.parse(localStorage.getItem(PENDING) || '[]')); } catch { return new Set(); }
}
function setPending(key, on) {
  const s = pendingKeys();
  if (on) s.add(key); else s.delete(key);
  try { localStorage.setItem(PENDING, JSON.stringify([...s])); } catch { /* sin espacio */ }
}

async function request(method, key, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    return await fetch(API + key, {
      method,
      body,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

async function push(key) {
  const value = readLocal(key);
  if (value === undefined) return true;
  try {
    const res = await request('PUT', key, JSON.stringify(value));
    if (!res.ok) throw new Error(res.status);
    setPending(key, false);
    return true;
  } catch {
    return false;
  }
}

async function flushPending() {
  let ok = true;
  for (const key of pendingKeys()) ok = (await push(key)) && ok;
  clearTimeout(retryTimer);
  if (!ok) retryTimer = setTimeout(flushPending, RETRY_MS);
  statusCb(ok);
  return ok;
}

/**
 * Al arrancar: sube lo pendiente y trae del Mac la versión guardada.
 * Lo que solo existe en el navegador (datos de antes de este cambio) se sube.
 */
export async function syncFromServer(keys) {
  if (!remoteEnabled) return;
  await flushPending();
  const pending = pendingKeys();
  for (const key of keys) {
    if (pending.has(key)) continue; // el Mac no respondía: manda el navegador
    try {
      const res = await request('GET', key);
      if (res.status === 404) {
        if (readLocal(key) !== undefined) { setPending(key, true); await flushPending(); }
        continue;
      }
      if (!res.ok) throw new Error(res.status);
      writeLocal(key, await res.json());
    } catch {
      statusCb(false);
    }
  }
}

export function load(key, fallback) {
  const v = readLocal(key);
  return v === undefined ? fallback : v;
}

/** @returns {boolean} true si se guardó en el navegador (el Mac va después). */
export function save(key, value) {
  const ok = writeLocal(key, value);
  if (remoteEnabled) {
    setPending(key, true);
    // Agrupar cambios seguidos (p. ej. varias pulsaciones de tempo).
    clearTimeout(pushTimers.get(key));
    pushTimers.set(key, setTimeout(() => { pushTimers.delete(key); flushPending(); }, 400));
  }
  return ok;
}
