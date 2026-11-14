// Modo A tempo: el ejercicio avanza solo, al tempo, con metrónomo.
// La app hace sonar cada acorde en su momento y el usuario lo toca justo
// después, dentro de un margen (en tiempos). Cada acorde queda como:
//   'ok'   a tiempo y sin notas erróneas
//   'late' completado, pero fuera de margen o con alguna nota errónea
//   'miss' no completado antes del siguiente acorde
//
// Un único reloj: el del AudioContext (inyectado como now()), con
// planificación por anticipación desde tick(), que la interfaz llama cada
// ~25 ms. Toda la posición se lleva en negras (Q); el tempo solo cambia la
// conversión Q -> segundos, así que se puede cambiar mientras suena.
// Sin DOM: se prueba con un reloj falso.

import { evaluate } from './matcher.js';

const LOOKAHEAD = 0.15;  // s que se programan por adelantado
const EARLY = 0.08;      // s: se acepta empezar el acorde un poco antes

export class TempoPractice {
  /**
   * @param {{now:()=>number, sound:{click:Function, chord:Function, stopAll:Function},
   *          onChange:(e:object)=>void}} deps
   */
  constructor({ now, sound, onChange }) {
    this.now = now;
    this.sound = sound;
    this.onChange = onChange;
    this.events = [];
    this.region = { startQ: 0, lenQ: 0 };
    this.barQ = 4;
    this.bpm = 60;
    // countIn: pulsos de la cuenta previa (no con audio de iReal, que trae la suya).
    this.opts = { flexRoot: true, marginBeats: 1, metronome: true, playChords: true, countIn: true };
    this.held = new Map();
    this.running = false;
    this.startIndex = 0;
    this.cur = null;
    this.lastEval = null;
    // Orden distinto en cada pasada (aleatorio): orderFor(pass) devuelve los
    // acordes de esa pasada (mismos acordes y misma duración total).
    this.orderFor = null;
    // Sin bucle la partitura se toca una vez y para; con bucle se repite.
    this.repeat = true;
    this.passEvents = new Map();
    this.resetStats();
  }

  resetStats() {
    this.stats = { done: 0, firstTry: 0, hits: 0, misses: 0 };
  }

  get percentages() {
    const s = this.stats;
    return {
      exact: s.done ? (100 * s.firstTry) / s.done : null,
      real: s.hits + s.misses ? (100 * s.hits) / (s.hits + s.misses) : null,
    };
  }

  /** Acorde que se muestra: el que se está juzgando o el de salida. */
  get index() { return this.cur ? this.cur.idx : this.startIndex; }
  get current() {
    return (this.cur ? this._evs(this.cur.pass)[this.cur.idx] : this.events[this.startIndex]) || null;
  }

  _evs(pass) {
    if (!this.orderFor || pass === 0) return this.events;
    let evs = this.passEvents.get(pass);
    if (!evs) {
      evs = this.orderFor(pass);
      this.passEvents.set(pass, evs);
      for (const k of this.passEvents.keys()) if (k < pass - 1) this.passEvents.delete(k);
    }
    return evs;
  }
  /** true mientras cuenta (no durante la cuenta previa). */
  get counting() { return this.running && !!this.cur; }

  /**
   * @param {Array} events acordes de la región (todo o el bucle)
   * @param {{startQ:number, endQ:number}} region
   * @param {number} barQ negras por compás
   */
  load(events, region, barQ = 4) {
    this.stop();
    this.events = events;
    this.region = { startQ: region.startQ, lenQ: region.endQ - region.startQ };
    this.barQ = barQ;
    this.startIndex = 0;
    this.resetStats();
    this.onChange({ type: 'update' });
  }

  setOptions(opts) { this.opts = { ...this.opts, ...opts }; }

  goTo(i) {
    if (this.running || !this.events.length) return;
    this.startIndex = Math.max(0, Math.min(i, this.events.length - 1));
    this.onChange({ type: 'update' });
  }

  get spb() { return 60 / this.bpm; }
  _q(t) { return this.anchorQ + (t - this.anchorT) / this.spb; }
  _t(q) { return this.anchorT + (q - this.anchorQ) * this.spb; }
  _ev(p) { return this._evs(p.pass)[p.idx]; }
  _rel(p) { return this._ev(p).startQ - this.region.startQ; }
  _eventQ(p) { return p.pass * this.region.lenQ + this._rel(p); }
  _next(p) {
    return p.idx + 1 < this.events.length ? { pass: p.pass, idx: p.idx + 1 } : { pass: p.pass + 1, idx: 0 };
  }

  setTempo(bpm) {
    if (this.running) {
      const t = this.now();
      this.anchorQ = this._q(t);
      this.anchorT = t;
    }
    this.bpm = bpm;
  }

  /** Posición actual (en negras desde el inicio de la región; negativa en la cuenta previa). */
  positionQ() { return this.running ? this._q(this.now()) : null; }

  /**
   * Fija la posición actual (lo usa el audio de acompañamiento: el transporte
   * sigue al audio). Avanzar así cuenta igual que si pasara el tiempo.
   */
  syncTo(q) {
    if (!this.running) return;
    this.anchorQ = q;
    this.anchorT = this.now();
  }

  get regionLenQ() { return this.region.lenQ; }
  get regionStartQ() { return this.region.startQ; }
  get startRelQ() { return this.events.length ? this._rel({ pass: 0, idx: this.startIndex }) : 0; }

  start() {
    if (!this.events.length) return;
    this.stop();
    this.resetStats();
    this.passEvents.clear();
    this.running = true;
    const first = { pass: 0, idx: this.startIndex };
    const q0 = this._eventQ(first);
    // Un compás de cuenta previa.
    this.anchorQ = q0 - this.barQ;
    this.startQ = this.anchorQ;
    this.firstQ = q0; // hasta aquí, cuenta previa: suena aunque el metrónomo esté apagado
    this.anchorT = this.now() + 0.1;
    this.nextBeatQ = Math.ceil(this.anchorQ - 1e-9);
    this.nextSound = first;
    this.pending = first;
    this.cur = null;
    // La primera pasada solo cuenta como ronda si empieza desde el principio.
    this.passFromStart = this.startIndex === 0;
    this.onChange({ type: 'update' });
  }

  /** Mantiene el transporte al principio (esperando a que arranque el audio). */
  hold() {
    if (!this.running) return;
    this.anchorQ = this.startQ;
    this.anchorT = this.now() + 0.05;
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.cur = null;
    this.sound.stopAll();
    this.onChange({ type: 'update' });
  }

  /** Planifica sonidos y avanza el acorde. Llamar cada ~25 ms. */
  tick() {
    if (!this.running) return;
    const t = this.now();
    const horizonQ = this._q(t + LOOKAHEAD);

    const endQ = this.repeat ? Infinity : this.region.lenQ;
    while (this.nextBeatQ <= horizonQ && this.nextBeatQ < endQ) {
      if (this.nextBeatQ < this.firstQ ? this.opts.countIn : this.opts.metronome) {
        const accent = ((this.nextBeatQ % this.barQ) + this.barQ) % this.barQ === 0;
        this.sound.click(this._t(this.nextBeatQ), accent);
      }
      this.nextBeatQ += 1;
    }
    while ((this.repeat || this.nextSound.pass === 0) && this._eventQ(this.nextSound) <= horizonQ) {
      const p = this.nextSound;
      const n = this._next(p);
      if (this.opts.playChords) {
        const q = this._eventQ(p);
        const dur = (this._eventQ(n) - q) * this.spb;
        this.sound.chord(this._ev(p).notes.map((x) => x.midi), this._t(q), dur);
      }
      this.nextSound = n;
    }

    let changed = false;
    const nowQ = this._q(t);
    while (this.running && this._eventQ(this.pending) - EARLY / this.spb <= nowQ) {
      this._advance(this.pending);
      changed = true;
    }
    if (changed) this.onChange({ type: 'update' });
  }

  _advance(p) {
    const prev = this.cur;
    if (prev && !prev.done) {
      // No completado: todas sus notas cuentan como fallo.
      this.stats.done++;
      this.stats.misses += this._ev(prev).notes.length;
      this._result(this._ev(prev), 'miss');
    }
    if (prev && p.pass !== prev.pass) {
      // Fin de una pasada por la región.
      if (this.passFromStart) this.onChange({ type: 'pass', stats: { ...this.stats }, ...this.percentages });
      if (!this.repeat) {
        // Fin de la partitura: parar (los resultados se quedan a la vista).
        this.stop();
        this.startIndex = 0;
        this.onChange({ type: 'ended' });
        return;
      }
      this.passFromStart = true;
      this.resetStats();
      this.onChange({ type: 'newpass' });
    }
    this.cur = { ...p, done: false, hadError: false, startT: this._t(this._eventQ(p)) };
    this.pending = this._next(p);
    // Lo que ya estaba pulsado no cuenta: cada acorde se vuelve a tocar.
    for (const m of this.held.keys()) this.held.set(m, false);
    this._evaluate(null);
  }

  _result(event, result) {
    this.onChange({ type: 'result', event, result });
  }

  noteOn(midi) {
    this.held.set(midi, true);
    this._evaluate(midi);
    this.onChange({ type: 'update' });
  }

  noteOff(midi) {
    this.held.delete(midi);
    this._evaluate(null);
    this.onChange({ type: 'update' });
  }

  _evaluate(pressedNow) {
    const c = this.cur;
    if (!this.running || !c) { this.lastEval = null; return; }
    const ev = this._ev(c);
    const r = evaluate(ev.notes, this.held, this.opts);
    this.lastEval = r;
    if (c.done) return;
    if (pressedNow !== null && r.pressed.get(pressedNow) === 'wrong') {
      this.stats.misses++;
      c.hadError = true;
    }
    if (r.success) {
      c.done = true;
      this.stats.done++;
      this.stats.hits += ev.notes.length;
      const inTime = this.now() <= c.startT + this.opts.marginBeats * this.spb;
      const exact = inTime && !c.hadError;
      if (exact) this.stats.firstTry++;
      this._result(ev, exact ? 'ok' : 'late');
    }
  }
}
