// Lead sheet: cuadrícula de compases con los cifrados, 4 compases por línea.
// Se dibuja una vez al cargar la partitura; después solo se mueve el
// resaltado del acorde actual (nada de redibujar).

const PER_ROW = 4;

export class LeadSheet {
  /**
   * @param {HTMLElement} container elemento con scroll
   * @param {(measureIndex:number)=>void} onMeasureTap
   */
  constructor(container, onMeasureTap) {
    this.container = container;
    this.cells = [];   // measureIndex -> celda
    this.chords = [];  // harmonyIndex -> span
    this.currentCell = null;
    this.currentChord = null;
    this.currentRow = -1;
    this.marked = new Set();
    container.addEventListener('click', (e) => {
      const cell = e.target.closest ? e.target.closest('.ls-measure') : null;
      if (cell) onMeasureTap(Number(cell.dataset.measure));
    });
  }

  /** @param {{measures:Array, harmonies:Array}} score */
  load(score) {
    this.container.textContent = '';
    this.cells = [];
    this.chords = [];
    this.marked = new Set();
    this.currentCell = this.currentChord = null;
    this.currentRow = -1;
    if (!score) return;

    const byMeasure = score.measures.map(() => []);
    for (const h of score.harmonies) byMeasure[h.measureIndex]?.push(h);

    const frag = document.createDocumentFragment();
    let row = null;
    score.measures.forEach((m, i) => {
      if (i % PER_ROW === 0) {
        row = document.createElement('div');
        row.className = 'ls-row';
        frag.appendChild(row);
      }
      const cell = document.createElement('div');
      cell.className = 'ls-measure';
      cell.dataset.measure = String(i);
      const num = document.createElement('span');
      num.className = 'ls-num';
      num.textContent = m.number;
      cell.appendChild(num);
      const chords = document.createElement('div');
      chords.className = 'ls-chords';
      for (const h of byMeasure[i]) {
        const s = document.createElement('span');
        s.className = 'ls-chord';
        s.textContent = h.symbol;
        chords.appendChild(s);
        this.chords[h.index] = s;
      }
      cell.appendChild(chords);
      row.appendChild(cell);
      this.cells[i] = cell;
    });
    this.container.appendChild(frag);
    this.container.scrollTop = 0;
  }

  /** Marca el bucle (compases a..b); null lo quita. */
  setLoop(a, b) {
    this.cells.forEach((cell, i) => {
      const inside = a !== null && i >= a && i <= b;
      cell.classList.toggle('in-loop', inside);
      cell.classList.toggle('loop-out', a !== null && !inside);
    });
  }

  /** Resultado de un acorde: 'ok' | 'late' | 'miss'. */
  setResult(harmonyIndex, result) {
    const el = this.chords[harmonyIndex];
    if (!el) return;
    el.classList.remove('res-ok', 'res-late', 'res-miss');
    el.classList.add('res-' + result);
    this.marked.add(el);
  }

  clearResults() {
    for (const el of this.marked) el.classList.remove('res-ok', 'res-late', 'res-miss');
    this.marked.clear();
  }

  /** @param {{measureIndex:number, harmonyIndex:number}|null} ev */
  setCurrent(ev) {
    const cell = ev ? this.cells[ev.measureIndex] : null;
    const chord = ev && ev.harmonyIndex >= 0 ? this.chords[ev.harmonyIndex] : null;
    if (cell !== this.currentCell) {
      this.currentCell?.classList.remove('current');
      cell?.classList.add('current');
      this.currentCell = cell;
    }
    if (chord !== this.currentChord) {
      this.currentChord?.classList.remove('current');
      chord?.classList.add('current');
      this.currentChord = chord;
    }
    if (cell) {
      const row = Math.floor(ev.measureIndex / PER_ROW);
      if (row !== this.currentRow) {
        this.currentRow = row;
        // Mantener la línea actual en el segundo puesto visible, para ver
        // también la anterior y las siguientes.
        const rowEl = cell.parentElement;
        const target = rowEl.offsetTop - this.container.offsetTop - rowEl.offsetHeight;
        this.container.scrollTop = Math.max(0, target);
      }
    }
  }
}
