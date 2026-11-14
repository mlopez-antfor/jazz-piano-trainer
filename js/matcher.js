// Compara las notas pulsadas con el acorde esperado. Lógica pura, sin DOM.
//
// Regla (decidida con el usuario): validación exacta contra la partitura.
// Única excepción: las notas del pentagrama inferior (la fundamental de la
// mano izquierda) se aceptan en cualquier octava dentro de un rango (C2–C3)
// si la opción flexRoot está activa.

export const DEFAULT_ROOT_RANGE = [36, 48]; // C2..C3

/**
 * @param {Array<{midi:number, staff:number}>} expected notas del acorde
 * @param {Map<number, boolean>} pressed nota MIDI -> true si se pulsó después
 *        de que empezara este acorde ("fresca"), false si ya estaba pulsada antes
 * @param {{flexRoot?:boolean, rootRange?:[number,number]}} opts
 * @returns {{
 *   success:boolean,
 *   pressed: Map<number,'ok'|'wrong'|'stale-ok'|'stale-wrong'>,
 *   missing: number[],          // notas esperadas (altura escrita) sin pulsar
 *   hasFreshWrong:boolean
 * }}
 */
export function evaluate(expected, pressed, opts = {}) {
  const flexRoot = opts.flexRoot !== false;
  const [lo, hi] = opts.rootRange || DEFAULT_ROOT_RANGE;

  const exp = expected.map((n) => ({
    midi: n.midi,
    flex: flexRoot && n.staff >= 2,
    matched: null,
  }));
  const remaining = new Set(pressed.keys());

  // 1) Coincidencias exactas.
  for (const e of exp) {
    if (remaining.has(e.midi)) {
      e.matched = e.midi;
      remaining.delete(e.midi);
    }
  }
  // 2) Fundamental en otra octava dentro del rango.
  for (const e of exp) {
    if (e.matched !== null || !e.flex) continue;
    const pc = ((e.midi % 12) + 12) % 12;
    const cand = [...remaining]
      .filter((m) => m % 12 === pc && m >= lo && m <= hi)
      .sort((a, b) => Math.abs(a - e.midi) - Math.abs(b - e.midi))[0];
    if (cand !== undefined) {
      e.matched = cand;
      remaining.delete(cand);
    }
  }

  const result = new Map();
  let hasFreshWrong = false;
  let allFresh = true;
  for (const e of exp) {
    if (e.matched === null) continue;
    const fresh = pressed.get(e.matched);
    result.set(e.matched, fresh ? 'ok' : 'stale-ok');
    if (!fresh) allFresh = false;
  }
  for (const m of remaining) {
    const fresh = pressed.get(m);
    result.set(m, fresh ? 'wrong' : 'stale-wrong');
    if (fresh) hasFreshWrong = true;
  }
  const missing = exp.filter((e) => e.matched === null).map((e) => e.midi);

  const success =
    exp.length > 0 && missing.length === 0 && remaining.size === 0 && allFresh;

  return { success, pressed: result, missing, hasFreshWrong };
}
