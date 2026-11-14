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

function handleMessage(e) {
  const data = e.data;
  if (!data || data.length < 1) return;
  const status = data[0];
  if (status >= 0xf0) return; // reloj, active sensing, sysex: se ignoran
  const type = status & 0xf0;
  const time = e.timeStamp || performance.now();
  if (type === 0x90 && data.length >= 3) {
    if (data[2] > 0) for (const cb of noteOnCbs) cb(data[1], data[2], time);
    else for (const cb of noteOffCbs) cb(data[1], time);
  } else if (type === 0x80 && data.length >= 3) {
    for (const cb of noteOffCbs) cb(data[1], time);
  }
  // Pedal y demás controles: de momento no se usan.
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
