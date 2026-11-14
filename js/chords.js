// Nombre del acorde que se está tocando, leído literalmente: la nota más
// grave se toma como fundamental. Así se ve exactamente lo que suena
// (p. ej. Mi-Sol-Si-Re sin bajo se lee Em7, no "Cmaj9 sin fundamental").
// Sin dependencias: tabla propia de tipos de acorde.

const SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
const DEFAULT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// [sufijo, intervalos obligatorios, intervalos opcionales] (semitonos mod 12)
// El orden decide en caso de empate: primero los más específicos.
const TYPES = [
  ['maj13', [0, 4, 11, 9], [7, 2, 6]],
  ['13', [0, 4, 10, 9], [7, 2]],
  ['m13', [0, 3, 10, 9], [7, 2, 5]],
  ['13♭9', [0, 4, 10, 9, 1], [7]],
  ['maj9♯11', [0, 4, 11, 2, 6], [7]],
  ['9♯11', [0, 4, 10, 2, 6], [7]],
  ['m11', [0, 3, 10, 5], [7, 2]],
  ['maj9', [0, 4, 11, 2], [7]],
  ['9', [0, 4, 10, 2], [7]],
  ['m9', [0, 3, 10, 2], [7]],
  ['m(maj9)', [0, 3, 11, 2], [7]],
  ['m9♭5', [0, 3, 6, 10, 2], []],
  ['9sus4', [0, 5, 10, 2], [7]],
  ['7♭9', [0, 4, 10, 1], [7]],
  ['7♯9', [0, 4, 10, 3], [7]],
  ['7♯11', [0, 4, 10, 6], [7]],
  ['7♭13', [0, 4, 10, 8], [7]],
  ['7alt', [0, 4, 10, 1, 8], [3, 6]],
  ['6/9', [0, 4, 9, 2], [7]],
  ['m6/9', [0, 3, 9, 2], [7]],
  ['maj7♯11', [0, 4, 11, 6], [7]],
  ['maj7♯5', [0, 4, 8, 11], []],
  ['maj7', [0, 4, 11], [7]],
  ['7', [0, 4, 10], [7]],
  ['m7', [0, 3, 10], [7]],
  ['m(maj7)', [0, 3, 11], [7]],
  ['m7♭5', [0, 3, 6, 10], []],
  ['dim7', [0, 3, 6, 9], []],
  ['7sus4', [0, 5, 10], [7]],
  ['7♯5', [0, 4, 8, 10], []],
  ['6', [0, 4, 7, 9], []],
  ['m6', [0, 3, 7, 9], []],
  ['add9', [0, 4, 7, 2], []],
  ['m(add9)', [0, 3, 7, 2], []],
  ['', [0, 4, 7], []],
  ['m', [0, 3, 7], []],
  ['dim', [0, 3, 6], []],
  ['+', [0, 4, 8], []],
  ['sus4', [0, 5, 7], []],
  ['sus2', [0, 2, 7], []],
  ['5', [0, 7], []],
];

function matchType(set) {
  for (const [suffix, req, opt] of TYPES) {
    if (!req.every((i) => set.has(i))) continue;
    if ([...set].every((i) => req.includes(i) || opt.includes(i))) return suffix;
  }
  return null;
}

const LETTERS = 'CDEFGAB';
const NATURAL = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };

/** Nombre de la fundamental: la ortografía del cifrado esperado si es la misma nota. */
export function rootName(pc, hint) {
  if (hint) {
    const m = /^([A-G])([♯♭#b]?)/.exec(hint);
    if (m) {
      const acc = m[2] === '#' ? '♯' : m[2] === 'b' ? '♭' : m[2];
      const name = m[1] + acc;
      if (SHARP.indexOf(name) === pc || FLAT.indexOf(name) === pc) return name;
    }
  }
  return DEFAULT[pc];
}

// Grado (1..7) que representa cada intervalo dentro de un acorde de tipo `suffix`.
function degreeOf(interval, suffix) {
  switch (interval) {
    case 0: return 1;
    case 1: case 2: return 2;
    case 3: return suffix.includes('♯9') ? 2 : 3;
    case 4: return 3;
    case 5: return 4;
    case 6: return suffix.includes('♯11') || suffix.includes('alt') ? 4 : 5;
    case 7: return 5;
    case 8: return suffix.includes('♭13') || suffix.includes('alt') ? 6 : 5;
    case 9: return suffix.startsWith('dim7') ? 7 : 6;
    default: return 7; // 10, 11
  }
}

/** Escribe la nota `pc` como grado del acorde con fundamental `root` (p. ej. 'C♯'). */
function spell(pc, root, suffix) {
  const letterIdx = LETTERS.indexOf(root[0]);
  const rootPc = SHARP.indexOf(root) >= 0 ? SHARP.indexOf(root) : FLAT.indexOf(root);
  if (letterIdx < 0 || rootPc < 0) return DEFAULT[pc];
  const interval = (pc - rootPc + 12) % 12;
  const letter = LETTERS[(letterIdx + degreeOf(interval, suffix) - 1) % 7];
  const diff = ((pc - NATURAL[letter] + 18) % 12) - 6;
  return diff in ACC ? letter + ACC[diff] : DEFAULT[pc];
}

/**
 * @param {number[]} midis notas que suenan
 * @param {string} [hint] cifrado esperado, para escribir la fundamental igual
 * @returns {{name:string, notes:string}} name vacío si no se reconoce
 */
export function detectChord(midis, hint) {
  if (!midis.length) return { name: '', notes: '' };
  const sorted = [...midis].sort((a, b) => a - b);
  const bassPc = sorted[0] % 12;
  const pcs = [...new Set(sorted.map((m) => m % 12))];
  const spellAll = (root, suffix) => sorted.map((m) => spell(m % 12, root, suffix)).join(' ');

  if (pcs.length >= 2) {
    // 1) Fundamental = nota más grave (lectura literal).
    const t = matchType(new Set(pcs.map((p) => (p - bassPc + 12) % 12)));
    if (t !== null) {
      const root = rootName(bassPc, hint);
      return { name: root + t, notes: spellAll(root, t) };
    }
    // 2) Otra nota tocada como fundamental, con el bajo indicado: X/bajo.
    for (const pc of pcs) {
      if (pc === bassPc) continue;
      const t2 = matchType(new Set(pcs.map((p) => (p - pc + 12) % 12)));
      if (t2 !== null) {
        const root = rootName(pc, hint);
        return { name: `${root}${t2}/${spell(bassPc, root, t2)}`, notes: spellAll(root, t2) };
      }
    }
  }
  return { name: '', notes: sorted.map((m) => rootName(m % 12, hint)).join(' ') };
}
