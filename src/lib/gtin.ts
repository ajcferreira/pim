/** GTIN-8/12/13/14 validation with check digit (GS1 mod-10). */
export function validateGtin(gtin: string): { valid: boolean; reason?: string } {
  if (!/^\d+$/.test(gtin)) return { valid: false, reason: "Digits only" };
  if (![8, 12, 13, 14].includes(gtin.length))
    return { valid: false, reason: "Length must be 8, 12, 13 or 14 digits" };
  const digits = gtin.split("").map(Number);
  const check = digits.pop()!;
  const sum = digits
    .reverse()
    .reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  const expected = (10 - (sum % 10)) % 10;
  return expected === check
    ? { valid: true }
    : { valid: false, reason: `Check digit should be ${expected}` };
}
