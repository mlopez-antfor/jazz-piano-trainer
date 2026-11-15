// Teclado en pantalla. Se construye una sola vez por rango; después solo se
// cambian clases CSS de las teclas que cambian (nada de redibujar).
// También sirve de entrada táctil para probar sin piano.

const BLACK = new Set([1, 3, 6, 8, 10]);
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

export function noteName(midi) {
  return NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

export class Keyboard {
  /**
   * @param {HTMLElement} container
   * @param {{onPress:(midi:number)=>void, onRelease:(midi:number)=>void}} handlers
   */
  constructor(container, handlers) {
    this.container = container;
    this.handlers = handlers;
    this.keys = new Map();      // midi -> elemento
    this.current = new Map();   // midi -> clase aplicada
    this.latch = false;
    this.touchHeld = new Set(); // notas mantenidas desde la pantalla
    this.pointerNote = new Map(); // pointerId -> midi
    this.range = null;

    this._down = this._down.bind(this);
    this._up = this._up.bind(this);
    container.addEventListener('pointerdown', this._down);
    container.addEventListener('pointerup', this._up);
    container.addEventListener('pointercancel', this._up);
    container.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setRange(lo, hi) {
    // Empezar y acabar en tecla blanca, sin salir del piano de 88 teclas
    // (A0–C8). Las zonas de las opciones ya vienen en Do.
    if (BLACK.has(lo % 12)) lo -= 1;
    if (BLACK.has(hi % 12)) hi += 1;
    lo = Math.max(21, lo);
    hi = Math.min(108, hi);
    if (this.range && this.range[0] === lo && this.range[1] === hi) return;
    this.releaseAllTouch();
    this.range = [lo, hi];
    this.keys.clear();
    this.current.clear();
    this.container.textContent = '';

    const whites = [];
    for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
    const w = 100 / whites.length;

    const frag = document.createDocumentFragment();
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const el = document.createElement('div');
      el.dataset.midi = String(m);
      if (BLACK.has(m % 12)) {
        el.className = 'key black';
        el.style.left = `${wi * w - w * 0.3}%`;
        el.style.width = `${w * 0.6}%`;
      } else {
        el.className = 'key white';
        el.style.left = `${wi * w}%`;
        el.style.width = `${w}%`;
        if (m % 12 === 0) {
          const lab = document.createElement('span');
          lab.className = 'label';
          lab.textContent = noteName(m);
          el.appendChild(lab);
        }
        wi++;
      }
      this.keys.set(m, el);
      frag.appendChild(el);
    }
    this.container.appendChild(frag);
  }

  /** @param {Map<number,string>} states midi -> clase ('expected','ok',...) */
  setStates(states) {
    for (const [m, cls] of this.current) {
      if (states.get(m) !== cls) {
        const el = this.keys.get(m);
        if (el) el.classList.remove(...cls.split(' '));
        this.current.delete(m);
      }
    }
    for (const [m, cls] of states) {
      if (this.current.get(m) === cls) continue;
      const el = this.keys.get(m);
      if (!el) continue;
      el.classList.add(...cls.split(' '));
      this.current.set(m, cls);
    }
  }

  setLatch(on) {
    this.latch = !!on;
    if (!this.latch) this.releaseAllTouch();
  }

  releaseAllTouch() {
    for (const m of this.touchHeld) this.handlers.onRelease(m);
    this.touchHeld.clear();
    this.pointerNote.clear();
  }

  _noteFromEvent(e) {
    const el = e.target.closest ? e.target.closest('.key') : null;
    return el ? Number(el.dataset.midi) : null;
  }

  _down(e) {
    const m = this._noteFromEvent(e);
    if (m === null) return;
    e.preventDefault();
    if (this.latch) {
      if (this.touchHeld.has(m)) {
        this.touchHeld.delete(m);
        this.handlers.onRelease(m);
      } else {
        this.touchHeld.add(m);
        this.handlers.onPress(m);
      }
      return;
    }
    this.pointerNote.set(e.pointerId, m);
    this.touchHeld.add(m);
    this.handlers.onPress(m);
  }

  _up(e) {
    if (this.latch) return;
    const m = this.pointerNote.get(e.pointerId);
    if (m === undefined) return;
    this.pointerNote.delete(e.pointerId);
    this.touchHeld.delete(m);
    this.handlers.onRelease(m);
  }
}
