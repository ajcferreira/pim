/**
 * Safe arithmetic evaluator for calculated attributes.
 * Supports: numbers, attribute references, + - * / parentheses,
 * unary minus, and round(x, digits). No eval, no Function — a
 * formula can never execute code.
 *
 *   evaluate("round(sugar_g_100ml * volume_ml / 100, 1)", { sugar_g_100ml: 11, volume_ml: 250 })
 *   → 27.5
 *
 * Returns null if any referenced attribute is missing/non-numeric.
 */

type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(expr: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([()+\-*/,]))/y;
  let i = 0;
  while (i < expr.length) {
    re.lastIndex = i;
    const m = re.exec(expr);
    if (!m) return null;                       // illegal character
    if (m[1] !== undefined) out.push({ t: "num", v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "id", v: m[2] });
    else out.push({ t: "op", v: m[3] });
    i = re.lastIndex;
  }
  return out;
}

export function evaluate(
  formula: string,
  vars: Record<string, unknown>
): number | null {
  const toks = tokenize(formula);
  if (!toks) return null;
  let pos = 0;
  const peek = () => toks[pos];
  const eat = (v?: string): Tok | null => {
    const t = toks[pos];
    if (!t || (v !== undefined && !(t.t === "op" && t.v === v))) return null;
    pos++; return t;
  };

  function expr(): number | null {
    let left = term();
    while (left !== null && peek()?.t === "op" && (peek() as Tok & { v: string }).v.match(/^[+-]$/)) {
      const op = (eat() as { v: string }).v;
      const right = term();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }
  function term(): number | null {
    let left = factor();
    while (left !== null && peek()?.t === "op" && (peek() as Tok & { v: string }).v.match(/^[*/]$/)) {
      const op = (eat() as { v: string }).v;
      const right = factor();
      if (right === null) return null;
      if (op === "/" && right === 0) return null;
      left = op === "*" ? left * right : left / right;
    }
    return left;
  }
  function factor(): number | null {
    const t = peek();
    if (!t) return null;
    if (t.t === "op" && t.v === "-") { eat(); const f = factor(); return f === null ? null : -f; }
    if (t.t === "op" && t.v === "(") {
      eat();
      const v = expr();
      if (v === null || !eat(")")) return null;
      return v;
    }
    if (t.t === "num") { eat(); return t.v; }
    if (t.t === "id") {
      eat();
      if (t.v === "round" && peek()?.t === "op" && (peek() as { v: string }).v === "(") {
        eat("(");
        const x = expr();
        let digits = 0;
        if (peek()?.t === "op" && (peek() as { v: string }).v === ",") {
          eat(",");
          const d = expr();
          if (d === null) return null;
          digits = Math.max(0, Math.min(10, Math.trunc(d)));
        }
        if (x === null || !eat(")")) return null;
        const f = 10 ** digits;
        return Math.round(x * f) / f;
      }
      const v = vars[t.v];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    }
    return null;
  }

  const result = expr();
  return pos === toks.length && result !== null && Number.isFinite(result) ? result : null;
}

/** Compute all calculated attributes (defs with a formula) over a value map. */
export function applyCalculated(
  values: Record<string, unknown>,
  defs: { code: string; formula?: string | null }[]
): Record<string, unknown> {
  const out = { ...values };
  for (const d of defs) {
    if (d.formula) {
      const v = evaluate(d.formula, out);
      if (v !== null) out[d.code] = v;
      else delete out[d.code];
    }
  }
  return out;
}
