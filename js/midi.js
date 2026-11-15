// Único punto de acceso a Web MIDI. Si algún día cambia el puente
// (MIDIWeb → otro), solo se toca este archivo.
//
// Interfaz:
//   initMidi()                -> Promise<boolean> (true si hay Web MIDI)
//   onNoteOn(cb)              cb(note, velocity, time)
//   onNoteOff(cb)             cb(note, time)
//   onStateChange(cb)         cb({supported, inputs:[nombres], error})
//   send(bytes)               envía a todas las salidas (para el futuro)
//   getState()

const noteOnCbs = new Set();
const noteOffCbs = new Set();
const stateCbs = new Set();

let access = null;
let state = { supported: false, inputs: [], outputs: [], error: null };

function emitState() {
  for (const cb of stateCbs) cb(getState());
}

// Bytes de datos que sigue a cada tipo de mensaje de canal.
const DATA_LEN = { 0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2 };
const SYSTEM_LEN = { 0xf1: 1, 0xf2: 2, 0xf3: 1 };

/**
 * Lee TODOS los mensajes que vengan en un mismo paquete. Por Bluetooth, un
 * acorde puede llegar en un solo paquete con varias notas seguidas, incluso
 * sin repetir el byte de estado ("running status"); leer solo el primero
 * hacía que a veces se perdieran notas del acorde.
 * @param {Uint8Array|number[]} data
 * @param {(note:number, vel:number)=>void} on
 * @param {(note:number)=>void} off
 */
export function parseMidi(data, on, off) {
  let i = 0;
  let running = 0;
  while (i < data.length) {
    const b = data[i];
    if (b >= 0xf8) { i++; continue; }                 // tiempo real (reloj, active sensing)
    if (b === 0xf0) {                                  // sysex: saltar hasta F7
      while (i < data.length && data[i] !== 0xf7) i++;
      i++; running = 0; continue;
    }
    if (b >= 0xf0) { i += 1 + (SYSTEM_LEN[b] || 0); running = 0; continue; }
    if (b & 0x80) { running = b; i++; }
    else if (!running) { i++; continue; }              // dato suelto sin estado: ignorar
    const type = running & 0xf0;
    const n = DATA_LEN[type];
    if (i + n > data.length) break;                    // mensaje cortado
    if (type === 0x90) {
      if (data[i + 1] > 0) on(data[i], data[i + 1]);
      else off(data[i]);                               // nota con velocidad 0 = soltar
    } else if (type === 0x80) {
      off(data[i]);
    }
    // Pedal y demás controles: de momento no se usan.
    i += n;
  }
}

function handleMessage(e) {
  const data = e.data;
  if (!data || data.length < 1) return;
  const time = e.timeStamp || performance.now();
  parseMidi(
    data,
    (note, vel) => { for (const cb of noteOnCbs) cb(note, vel, time); },
    (note) => { for (const cb of noteOffCbs) cb(note, time); },
  );
}

function refreshPorts() {
  if (!access) return;
  const inputs = [];
  access.inputs.forEach((input) => {
    // Asignar la propiedad (no addEventListener) evita duplicar listeners
    // cuando el puerto se reconecta.
    input.onmidimessage = handleMessage;
    if (input.state !== 'disconnected') inputs.push(input.name || 'Dispositivo MIDI');
  });
  const outputs = [];
  access.outputs.forEach((o) => {
    if (o.state !== 'disconnected') outputs.push(o.name || 'Salida MIDI');
  });
  state = { ...state, inputs, outputs };
  emitState();
}

export async function initMidi() {
  if (access) return true;
  if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
    state = { ...state, supported: false, error: 'Este navegador no tiene Web MIDI. En el iPad abre la app con MIDIWeb Browser; en Android/Mac, con Chrome.' };
    emitState();
    return false;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
    state = { ...state, supported: true, error: null };
    access.onstatechange = refreshPorts;
    refreshPorts();
    return true;
  } catch (err) {
    state = { ...state, supported: false, error: 'No se pudo acceder al MIDI: ' + (err && err.message ? err.message : err) };
    emitState();
    return false;
  }
}

export function onNoteOn(cb) { noteOnCbs.add(cb); return () => noteOnCbs.delete(cb); }
export function onNoteOff(cb) { noteOffCbs.add(cb); return () => noteOffCbs.delete(cb); }
export function onStateChange(cb) { stateCbs.add(cb); return () => stateCbs.delete(cb); }

export function send(bytes, timestamp) {
  if (!access) return;
  access.outputs.forEach((o) => {
    try { o.send(bytes, timestamp); } catch { /* salida no disponible */ }
  });
}

export function getState() {
  return { ...state, inputs: [...state.inputs], outputs: [...state.outputs] };
}
