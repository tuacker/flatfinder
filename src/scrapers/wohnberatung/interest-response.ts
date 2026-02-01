export type InterestResult = "signed" | "full" | "limit" | "available" | "unknown";

export const detectInterestResult = (html: string): InterestResult => {
  if (/Sie haben sich unverbindlich angemeldet/i.test(html)) return "signed";
  if (/kein Interesse mehr/i.test(html)) return "signed";
  if (/maximale Anzahl an Interessent/i.test(html)) return "full";
  if (/max erreicht/i.test(html)) return "full";
  if (/maximale Anzahl.*Anmeld/i.test(html)) return "limit";
  if (/nur\s*3\s*Wohnung/i.test(html)) return "limit";
  if (/bereits\s*3\s*Wohnung/i.test(html)) return "limit";
  if (/unverbindlich anmelden/i.test(html)) return "available";
  return "unknown";
};

export const detectSignedFromResponse = (html: string) => {
  const result = detectInterestResult(html);
  if (result === "signed") return true;
  if (result === "available" || result === "full" || result === "limit") return false;
  return null;
};

export const isSignupAvailable = (html: string) => detectInterestResult(html) === "available";
