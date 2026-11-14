// Sonido con Web Audio: clic de metrónomo y acordes sintetizados.
// Un único AudioContext para toda la app (iOS solo lo deja arrancar tras un
// gesto del usuario). Cada nodo se desconecta al terminar y stopAll() corta
// todo lo programado: así no se acumulan nodos al parar o reiniciar.

let ctx = null;
let master = null;
let chordBus = null;      // acordes de la app (volumen propio)
let chordVolume = 1;      // 1 = nivel normal; hasta 2
let elementBus = null;    // audio de acompañamiento
let elementVolume = 1;
let elementSource = null;
let connectedElement = null;
const live = new Set(); // osciladores programados o sonando

export function getContext() { return ctx; }

/** Llamar desde un gesto del usuario (botón). */
export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    chordBus = ctx.createGain();
    chordBus.gain.value = chordVolume;
    chordBus.connect(master);
    // iOS: un sonido vacío dentro del gesto termina de desbloquear el audio.
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(master);
    s.start(0);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function now() { return ctx ? ctx.currentTime : performance.now() / 1000; }

function voice(type, freq, when, peak, dur, dest = master) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(when);
  osc.stop(when + dur + 0.02);
  live.add(osc);
  osc.onended = () => {
    live.delete(osc);
    osc.disconnect();
    g.disconnect();
  };
}

export function click(when, accent) {
  if (!ctx) return;
  voice('sine', accent ? 1760 : 1175, when, accent ? 0.5 : 0.3, 0.05);
}

const freqOf = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------- Piano grabado (Salamander Grand Piano, CC BY 3.0) ----------
// Una muestra cada tercera menor (C, D♯, F♯, A) de C1 a C7; las notas
// intermedias se obtienen cambiando la velocidad (±1 semitono como mucho).
// Se cargan una a una tras el gesto de inicio; mientras tanto (o si fallan)
// suena el acorde sintetizado.
const PIANO_NOTES = [];
for (let o = 1; o <= 6; o++) {
  for (const [n, pc] of [['C', 0], ['Ds', 3], ['Fs', 6], ['A', 9]]) PIANO_NOTES.push({ name: n + o, midi: (o + 1) * 12 + pc });
}
PIANO_NOTES.push({ name: 'C7', midi: 96 });

const samples = new Map(); // midi -> AudioBuffer
let pianoLoading = null;

// Se decodifican a 32 kHz (no a los 44,1/48 kHz del iPad): de sobra para
// un piano y ocupan un tercio menos de memoria.
const SAMPLE_RATE = 32000;
let decoder = null;
function decode(data) {
  if (!decoder) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try { decoder = OAC ? new OAC(1, 1, SAMPLE_RATE) : ctx; } catch { decoder = ctx; }
  }
  // Forma con callbacks: la de promesa no existe en Safari antiguos.
  return new Promise((resolve, reject) => decoder.decodeAudioData(data, resolve, reject));
}

// Quita el silencio inicial (p. ej. el retardo del códec AAC) y se queda con
// un solo canal: el ataque cae justo en su tiempo y ocupa menos memoria.
function trimOnset(buf) {
  const ch = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
  let start = 0;
  while (start < ch.length && Math.abs(ch[start]) < peak * 0.05) start++;
  start = Math.max(0, start - Math.round(buf.sampleRate * 0.002));
  const out = ctx.createBuffer(1, ch.length - start, buf.sampleRate);
  out.getChannelData(0).set(ch.subarray(start));
  return out;
}

/** Carga las muestras (una vez). @param {string} base carpeta, p. ej. 'sonidos/piano/' */
export function loadPiano(base) {
  if (!ctx || pianoLoading) return pianoLoading;
  pianoLoading = (async () => {
    for (const { name, midi } of PIANO_NOTES) {
      try {
        const res = await fetch(base + name + '.m4a');
        if (!res.ok) continue;
        samples.set(midi, trimOnset(await decode(await res.arrayBuffer())));
      } catch { /* esa nota sonará sintetizada */ }
    }
    return samples.size;
  })();
  return pianoLoading;
}

export function pianoReady() { return samples.size; }

/** Para las pruebas: memoria usada y silencio inicial de cada muestra. */
export function pianoStats() {
  let bytes = 0;
  let maxLeadMs = 0;
  for (const b of samples.values()) {
    bytes += b.length * 4;
    const ch = b.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]));
    let i = 0;
    while (i < ch.length && Math.abs(ch[i]) < peak * 0.05) i++;
    maxLeadMs = Math.max(maxLeadMs, (1000 * i) / b.sampleRate);
  }
  return { count: samples.size, bytes, maxLeadMs };
}

function nearestSample(midi) {
  let best = null;
  for (const k of samples.keys()) if (best === null || Math.abs(k - midi) < Math.abs(best - midi)) best = k;
  return best !== null && Math.abs(best - midi) <= 3 ? best : null;
}

function pianoNote(midi, s, when, dur, gain) {
  const src = ctx.createBufferSource();
  src.buffer = samples.get(s);
  src.playbackRate.value = 2 ** ((midi - s) / 12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, when);
  g.gain.setTargetAtTime(0, when + dur, 0.12); // soltar la tecla al llegar el siguiente acorde
  src.connect(g);
  g.connect(chordBus);
  src.start(when);
  src.stop(when + dur + 0.8);
  live.add(src);
  src.onended = () => {
    live.delete(src);
    src.disconnect();
    g.disconnect();
  };
}

export function chord(midis, when, dur) {
  if (!ctx || !midis.length) return;
  const d = Math.max(0.3, dur);
  // Medido: así suena algo por encima del sintetizador y, aun con el volumen
  // del acorde al máximo (×2), el pico de un acorde de 5 notas no satura.
  const pianoGain = 1.5 / Math.sqrt(midis.length);
  const synthPeak = 0.28 / Math.sqrt(midis.length);
  for (const m of midis) {
    const s = nearestSample(m);
    if (s !== null) {
      pianoNote(m, s, when, d, pianoGain);
    } else {
      const sd = Math.min(d, 4);
      voice('triangle', freqOf(m), when, synthPeak, sd, chordBus);
      voice('sine', freqOf(m) * 2, when, synthPeak * 0.25, sd * 0.6, chordBus);
    }
  }
}

export function stopAll() {
  for (const osc of live) {
    try { osc.stop(); } catch { /* ya parado */ }
  }
  live.clear();
}

/** Volumen de los acordes de la app: 1 = normal, 0..2. */
export function setChordVolume(v) {
  chordVolume = v;
  if (chordBus) chordBus.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}

/**
 * Pasa un elemento <audio> por Web Audio para poder darle volumen propio
 * (en iOS, element.volume no hace nada). Solo una vez por elemento.
 */
export function routeElement(el) {
  if (!ctx || connectedElement === el) return;
  try {
    elementSource = ctx.createMediaElementSource(el);
    elementBus = ctx.createGain();
    elementBus.gain.value = elementVolume;
    elementSource.connect(elementBus);
    elementBus.connect(ctx.destination);
    connectedElement = el;
  } catch { /* si falla, suena sin control de volumen */ }
}

/** Silencia el audio de acompañamiento al instante (al parar). */
export function cutElement() {
  if (elementBus) {
    elementBus.gain.cancelScheduledValues(ctx.currentTime);
    elementBus.gain.setValueAtTime(0, ctx.currentTime);
  }
}

/** Devuelve el volumen elegido (al empezar). */
export function restoreElement() {
  if (elementBus) {
    elementBus.gain.cancelScheduledValues(ctx.currentTime);
    elementBus.gain.setValueAtTime(elementVolume, ctx.currentTime);
  }
}

/** Volumen del audio de acompañamiento: 1 = normal, 0..2. */
export function setElementVolume(v) {
  elementVolume = v;
  if (elementBus) elementBus.gain.setTargetAtTime(v, ctx.currentTime, 0.02);
}
