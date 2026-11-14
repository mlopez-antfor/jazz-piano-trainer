import { initMidi, onNoteOn, onNoteOff, onStateChange } from './midi.js';
import { parseMusicXML } from './score.js';
import { Keyboard } from './keyboard.js';
import { WaitPractice } from './practice.js';
import * as store from './storage.js';
import * as lib from './library.js';
import { LeadSheet } from './leadsheet.js';
import { detectChord } from './chords.js';
import { TempoPractice } from './tempo.js';
import * as audio from './audio.js';
import { Backing } from './backing.js';

const $ = (id) => document.getElementById(id);

// Ajustes e historial viven en el Mac: traerlos antes de leer nada.
store.onRemoteStatus((ok) => {
  const el = $('save-status');
  el.hidden = ok;
});
await store.syncFromServer(['settings', 'history']);

// Fundamental de la mano izquierda: octava exacta o cualquier octava en un rango.
const ROOT_RANGES = { exact: null, c2: [36, 48], c1: [24, 48] };

const settings = {
  showNotes: true,
  rootRange: 'c2',
  // Zonas extra del teclado además de la central (C2–C5).
  keys: { left: false, c5: false, c6: false, right: false },
  lastScore: null,
  mode: 'wait',        // 'wait' | 'tempo'
  tempo: 60,
  metronome: true,
  playChords: true,
  marginBeats: 1,
  audioOn: false,
  volAudio: 1,         // 1 = volumen del iPad; 0..2
  volChord: 1,
  audioByScore: {},    // nombre de partitura -> {file, tempo}: audio de iReal
  ...store.load('settings', {}),
};
if (settings.flexRoot === false && !store.load('settings', {}).rootRange) settings.rootRange = 'exact'; // ajuste antiguo
settings.keys = { left: false, c5: false, c6: false, right: false, ...settings.keys };
delete settings.flexRoot;
delete settings.latch;
if (!(settings.rootRange in ROOT_RANGES)) settings.rootRange = 'c2';
if (settings.mode !== 'tempo') settings.mode = 'wait';
function saveSettings() { store.save('settings', settings); }

const TEMPO_MIN = 30;
const TEMPO_MAX = 300;
const TEMPO_STEP = 5;

function matchOptions() {
  const range = ROOT_RANGES[settings.rootRange];
  return range ? { flexRoot: true, rootRange: range } : { flexRoot: false };
}

// ---------- Partituras ----------
// Solo las importadas por el usuario (desde iCloud Drive en el iPad),
// guardadas en IndexedDB. La app no depende del Mac.
let library = []; // {id:'i:nombre', name}
let loadToken = 0;

const SCORE_EXT = /\.(musicxml|xml)$/i;
const AUDIO_EXT = /\.(m4a|aac|mp3|wav)$/i;

function nameFromFile(file) {
  return file.replace(SCORE_EXT, '').replace(/\.music$/i, '');
}

async function refreshLibrary() {
  try {
    library = (await lib.listScores()).map((x) => ({ id: 'i:' + x.name, name: x.name }));
  } catch (err) {
    library = [];
    showMessage(err.message, true);
  }
  const sel = $('score-select');
  sel.textContent = '';
  if (!library.length) {
    const o = document.createElement('option');
    o.textContent = 'Sin partituras: pulsa Importar';
    o.value = '';
    sel.appendChild(o);
  }
  for (const s of library) {
    const o = document.createElement('option');
    o.value = s.id;
    o.textContent = s.name;
    sel.appendChild(o);
  }
}

async function selectScore(id) {
  const token = ++loadToken;
  resetDeleteButton();
  const entry = library.find((s) => s.id === id) || library[0];
  $('btn-delete').disabled = !entry;
  if (!entry) { score = null; leadsheet.load(null); applyRegion(); return; }
  $('score-select').value = entry.id;
  try {
    const parsed = parseMusicXML(await lib.getScoreXml(entry.name));
    if (token !== loadToken) return; // se eligió otra mientras cargaba
    if (!parsed.events.length) {
      throw new Error('Esta partitura no tiene notas (solo cifrados). Para practicar hacen falta las notas del voicing.');
    }
    score = parsed;
    loop = null;
    setupKeyboardRange(score.events);
    leadsheet.load(score);
    applyRegion();
    settings.lastScore = entry.id;
    saveSettings();
    updateBackingSource();
    renderHistory();
  } catch (err) {
    if (token !== loadToken) return;
    score = null;
    leadsheet.load(null);
    applyRegion();
    showMessage(err.message, true);
  }
}

// Teclado: zona central C2–C5 siempre; a la izquierda hasta A0 y a la
// derecha por octavas hasta C8 según las opciones. Si la partitura tiene
// notas fuera, se amplía para que siempre se vean las notas pedidas.
const RIGHT_ZONES = ['c5', 'c6', 'right']; // en orden: marcar una marca las anteriores
function setupKeyboardRange(events) {
  const z = settings.keys;
  let lo = z.left ? 21 : 36;
  let hi = z.right ? 108 : z.c6 ? 96 : z.c5 ? 84 : 72;
  for (const ev of events) for (const n of ev.notes) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  keyboard.setRange(lo, hi);
}

async function importFiles(files) {
  const added = [];
  const replaced = [];
  const errors = [];
  showMessage('Importando…');
  for (const file of files) {
    const name = nameFromFile(file.name);
    try {
      const xml = await file.text();
      const score = parseMusicXML(xml); // validar antes de guardar
      if (!score.events.length) throw new Error('no tiene notas (solo cifrados)');
      (await lib.putScore(name, xml) ? replaced : added).push(name);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  await refreshLibrary();
  const last = [...added, ...replaced].pop();
  if (last) await selectScore('i:' + last);
  const parts = [];
  if (added.length) parts.push(`Importada${added.length > 1 ? 's' : ''}: ${added.length}`);
  if (replaced.length) parts.push(`Actualizada${replaced.length > 1 ? 's' : ''}: ${replaced.join(', ')}`);
  if (errors.length) parts.push('No se pudo importar — ' + errors.join(' · '));
  showMessage(parts.join(' · '), errors.length > 0);
}

// Borrar con confirmación dentro de la app (algunos navegadores integrados,
// como MIDIWeb, pueden no mostrar la ventana confirm() del sistema).
let deleteArmed = false;
let deleteTimer = 0;
function resetDeleteButton() {
  if (deleteArmed) showMessage('');
  deleteArmed = false;
  clearTimeout(deleteTimer);
  $('btn-delete').classList.remove('danger');
}
async function onDeleteClick() {
  const id = $('score-select').value;
  if (!id.startsWith('i:')) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('btn-delete').classList.add('danger');
    showMessage(`¿Borrar «${id.slice(2)}»? Toca otra vez la papelera.`, true);
    deleteTimer = setTimeout(resetDeleteButton, 4000);
    return;
  }
  resetDeleteButton();
  const name = id.slice(2);
  try {
    await lib.deleteScore(name);
    showMessage(`Borrada: ${name}`);
  } catch (err) {
    showMessage(err.message, true);
  }
  await refreshLibrary();
  await selectScore(library[0]?.id);
}

// ---------- Práctica ----------
// ---------- Práctica ----------
// Dos modos con la misma interfaz (current, held, lastEval, percentages):
// Wait (practice.js) y A tempo (tempo.js). Solo uno está en uso a la vez.
let score = null;
let loop = null;            // {a, b}: compases del bucle, o null
let loopSelecting = false;  // esperando el segundo toque para fijar el final
let shuffle = false;        // tonalidades en orden aleatorio
let reshuffle = null;       // nuevo orden aleatorio (una vez por ronda)
const KEY_MEASURES = 4;     // una tonalidad = una línea del lead sheet (ii, V, I, I)

// Baraja las tonalidades (grupos de 4 compases) de la región; dentro de cada
// una, los acordes siguen en orden. Los tiempos se recolocan seguidos para
// que el modo A tempo los recorra como si fuera una partitura más.
function shuffledEvents(sub, a, b, regionStartQ) {
  const groups = [];
  for (let g = Math.floor(a / KEY_MEASURES) * KEY_MEASURES; g <= b; g += KEY_MEASURES) {
    const ga = Math.max(g, a);
    const gb = Math.min(g + KEY_MEASURES - 1, b);
    const evs = sub.filter((ev) => ev.measureIndex >= ga && ev.measureIndex <= gb);
    if (!evs.length) continue;
    const startQ = score.measures[ga].startQ;
    const lenQ = score.measures[gb].startQ + score.measures[gb].lengthQ - startQ;
    groups.push({ evs, startQ, lenQ });
  }
  for (let i = groups.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [groups[i], groups[j]] = [groups[j], groups[i]];
  }
  const out = [];
  let q = regionStartQ;
  for (const g of groups) {
    for (const ev of g.evs) out.push({ ...ev, startQ: q + (ev.startQ - g.startQ) });
    q += g.lenQ;
  }
  return out;
}

let flashTimer = 0;
function flash() {
  const el = $('played-panel');
  el.classList.add('flash');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('flash'), 180);
}

function onPracticeEvent(e) {
  if (e.type === 'success') flash();
  if (e.type === 'result') {
    leadsheet.setResult(e.event.harmonyIndex, e.result);
    if (settings.mode === 'tempo' && e.result !== 'miss') flash();
  }
  if (e.type === 'newpass') leadsheet.clearResults();
  if (e.type === 'ended') {
    // A tempo terminó la partitura: parar también el audio.
    clearInterval(tickTimer);
    tickTimer = 0;
    audio.cutElement();
    backing.stop();
    updateControls();
  }
  if (e.type === 'pass' && settings.mode === 'wait' && !wait.active) Promise.resolve().then(updateControls);
  if (e.type === 'pass') {
    roundFinished(e);
    // Wait: la ronda siguiente, con otro orden (después de terminar este acorde).
    if (reshuffle && settings.mode === 'wait') Promise.resolve().then(() => wait.reorder(reshuffle()));
  }
  scheduleRender();
}

const wait = new WaitPractice(onPracticeEvent);
const tempo = new TempoPractice({
  now: audio.now,
  sound: { click: audio.click, chord: audio.chord, stopAll: audio.stopAll },
  onChange: onPracticeEvent,
});
const P = () => (settings.mode === 'tempo' ? tempo : wait);

// Ronda terminada: es lo único que se guarda (reiniciar a medias no cuenta).
function roundFinished(e) {
  const fmt = (v) => (v === null ? '—' : Math.round(v) + '%');
  showMessage(`Ronda completa · Exacto ${fmt(e.exact)} · Real ${fmt(e.real)}`);
  const history = store.load('history', []);
  history.push({
    date: new Date().toISOString(),
    score: settings.lastScore,
    mode: settings.mode,
    tempo: settings.mode === 'tempo' ? settings.tempo : null,
    loop: loop ? [loop.a, loop.b] : null,
    shuffle,
    exact: e.exact,
    real: e.real,
    chords: e.stats.done,
  });
  store.save('history', history.slice(-500));
  renderHistory();
}

// La misma partitura puede venir de la carpeta del Mac ('f:archivo.xml') o
// importada ('i:nombre'): el historial la identifica por su nombre.
function scoreKey(id) {
  if (!id) return '';
  return id.startsWith('f:') ? nameFromFile(id.slice(2)) : id.slice(2);
}

// Columnas de rondas anteriores (partitura y modo actuales, sin bucles).
const HISTORY_SHOWN = 40; // más de las que caben: el resto se recorta por abajo
function renderHistory() {
  const rows = store.load('history', [])
    .filter((r) => scoreKey(r.score) === scoreKey(settings.lastScore) && r.mode === settings.mode && !r.loop)
    .slice(-HISTORY_SHOWN - 1);
  for (const [id, key] of [['hist-exact', 'exact'], ['hist-real', 'real']]) {
    const ol = $(id);
    ol.textContent = '';
    const frag = document.createDocumentFragment();
    // De la más reciente a la más antigua, comparando con la anterior.
    for (let i = rows.length - 1; i >= 0 && rows.length - 1 - i < HISTORY_SHOWN; i--) {
      const v = rows[i][key] === null ? null : Math.round(rows[i][key]);
      const prev = i > 0 && rows[i - 1][key] !== null ? Math.round(rows[i - 1][key]) : null;
      const li = document.createElement('li');
      const dt = new Date(rows[i].date);
      const d = document.createElement('span');
      d.className = 'd';
      d.textContent = `${String(dt.getDate()).padStart(2, '0')}/${String(dt.getMonth() + 1).padStart(2, '0')}`;
      const p = document.createElement('span');
      p.textContent = v === null ? '—' : v + '%';
      if (v !== null && prev !== null && v !== prev) p.className = v > prev ? 'up' : 'down';
      li.append(d, p);
      frag.appendChild(li);
    }
    ol.appendChild(frag);
  }
}

// Eventos de la región que se practica (toda la partitura o el bucle).
function applyRegion() {
  stopAll();
  const events = score ? score.events : [];
  let sub = events;
  let region = { startQ: 0, endQ: 0 };
  if (score && score.measures.length) {
    const a = loop ? loop.a : 0;
    const b = loop ? loop.b : score.measures.length - 1;
    sub = events.filter((ev) => ev.measureIndex >= a && ev.measureIndex <= b);
    const mb = score.measures[b];
    region = { startQ: score.measures[a].startQ, endQ: mb.startQ + mb.lengthQ };
  }
  const barQ = score && score.measures.length ? score.measures[0].lengthQ : 4;
  reshuffle = null;
  if (shuffle && score && sub.length) {
    const a = loop ? loop.a : 0;
    const b = loop ? loop.b : score.measures.length - 1;
    reshuffle = () => shuffledEvents(sub, a, b, region.startQ);
  }
  wait.load(reshuffle ? reshuffle() : sub);
  tempo.load(reshuffle ? reshuffle() : sub, region, barQ);
  tempo.orderFor = reshuffle; // A tempo: otro orden en cada pasada
  // Sin bucle, la partitura se toca una vez y se para; con bucle, se repite.
  wait.repeat = tempo.repeat = backing.repeat = !!loop;
  leadsheet.setLoop(loop ? loop.a : null, loop ? loop.b : null);
  leadsheet.clearResults();
  updateControls();
  render();
}

// Parar todo y volver al principio de la región; los porcentajes se descartan.
let tickTimer = 0;
const backing = new Backing();
function stopAll() {
  clearInterval(tickTimer);
  tickTimer = 0;
  audio.cutElement(); // cortar de golpe, sin esperar a que se vacíe el búfer
  backing.stop();
  tempo.stop();
  wait.restart();
  leadsheet.clearResults();
}

function play() {
  audio.unlock();
  audio.loadPiano('sonidos/piano/'); // por si no se cargó al empezar
  if (settings.mode === 'wait') {
    wait.start();
  } else if (!tempo.running) {
    leadsheet.clearResults();
    const withAudio = !!backing.url && !shuffle; // iReal va en su orden: con aleatorio no cuadra
    tempo.setOptions({ countIn: !withAudio }); // el audio de iReal ya trae su cuenta previa
    tempo.start();
    if (withAudio) {
      // El audio trae su compás de cuenta previa: empezar un compás antes.
      audio.routeElement(backing.el);
      audio.restoreElement();
      backing.start({ regionStartQ: tempo.regionStartQ, relQ: tempo.startRelQ - tempo.barQ, bpm: settings.tempo })
        .catch((err) => {
          backing.stop();
          showMessage('No se pudo reproducir el audio: ' + (err.message || err), true);
        });
    }
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      if (withAudio && backing.active) {
        // Hasta que el audio suene de verdad, todo espera (también la cuenta
        // previa), para que los pulsos caigan con el audio. Si el audio
        // falla, backing.active pasa a false y se sigue sin él.
        if (!backing.playing) { tempo.hold(); return; }
        backing.sync(tempo);
      }
      tempo.tick();
    }, 25);
  }
  showMessage('');
  updateControls();
  render();
}

function pause() {
  if (settings.mode === 'wait') wait.pause();
  updateControls();
  render();
}

function restart() {
  stopAll();
  showMessage('');
  updateControls();
  render();
}

function updateControls() {
  const isTempo = settings.mode === 'tempo';
  const running = isTempo ? tempo.running : wait.active;
  $('btn-play').disabled = running || !(score && score.events.length);
  $('btn-pause').disabled = isTempo || !running;
  const st = $('state');
  st.textContent = running ? 'En marcha' : isTempo ? 'Parado' : (wait.index > 0 || wait.stats.done ? 'En pausa' : 'Parado');
  st.classList.toggle('on', running);
  $('btn-mode-wait').classList.toggle('selected', !isTempo);
  $('btn-mode-tempo').classList.toggle('selected', isTempo);
  $('bpm').textContent = settings.tempo;
  $('btn-loop').classList.toggle('selected', !!loop);
  const a = currentAudio();
  $('btn-audio').classList.toggle('selected', settings.audioOn && !!a && !shuffle);
  $('btn-audio').disabled = shuffle;
  $('btn-shuffle').classList.toggle('selected', shuffle);
  $('btn-audio').title = a ? `Audio: ${a.file}` : 'Audio de acompañamiento';
  $('opt-audio-name').textContent = a ? a.file : 'ninguno';
  const as = $('audio-status');
  as.hidden = !a;
  as.classList.toggle('on', !!a && settings.audioOn && !shuffle);
  $('audio-status-name').textContent = a ? a.file.replace(/\.(m4a|aac|mp3|wav)$/i, '') : '';
  as.title = a ? (settings.audioOn ? 'Audio activado' : 'Audio apagado') : '';
}

// ---------- Audio de acompañamiento (iReal) ----------
// Los audios se importan desde iCloud Drive y se guardan en el iPad, como
// las partituras. Cada partitura recuerda el suyo; el botón del ribbon lo
// enciende y apaga (solo suena en A tempo).
function currentAudio() {
  return score ? settings.audioByScore[scoreKey(settings.lastScore)] || null : null;
}

// El audio se reproduce desde un objectURL del archivo guardado; se libera
// al cambiar para no acumular memoria.
let audioUrl = null;
let audioUrlName = null;
let audioToken = 0;
async function updateBackingSource() {
  const token = ++audioToken;
  const a = currentAudio();
  stopAll();
  const want = settings.audioOn && a ? a.file : null;
  if (want !== audioUrlName) {
    let url = null;
    if (want) {
      try {
        const blob = await lib.getAudio(want);
        if (token !== audioToken) return;
        if (blob) url = URL.createObjectURL(blob);
        else showMessage(`El audio «${want}» ya no está en el iPad. Vuelve a importarlo.`, true);
      } catch (err) {
        if (token !== audioToken) return;
        showMessage(err.message, true);
      }
    }
    backing.setSource(url, a ? a.tempo : 60);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = url;
    audioUrlName = url ? want : null;
  } else {
    backing.setSource(backing.url, a ? a.tempo : 60); // solo cambia el tempo de exportación
  }
  updateControls();
  render();
}

async function loadAudioList() {
  try {
    return await lib.listAudios();
  } catch (err) {
    showMessage(err.message, true);
    return [];
  }
}

async function importAudios(files) {
  const done = [];
  const errors = [];
  showMessage('Importando audio…');
  for (const file of files) {
    if (!AUDIO_EXT.test(file.name)) { errors.push(`${file.name}: no es un audio (m4a, mp3, wav)`); continue; }
    try {
      await lib.putAudio(file.name, file);
      done.push(file.name);
    } catch (err) {
      errors.push(`${file.name}: ${err.message}`);
    }
  }
  // Si se ha sustituido el que suena, recargarlo.
  if (done.includes(audioUrlName)) { audioUrlName = null; await updateBackingSource(); }
  showMessage([done.length ? `Audio importado: ${done.join(', ')}` : '', errors.length ? 'No se pudo importar — ' + errors.join(' · ') : '']
    .filter(Boolean).join(' · '), errors.length > 0);
  if (!$('audio-dialog').hidden) renderAudioList();
}

let pickerTempo = 60;
async function openAudioPicker() {
  if (!score) return;
  const cur = currentAudio();
  pickerTempo = cur ? cur.tempo : 60;
  $('audio-tempo').textContent = pickerTempo;
  $('audio-for').textContent = scoreKey(settings.lastScore);
  await renderAudioList();
  $('audio-dialog').hidden = false;
}

let audioDeleteArmed = null;
async function renderAudioList() {
  const cur = currentAudio();
  const list = $('audio-list');
  const files = await loadAudioList();
  list.textContent = '';
  audioDeleteArmed = null;
  if (!files.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Aún no hay audios. Pulsa «Importar audio…» y elige el que exportaste de iReal a iCloud Drive.';
    list.appendChild(p);
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'pick-row';
    const b = document.createElement('button');
    b.textContent = f.replace(AUDIO_EXT, '');
    b.dataset.file = f;
    if (cur && cur.file === f) b.classList.add('selected');
    const del = document.createElement('button');
    del.className = 'tool';
    del.dataset.del = f;
    del.title = 'Borrar este audio del iPad';
    del.setAttribute('aria-label', 'Borrar audio');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
    row.append(b, del);
    list.appendChild(row);
  }
}

$('audio-list').addEventListener('click', async (e) => {
  const d = e.target.closest('button[data-del]');
  if (d) {
    // Borrar con doble toque (confirmación dentro de la app).
    const name = d.dataset.del;
    if (audioDeleteArmed !== name) {
      audioDeleteArmed = name;
      for (const x of $('audio-list').querySelectorAll('button[data-del]')) x.classList.toggle('danger', x === d);
      showMessage(`¿Borrar el audio «${name}» del iPad? Toca otra vez la papelera.`, true);
      return;
    }
    audioDeleteArmed = null;
    try {
      await lib.deleteAudio(name);
      for (const k of Object.keys(settings.audioByScore)) if (settings.audioByScore[k].file === name) delete settings.audioByScore[k];
      saveSettings();
      showMessage(`Audio borrado: ${name}`);
    } catch (err) {
      showMessage(err.message, true);
    }
    await renderAudioList();
    updateBackingSource();
    return;
  }
  const b = e.target.closest('button[data-file]');
  if (!b) return;
  settings.audioByScore[scoreKey(settings.lastScore)] = { file: b.dataset.file, tempo: pickerTempo };
  settings.audioOn = true;
  saveSettings();
  $('audio-dialog').hidden = true;
  updateBackingSource();
});
$('audio-none').addEventListener('click', () => {
  delete settings.audioByScore[scoreKey(settings.lastScore)];
  saveSettings();
  $('audio-dialog').hidden = true;
  updateBackingSource();
});
function changePickerTempo(d) {
  pickerTempo = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, pickerTempo + d));
  $('audio-tempo').textContent = pickerTempo;
  const cur = currentAudio();
  if (cur) { cur.tempo = pickerTempo; saveSettings(); updateBackingSource(); }
}
$('audio-slower').addEventListener('click', () => changePickerTempo(-TEMPO_STEP));
$('audio-faster').addEventListener('click', () => changePickerTempo(TEMPO_STEP));
$('audio-import').addEventListener('click', () => $('audio-input').click());
$('audio-input').addEventListener('change', (e) => {
  const files = e.target.files ? [...e.target.files] : [];
  e.target.value = '';
  if (files.length) importAudios(files);
});
$('audio-close').addEventListener('click', () => { $('audio-dialog').hidden = true; });
$('audio-dialog').addEventListener('click', (e) => { if (e.target === $('audio-dialog')) $('audio-dialog').hidden = true; });
$('opt-audio-pick').addEventListener('click', () => { $('options').hidden = true; openAudioPicker(); });
$('btn-audio').addEventListener('click', () => {
  if (settings.audioOn && currentAudio()) {
    settings.audioOn = false;
    saveSettings();
    updateBackingSource();
  } else if (currentAudio()) {
    settings.audioOn = true;
    saveSettings();
    updateBackingSource();
  } else {
    openAudioPicker();
  }
});

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  const practice = P();
  const ev = practice.current;
  const r = practice.lastEval;
  leadsheet.setCurrent(ev);
  renderPlayed(ev);

  const states = new Map();
  if (ev && r) {
    const showMissing = settings.showNotes || r.hasFreshWrong;
    for (const m of r.missing) if (showMissing) states.set(m, settings.showNotes ? 'expected' : 'missing');
    for (const [m, st] of r.pressed) {
      states.set(m, st === 'ok' ? 'ok' : st === 'wrong' ? 'wrong' : 'held');
    }
  } else if (ev) {
    // Sin contar (parado, en pausa o cuenta previa): solo lo que se pulsa.
    if (settings.showNotes) for (const n of ev.notes) states.set(n.midi, 'expected');
    for (const m of practice.held.keys()) states.set(m, 'held');
  }
  keyboard.setStates(states);
  renderStats();
}

// Visor del acorde tocado: lectura literal de lo que suena ahora mismo.
let lastPlayedKey = '';
function renderPlayed(ev) {
  const notes = [...P().held.keys()];
  const key = notes.sort((a, b) => a - b).join(',') + '|' + (ev ? ev.symbol : '');
  if (key === lastPlayedKey) return;
  lastPlayedKey = key;
  const { name, notes: names } = detectChord(notes, ev ? ev.symbol : '');
  $('played').textContent = notes.length ? (name || '?') : '—';
  $('played-notes').textContent = names;
}

function renderStats() {
  const { exact, real } = P().percentages;
  const fmt = (v) => (v === null ? '—' : Math.round(v) + '%');
  $('pct-exact').textContent = fmt(exact);
  $('pct-real').textContent = fmt(real);
}

function showMessage(text, isError = false) {
  const el = $('message');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

// ---------- Entrada ----------
function press(midi) {
  P().noteOn(midi);
}
function release(midi) {
  P().noteOff(midi);
}

const keyboard = new Keyboard($('keyboard'), { onPress: press, onRelease: release });

// Tocar un compás del lead sheet: con el bucle activo, elige su inicio y
// final; si no, salta a ese compás.
const leadsheet = new LeadSheet($('leadsheet'), (measureIndex) => {
  if (loop) {
    if (!loopSelecting) {
      loop = { a: measureIndex, b: measureIndex };
      loopSelecting = true;
      applyRegion();
      showMessage('Toca el último compás del bucle.');
    } else {
      loop = { a: Math.min(loop.a, measureIndex), b: Math.max(loop.a, measureIndex) };
      loopSelecting = false;
      applyRegion();
      showMessage(`Bucle: compases ${score.measures[loop.a].number}–${score.measures[loop.b].number}`);
    }
    return;
  }
  const practice = P();
  if (practice === tempo && tempo.running) return; // en marcha no se salta
  // Primer acorde de ese compás o, si no tiene, el siguiente de su tonalidad.
  const row = Math.floor(measureIndex / KEY_MEASURES);
  let i = practice.events.findIndex((e) => Math.floor(e.measureIndex / KEY_MEASURES) === row && e.measureIndex >= measureIndex);
  if (i < 0) i = practice.events.findIndex((e) => e.measureIndex >= measureIndex);
  if (i >= 0) practice.goTo(i);
  updateControls();
});

onNoteOn((note) => press(note));
onNoteOff((note) => release(note));

onStateChange((st) => {
  const chip = $('midi-status');
  if (!st.supported) {
    chip.textContent = 'MIDI: no disponible';
    chip.className = 'midi off';
    if (st.error) showMessage(st.error, true);
  } else if (!st.inputs.length) {
    chip.textContent = 'MIDI: sin dispositivos';
    chip.className = 'midi off';
  } else {
    chip.textContent = 'MIDI: ' + st.inputs.join(', ');
    chip.className = 'midi on';
  }
});

// ---------- Controles ----------
const optShow = $('opt-show');
optShow.checked = settings.showNotes;
optShow.addEventListener('change', () => {
  settings.showNotes = optShow.checked;
  saveSettings();
  render();
});

function renderRootOption() {
  for (const b of $('opt-root').querySelectorAll('button')) {
    b.classList.toggle('selected', b.dataset.range === settings.rootRange);
  }
}
$('opt-root').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !(b.dataset.range in ROOT_RANGES)) return;
  settings.rootRange = b.dataset.range;
  saveSettings();
  renderRootOption();
  renderKeysOption();
  wait.setOptions(matchOptions());
  tempo.setOptions(matchOptions());
  if (score) setupKeyboardRange(score.events);
});

function renderKeysOption() {
  for (const b of $('opt-keys').querySelectorAll('button[data-zone]')) {
    b.classList.toggle('selected', !!settings.keys[b.dataset.zone]);
  }
}
$('opt-keys').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-zone]');
  if (!b) return;
  const zone = b.dataset.zone;
  const on = !settings.keys[zone];
  if (zone === 'left') {
    settings.keys.left = on;
  } else {
    // El teclado es continuo: C6 incluye C5, y el ✱ derecho incluye ambas.
    const i = RIGHT_ZONES.indexOf(zone);
    RIGHT_ZONES.forEach((name, j) => {
      if (on && j <= i) settings.keys[name] = true;
      if (!on && j >= i) settings.keys[name] = false;
    });
  }
  saveSettings();
  renderKeysOption();
  if (score) setupKeyboardRange(score.events);
  render();
});

$('btn-options').addEventListener('click', () => { $('options').hidden = false; });
$('btn-close-options').addEventListener('click', () => { $('options').hidden = true; });
$('options').addEventListener('click', (e) => {
  if (e.target === $('options')) $('options').hidden = true; // tocar fuera cierra
});

// A tempo
const optMetro = $('opt-metronome');
const optChords = $('opt-chords');
optMetro.checked = settings.metronome;
optChords.checked = settings.playChords;
function tempoOptions() {
  tempo.setOptions({ metronome: settings.metronome, playChords: settings.playChords, marginBeats: settings.marginBeats });
}
optMetro.addEventListener('change', () => { settings.metronome = optMetro.checked; saveSettings(); tempoOptions(); });
optChords.addEventListener('change', () => { settings.playChords = optChords.checked; saveSettings(); tempoOptions(); });
function renderMarginOption() {
  for (const b of $('opt-margin').querySelectorAll('button')) {
    b.classList.toggle('selected', Number(b.dataset.margin) === settings.marginBeats);
  }
}
$('opt-margin').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-margin]');
  if (!b) return;
  settings.marginBeats = Number(b.dataset.margin);
  saveSettings();
  renderMarginOption();
  tempoOptions();
});

// Volúmenes (mitad del recorrido = volumen del iPad)
for (const [id, key, apply] of [
  ['opt-vol-audio', 'volAudio', audio.setElementVolume],
  ['opt-vol-chord', 'volChord', audio.setChordVolume],
]) {
  const el = $(id);
  el.value = settings[key];
  apply(settings[key]);
  el.addEventListener('input', () => {
    settings[key] = Number(el.value);
    apply(settings[key]);
    saveSettings();
  });
}

// Transporte y modo
$('btn-play').addEventListener('click', play);
$('btn-pause').addEventListener('click', pause);
$('btn-restart').addEventListener('click', restart);
function setMode(mode) {
  if (settings.mode === mode) return;
  stopAll();
  settings.mode = mode;
  saveSettings();
  renderHistory();
  showMessage('');
  updateControls();
  render();
}
$('btn-mode-wait').addEventListener('click', () => setMode('wait'));
$('btn-mode-tempo').addEventListener('click', () => setMode('tempo'));
function changeTempo(delta) {
  settings.tempo = Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, settings.tempo + delta));
  tempo.setTempo(settings.tempo); // también mientras suena
  backing.setTempo(settings.tempo);
  saveSettings();
  updateControls();
}
$('btn-slower').addEventListener('click', () => changeTempo(-TEMPO_STEP));
$('btn-faster').addEventListener('click', () => changeTempo(TEMPO_STEP));
$('btn-shuffle').addEventListener('click', () => {
  shuffle = !shuffle;
  showMessage(shuffle ? 'Tonalidades en orden aleatorio (sin audio de iReal).' : '');
  applyRegion();
});
$('btn-loop').addEventListener('click', () => {
  loopSelecting = false;
  if (loop) {
    loop = null;
    showMessage('');
  } else if (score && score.measures.length) {
    // Por defecto, la línea actual (4 compases = una tonalidad).
    const cur = P().current;
    const a = cur ? cur.measureIndex - (cur.measureIndex % 4) : 0;
    loop = { a, b: Math.min(a + 3, score.measures.length - 1) };
    showMessage('Bucle en esta línea. Para elegir otro, toca el primer y el último compás.');
  } else {
    return;
  }
  applyRegion();
});
$('score-select').addEventListener('change', (e) => { showMessage(''); selectScore(e.target.value); });
$('btn-import').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => {
  const files = e.target.files ? [...e.target.files] : [];
  e.target.value = '';
  if (files.length) importFiles(files);
});
$('btn-delete').addEventListener('click', onDeleteClick);

// Si la app pasa a segundo plano (iPad bloqueado, otra app), iOS congela el
// audio: mejor parar limpio que volver con el reloj desfasado.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && tempo.running) restart();
});

// ---------- Copia de seguridad (ajustes + historial) ----------
// Un archivo .json que el usuario guarda donde quiera (iCloud Drive). Las
// partituras y los audios no van dentro: sus originales ya están en iCloud.
const BACKUP_APP = 'jazz-piano-trainer';
const BACKUP_OLD_DAYS = 7;

function renderBackupAge() {
  const el = $('backup-age');
  const last = settings.lastBackup ? new Date(settings.lastBackup) : null;
  if (!last || Number.isNaN(last.getTime())) {
    el.textContent = 'Aún no has guardado ninguna copia';
    el.classList.add('old');
    return;
  }
  const days = Math.floor((Date.now() - last.getTime()) / 86400000);
  el.textContent = days <= 0 ? 'Última copia: hoy' : days === 1 ? 'Última copia: ayer' : `Última copia: hace ${days} días`;
  el.classList.toggle('old', days >= BACKUP_OLD_DAYS);
}

async function saveBackup() {
  const now = new Date();
  const data = {
    app: BACKUP_APP,
    version: 1,
    date: now.toISOString(),
    settings: { ...settings, lastBackup: now.toISOString() },
    history: store.load('history', []),
  };
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const name = `jazz-piano-trainer-copia-${stamp}.json`;
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const file = new File([blob], name, { type: 'application/json' });
  let done = false;
  // 1) Hoja de compartir del sistema (en el iPad: «Guardar en Archivos»).
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Copia de Jazz Piano Trainer' });
      done = true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') { showMessage('Copia cancelada.'); return; }
  }
  // 2) Descarga normal.
  if (!done) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    done = true;
  }
  settings.lastBackup = now.toISOString();
  saveSettings();
  renderBackupAge();
  showMessage(`Copia preparada: ${name}. Guárdala en iCloud Drive.`);
}

async function restoreBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showMessage('Ese archivo no es una copia de la app.', true);
    return;
  }
  if (!data || data.app !== BACKUP_APP || !data.settings || !Array.isArray(data.history)) {
    showMessage('Ese archivo no es una copia de la app.', true);
    return;
  }
  // Historial: se juntan el actual y el de la copia (nada se pierde).
  const key = (r) => `${r.date}|${r.score}|${r.mode}`;
  const merged = new Map(store.load('history', []).map((r) => [key(r), r]));
  for (const r of data.history) if (r && r.date) merged.set(key(r), r);
  const history = [...merged.values()].sort((x, y) => String(x.date).localeCompare(String(y.date)));
  store.save('history', history.slice(-500));
  // Ajustes: los de la copia, pero sin cambiar la partitura abierta.
  const restored = { ...data.settings, lastScore: settings.lastScore };
  store.save('settings', restored);
  const d = new Date(data.date);
  showMessage(`Copia del ${d.getDate()}/${d.getMonth() + 1} restaurada. Recargando…`);
  stopAll();
  setTimeout(() => location.reload(), 900);
}

$('btn-backup').addEventListener('click', saveBackup);
$('btn-restore').addEventListener('click', () => $('restore-input').click());
$('restore-input').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) restoreBackup(file);
});

// Versión publicada (https): guardar la app para abrirla sin conexión.
if (location.protocol === 'https:' && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo sin conexión */ });
}

// Acceso para las pruebas automáticas (solo con index.html?pruebas).
if (/[?&]pruebas\b/.test(location.search)) window.__app = { tempo, wait, backing, audio };

// ---------- Arranque ----------
$('btn-start').addEventListener('click', async () => {
  $('start').hidden = true;
  audio.unlock();
  audio.loadPiano('sonidos/piano/'); // en segundo plano
  await initMidi();
});

(async function boot() {
  renderRootOption();
  renderKeysOption();
  renderMarginOption();
  renderBackupAge();
  wait.setOptions(matchOptions());
  tempo.setOptions(matchOptions());
  tempoOptions();
  tempo.setTempo(settings.tempo);
  updateControls();
  lib.requestPersistence();
  await refreshLibrary();
  await selectScore(settings.lastScore);
})();
