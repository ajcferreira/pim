/**
 * Beverage compliance checks (EU-flavoured, extensible per market).
 * Pure functions over the product record — run on demand or pre-publish.
 * NOTE: rule set is illustrative; confirm against current regulations
 * for each target market before relying on it.
 */

export interface ComplianceIssue {
  rule: string;
  severity: "error" | "warning";
  message: string;
}

type Product = {
  name: string;
  type_code: string;
  attributes: Record<string, any>;
  i18n: Record<string, any>;
  variants?: { gtin?: string | null; name: string }[];
};

const ALCOHOLIC = new Set(["beer", "wine", "spirit"]);

/** ABV → excise/tax category (simplified EU-style bands). */
export function taxCategory(typeCode: string, abv?: number): string {
  if (abv === undefined || abv === null) return "unknown";
  if (abv <= 0.5) return "non_alcoholic";
  if (typeCode === "beer") return abv <= 2.8 ? "beer_reduced" : "beer_standard";
  if (typeCode === "wine") return abv <= 15 ? "still_wine" : "fortified_wine";
  if (typeCode === "spirit") return "spirits";
  return "other_alcoholic";
}

/** Deposit-return scheme codes by country (subset). */
const DEPOSIT_SCHEMES: Record<string, string> = {
  DE: "Pfand (DPG)", NO: "Pant (Infinitum)", SE: "Pant (Returpack)",
  DK: "Pant (Dansk Retursystem)", NL: "Statiegeld", FI: "Pantti (Palpa)",
};
export function depositScheme(countryCode: string): string | null {
  return DEPOSIT_SCHEMES[countryCode.toUpperCase()] ?? null;
}

export function runComplianceChecks(
  p: Product,
  markets: string[] = ["EU"]
): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  const a = p.attributes ?? {};
  const isAlcoholic = ALCOHOLIC.has(p.type_code) && (a.abv ?? 0) > 0.5;

  // 1. Allergen declaration (EU 1169/2011-style)
  if (["beer", "wine"].includes(p.type_code) && !a.allergens?.length) {
    issues.push({ rule: "allergens", severity: "error",
      message: "Allergen declaration required (e.g. barley, sulphites — or explicitly 'None')" });
  }
  // 2. Nutrition for non-alcoholic drinks
  if (["soft_drink", "juice"].includes(p.type_code) && a.sugar_g_100ml === undefined) {
    issues.push({ rule: "nutrition", severity: "error",
      message: "Nutrition declaration per 100ml required (sugar missing)" });
  }
  // 3. ABV labeling threshold
  if (isAlcoholic && a.abv === undefined) {
    issues.push({ rule: "abv_label", severity: "error",
      message: "ABV must be declared for alcoholic beverages" });
  }
  if (isAlcoholic && a.abv > 1.2 === false && a.abv > 0.5) {
    issues.push({ rule: "low_alcohol", severity: "warning",
      message: "0.5–1.2% ABV: check 'low alcohol' labeling rules per market" });
  }
  // 4. High caffeine warning (EU: >15 mg/100ml requires statement)
  if ((a.caffeine_mg ?? 0) > 15) {
    issues.push({ rule: "caffeine_warning", severity: "error",
      message: `High caffeine (${a.caffeine_mg} mg/100ml > 15): 'High caffeine content' statement required` });
  }
  // 5. GTIN coverage on variants
  for (const v of p.variants ?? []) {
    if (!v.gtin) issues.push({ rule: "gtin", severity: "warning",
      message: `Variant '${v.name}' has no GTIN/barcode` });
  }
  // 6. Deposit scheme hint by target market
  for (const m of markets) {
    const scheme = depositScheme(m);
    if (scheme && (a.volume_ml ?? 0) > 0 && (a.volume_ml ?? 0) <= 3000) {
      issues.push({ rule: "deposit", severity: "warning",
        message: `${m}: container likely falls under ${scheme} — verify deposit marking` });
    }
  }
  // 7. Localized legal text for non-English markets
  const nonEn = markets.filter((m) => !["UK", "IE", "US", "EU"].includes(m));
  for (const m of nonEn) {
    const locale = m.toLowerCase();
    if (!p.i18n?.[locale]?.name) {
      issues.push({ rule: "i18n", severity: "warning",
        message: `${m}: no localized product name/label text (locale '${locale}')` });
    }
  }
  return issues;
}
