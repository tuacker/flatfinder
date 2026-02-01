const normalizeNumericString = (value: string) => {
  const cleaned = value.replace(/[^\d.,]/g, "");
  if (!cleaned) return null;
  const hasComma = cleaned.includes(",");
  const hasDot = cleaned.includes(".");
  let normalized = cleaned;
  if (hasComma && hasDot) {
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (hasComma) {
    normalized = cleaned.replace(",", ".");
  } else if (hasDot) {
    const parts = cleaned.split(".");
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) {
      normalized = parts.join("");
    }
  }
  return normalized;
};

export const parseCurrency = (value: string | null | undefined) => {
  if (!value) return null;
  const normalized = normalizeNumericString(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const formatCurrency = (value: string | number | null | undefined) => {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "number" ? value : parseCurrency(value);
  if (numeric === null) return null;
  return new Intl.NumberFormat("de-AT", { style: "currency", currency: "EUR" }).format(numeric);
};

export const parseArea = (value: string | null | undefined) => {
  if (!value) return null;
  const normalized = normalizeNumericString(value);
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};
