// Lee un MusicXML (score-partwise) y lo convierte en una lista de "eventos":
// cada evento es un acorde (todas las notas que empiezan a la vez) con sus
// notas MIDI exactas, el pentagrama de cada nota y el cifrado vigente.
// No dibuja nada: la partitura se usa solo como fuente de datos.

const STEP_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// Texto por defecto si el <kind> no trae atributo text.
const KIND_TEXT = {
  major: '', minor: 'm', augmented: '+', diminished: 'dim',
  dominant: '7', 'major-seventh': 'maj7', 'minor-seventh': 'm7',
  'diminished-seventh': 'dim7', 'augmented-seventh': '+7',
  'half-diminished': 'm7♭5', 'major-minor': 'm(maj7)',
  'major-sixth': '6', 'minor-sixth': 'm6',
  'dominant-ninth': '9', 'major-ninth': 'maj9', 'minor-ninth': 'm9',
  'dominant-11th': '11', 'major-11th': 'maj11', 'minor-11th': 'm11',
  'dominant-13th': '13', 'major-13th': 'maj13', 'minor-13th': 'm13',
  'suspended-second': 'sus2', 'suspended-fourth': 'sus4', power: '5',
};

const EPS = 1e-6;

function child(el, name) {
  for (const c of el.children) if (c.localName === name) return c;
  return null;
}
function childText(el, name) {
  const c = child(el, name);
  return c ? c.textContent.trim() : null;
}
function num(el, name, fallback) {
  const t = childText(el, name);
  const n = t === null ? NaN : Number(t);
  return Number.isFinite(n) ? n : fallback;
}

function accidental(alter) {
  if (alter === 1) return '♯';
  if (alter === -1) return '♭';
  if (alter === 2) return '𝄪';
  if (alter === -2) return '𝄫';
  return '';
}

function harmonySymbol(h) {
  const root = child(h, 'root');
  if (!root) return null;
  const step = childText(root, 'root-step');
  if (!step) return null;
  const alter = Math.round(num(root, 'root-alter', 0));
  const kindEl = child(h, 'kind');
  let kind = '';
  if (kindEl) {
    kind = kindEl.hasAttribute('text')
      ? kindEl.getAttribute('text')
      : (KIND_TEXT[kindEl.textContent.trim()] ?? '');
  }
  let bass = '';
  const bassEl = child(h, 'bass');
  if (bassEl) {
    const bs = childText(bassEl, 'bass-step');
    if (bs) bass = '/' + bs + accidental(Math.round(num(bassEl, 'bass-alter', 0)));
  }
  return step + accidental(alter) + kind + bass;
}

export function midiOf(step, alter, octave) {
  return (octave + 1) * 12 + STEP_PC[step] + alter;
}

/**
 * @param {string} text contenido del archivo
 * @returns {{title:string, tempo:number|null, measures:Array, events:Array}}
 */
export function parseMusicXML(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('El archivo está vacío.');
  }
  if (text.startsWith('PK')) {
    throw new Error('Es un MusicXML comprimido (.mxl). Expórtalo como MusicXML sin comprimir (.xml).');
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) {
    throw new Error('El archivo no es un MusicXML válido.');
  }
  const rootEl = doc.documentElement;
  if (rootEl.localName === 'score-timewise') {
    throw new Error('Formato "score-timewise" no soportado. Exporta en formato partwise.');
  }
  if (rootEl.localName !== 'score-partwise') {
    throw new Error('El archivo no es una partitura MusicXML.');
  }

  const title =
    doc.querySelector('work > work-title')?.textContent.trim() ||
    doc.querySelector('movement-title')?.textContent.trim() || '';

  const parts = [...rootEl.children].filter((c) => c.localName === 'part');
  if (!parts.length) throw new Error('La partitura no tiene ninguna parte.');

  const measures = [];      // {index, number, startQ, lengthQ, beats, beatType}
  const notesByTime = new Map(); // key -> {startQ, measureIndex, notes:[]}
  const harmonies = [];     // {timeQ, symbol}
  let tempo = null;

  parts.forEach((part, partIndex) => {
    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let measureStartQ = 0;
    const measureEls = [...part.children].filter((c) => c.localName === 'measure');

    measureEls.forEach((m, mi) => {
      let pos = 0;        // en divisiones
      let maxPos = 0;
      let lastStart = 0;

      for (const el of m.children) {
        switch (el.localName) {
          case 'attributes': {
            divisions = num(el, 'divisions', divisions);
            const time = child(el, 'time');
            if (time) {
              beats = num(time, 'beats', beats);
              beatType = num(time, 'beat-type', beatType);
            }
            break;
          }
          case 'backup':
            pos -= num(el, 'duration', 0);
            if (pos < 0) pos = 0;
            break;
          case 'forward':
            pos += num(el, 'duration', 0);
            maxPos = Math.max(maxPos, pos);
            break;
          case 'sound':
            if (tempo === null && el.hasAttribute('tempo')) tempo = Number(el.getAttribute('tempo')) || null;
            break;
          case 'direction': {
            const s = child(el, 'sound');
            if (s && tempo === null && s.hasAttribute('tempo')) tempo = Number(s.getAttribute('tempo')) || null;
            break;
          }
          case 'harmony': {
            const symbol = harmonySymbol(el);
            const offset = num(el, 'offset', 0);
            if (symbol) harmonies.push({ timeQ: measureStartQ + (pos + offset) / divisions, symbol });
            break;
          }
          case 'note': {
            if (child(el, 'grace')) break; // las notas de adorno no se validan
            const isChord = !!child(el, 'chord');
            const duration = num(el, 'duration', 0);
            const start = isChord ? lastStart : pos;
            if (!isChord) {
              lastStart = pos;
              pos += duration;
              maxPos = Math.max(maxPos, pos);
            }
            if (child(el, 'rest')) break;
            const pitch = child(el, 'pitch');
            if (!pitch) break; // notas sin altura (percusión) se ignoran
            // Continuación de una ligadura: no es una pulsación nueva.
            const ties = [...el.children].filter((c) => c.localName === 'tie');
            if (ties.some((t) => t.getAttribute('type') === 'stop')) break;

            const step = childText(pitch, 'step');
            const alter = Math.round(num(pitch, 'alter', 0));
            const octave = num(pitch, 'octave', 4);
            if (!(step in STEP_PC)) break;
            const midi = midiOf(step, alter, octave);
            const staff = num(el, 'staff', 1);
            const startQ = measureStartQ + start / divisions;
            const key = startQ.toFixed(6);
            let ev = notesByTime.get(key);
            if (!ev) {
              ev = { startQ, measureIndex: mi, notes: [], durQ: 0 };
              notesByTime.set(key, ev);
            }
            if (!ev.notes.some((n) => n.midi === midi)) {
              ev.notes.push({ midi, staff, part: partIndex });
            }
            ev.durQ = Math.max(ev.durQ, duration / divisions);
            break;
          }
          default:
            break;
        }
      }

      const nominalQ = (beats * 4) / beatType;
      const lengthQ = Math.max(nominalQ, maxPos / divisions);
      if (partIndex === 0) {
        measures.push({
          index: mi,
          number: m.getAttribute('number') || String(mi + 1),
          startQ: measureStartQ,
          lengthQ,
          beats,
          beatType,
        });
      }
      measureStartQ += lengthQ;
    });
  });

  harmonies.sort((a, b) => a.timeQ - b.timeQ);
  // Quitar cifrados duplicados (p. ej. el mismo cifrado en dos partes).
  const uniqueHarmonies = harmonies.filter((x, i) =>
    i === 0 || Math.abs(x.timeQ - harmonies[i - 1].timeQ) > EPS || x.symbol !== harmonies[i - 1].symbol);
  // Compás de cada cifrado (para dibujar el lead sheet).
  let mi = 0;
  uniqueHarmonies.forEach((x, i) => {
    while (mi + 1 < measures.length && measures[mi + 1].startQ <= x.timeQ + EPS) mi++;
    x.index = i;
    x.measureIndex = mi;
  });

  const events = [...notesByTime.values()].sort((a, b) => a.startQ - b.startQ);

  let h = -1;
  events.forEach((ev, i) => {
    while (h + 1 < uniqueHarmonies.length && uniqueHarmonies[h + 1].timeQ <= ev.startQ + EPS) h++;
    ev.index = i;
    ev.harmonyIndex = h;
    ev.symbol = h >= 0 ? uniqueHarmonies[h].symbol : '';
    ev.measureNumber = measures[ev.measureIndex]?.number ?? String(ev.measureIndex + 1);
    ev.notes.sort((a, b) => a.midi - b.midi);
  });

  return { title, tempo, measures, harmonies: uniqueHarmonies, events };
}
