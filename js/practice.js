// Modo Esperar: no avanza hasta que el acorde pulsado es exactamente el
// escrito. Lógica sin DOM: avisa a la interfaz mediante onChange.
// Solo cuenta mientras está activo (Empezar); en pausa o sin empezar se
// puede tocar libremente sin que afecte al ejercicio.

import { evaluate } from './matcher.js';

export class WaitPractice {
  constructor(onChange) {
    this.onChange = onChange;
    this.events = [];
    this.index = 0;
    this.held = new Map();   // midi -> fresca (pulsada tras empezar el acorde)
    this.opts = { flexRoot: true };
    this.lastEval = null;
    this.active = false;
    this.passFromStart = true; // la ronda solo vale si se empezó desde el principio
    this.repeat = true;        // sin bucle, al acabar la partitura se para
    this.resetStats();
  }

  start() {
    if (this.active || !this.events.length) return;
    this.active = true;
    if (this.resetOnNextNote) {
      this.resetStats();
      this.onChange({ type: 'newpass' });
    }
    // Lo que ya estaba pulsado antes de Empezar no cuenta.
    for (const m of this.held.keys()) this.held.set(m, false);
    this._evaluate();
  }

  pause() {
    this.active = false;
    this._evaluate();
  }

  resetStats() {
    // done/firstTry: acordes completados y acordes a la primera (Exacto).
    // hits/misses: notas correctas de los acordes completados y notas
    // erróneas pulsadas (cada pulsación cuenta) -> Real.
    this.stats = { done: 0, firstTry: 0, errors: 0, passes: 0, hits: 0, misses: 0 };
    this.eventHadError = false;
    this.resetOnNextNote = false;
  }

  load(events) {
    this.events = events;
    this.index = 0;
    this.resetStats();
    this._startEvent();
  }

  setOptions(opts) {
    this.opts = { ...this.opts, ...opts };
    this._evaluate();
  }

  /** Cambia el orden de los acordes sin tocar los porcentajes (aleatorio, entre rondas). */
  reorder(events) {
    this.events = events;
    if (this.index >= events.length) this.index = 0;
    this._startEvent();
  }

  get current() { return this.events[this.index] || null; }
  get next() {
    if (!this.events.length) return null;
    return this.events[(this.index + 1) % this.events.length];
  }

  goTo(i) {
    if (!this.events.length) return;
    this.index = ((i % this.events.length) + this.events.length) % this.events.length;
    // Saltar invalida la ronda en curso; saltar al principio empieza una nueva.
    this.passFromStart = this.index === 0;
    if (this.index === 0) {
      this.resetStats();
      this.onChange({ type: 'newpass' });
    }
    this._startEvent();
  }

  /** Porcentajes 0..100, o null si aún no hay datos. */
  get percentages() {
    const s = this.stats;
    return {
      exact: s.done ? (100 * s.firstTry) / s.done : null,
      real: s.hits + s.misses ? (100 * s.hits) / (s.hits + s.misses) : null,
    };
  }

  restart() {
    this.active = false;
    this.resetStats();
    this.goTo(0);
  }

  noteOn(midi) {
    // Tras completar una pasada, los porcentajes se quedan a la vista hasta
    // que empieza la siguiente.
    if (this.active && this.resetOnNextNote) {
      this.resetStats();
      this.onChange({ type: 'newpass' });
    }
    this.held.set(midi, true);
    this._evaluate(midi);
  }

  noteOff(midi) {
    this.held.delete(midi);
    this._evaluate(null, true);
  }

  releaseAll() {
    this.held.clear();
    this._evaluate();
  }

  _startEvent() {
    // Lo que ya estaba pulsado deja de contar como pulsación nueva:
    // cada acorde hay que volver a tocarlo.
    for (const m of this.held.keys()) this.held.set(m, false);
    this.eventHadError = false;
    this._evaluate();
  }

  /** @param {number|null} pressedNow nota recién pulsada, si la hay */
  _evaluate(pressedNow = null, released = false) {
    const fromInput = pressedNow !== null || released;
    const ev = this.current;
    if (!ev) {
      this.lastEval = null;
      this.onChange({ type: 'update' });
      return;
    }
    if (!this.active) {
      this.lastEval = null;
      this.onChange({ type: 'update' });
      return;
    }
    const r = evaluate(ev.notes, this.held, this.opts);
    this.lastEval = r;

    if (pressedNow !== null && r.pressed.get(pressedNow) === 'wrong') this.stats.misses++;
    if (fromInput && r.hasFreshWrong && !this.eventHadError) {
      this.eventHadError = true;
      this.stats.errors++;
    }

    if (fromInput && r.success) {
      this.stats.done++;
      this.stats.hits += ev.notes.length;
      if (!this.eventHadError) this.stats.firstTry++;
      const finishedPass = this.index === this.events.length - 1;
      this.onChange({ type: 'result', event: ev, result: this.eventHadError ? 'late' : 'ok' });
      if (finishedPass) {
        this.stats.passes++;
        this.resetOnNextNote = true;
        if (this.passFromStart) this.onChange({ type: 'pass', stats: { ...this.stats }, ...this.percentages });
        this.passFromStart = true;
        if (!this.repeat) this.active = false; // fin de la partitura: parar
      }
      this.onChange({ type: 'success', finishedPass });
      this.index = (this.index + 1) % this.events.length;
      this._startEvent();
      return;
    }
    this.onChange({ type: 'update' });
  }
}
