// Audio de acompañamiento (exportado de iReal Pro) para el modo A tempo.
//
// Se reproduce con un elemento <audio> (en streaming: no se carga entero en
// memoria) y con preservesPitch, así que al cambiar el tempo no cambia el
// tono. El audio manda: en cada tick se calcula en qué negra de la
// partitura está y el transporte se ajusta a él.
//
// Formato esperado (exportado con Veces = 1): un compás de cuenta previa al
// tempo de exportación y después la partitura desde el compás 1.

const SYNC_TOLERANCE = 0.015; // s
const WRAP_EARLY = 0.02;      // negras: saltar al inicio un pelín antes del final

export class Backing {
  constructor() {
    this.el = null;
    this.url = null;
    this.audioTempo = 60;
    this.countInQ = 4;
    this.active = false;
    this.pass = 0;
    this.playing = false; // ya ha empezado a sonar de verdad
    this.repeat = true;   // al acabar la región, volver a su inicio (bucle)
  }

  _element() {
    if (!this.el) {
      const el = new Audio();
      el.preload = 'auto';
      el.preservesPitch = true;
      el.webkitPreservesPitch = true;
      el.addEventListener('playing', () => { if (this.active) this.playing = true; });
      this.el = el;
    }
    return this.el;
  }

  /** @param {string|null} url  @param {number} audioTempo tempo al que se exportó */
  setSource(url, audioTempo = 60) {
    this.stop();
    this.audioTempo = audioTempo;
    if (url === this.url) return;
    this.url = url;
    const el = this._element();
    if (url) {
      el.src = url;
      el.load();
    } else {
      el.removeAttribute('src');
      el.load(); // libera el archivo
    }
  }

  get spm() { return 60 / this.audioTempo; } // segundos de audio por negra
  _timeOf(scoreQ) { return Math.max(0, (this.countInQ + scoreQ) * this.spm); }

  /**
   * Empezar a sonar para que la negra `relQ` de la región caiga en su sitio
   * (relQ negativa = cuenta previa). Devuelve la promesa de play().
   */
  start({ regionStartQ, relQ, bpm }) {
    const el = this._element();
    if (!this.url) return Promise.reject(new Error('Sin audio'));
    this.active = true;
    this.playing = false;
    this.pass = 0;
    this.regionStartQ = regionStartQ;
    el.playbackRate = bpm / this.audioTempo;
    el.currentTime = this._timeOf(regionStartQ + relQ);
    return el.play();
  }

  setTempo(bpm) {
    if (this.el) this.el.playbackRate = bpm / this.audioTempo;
  }

  stop() {
    this.active = false;
    this.playing = false;
    if (this.el) this.el.pause();
  }

  /**
   * Ajusta el transporte al audio. Llamar en cada tick antes de tempo.tick().
   * @param {import('./tempo.js').TempoPractice} tempo
   */
  sync(tempo) {
    const el = this.el;
    if (!this.active || !el || el.seeking || el.readyState < 2) return;
    const lenQ = tempo.regionLenQ;
    const scoreQ = el.currentTime / this.spm - this.countInQ;
    const rel = scoreQ - this.regionStartQ;
    if (this.repeat && lenQ > 0 && rel >= lenQ - WRAP_EARLY) {
      // Fin de la región: volver a su inicio (sin cuenta previa).
      this.pass++;
      el.currentTime = this._timeOf(this.regionStartQ + rel - lenQ);
      return;
    }
    const q = this.pass * lenQ + rel;
    const cur = tempo.positionQ();
    if (cur === null) return;
    if (Math.abs(q - cur) * (60 / tempo.bpm) > SYNC_TOLERANCE) tempo.syncTo(q);
  }
}
