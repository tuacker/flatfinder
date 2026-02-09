export const derstandardSearchBaseUrl = "https://immobilien.derstandard.at/suche";
export const derstandardRefreshIntervalMs = 60_000;
export const derstandardRequestTimeoutMs = 15_000;
export const derstandardDetailRefreshIntervalMs = 6 * 60 * 60 * 1000;
export const derstandardDetailRefreshIgnoredIntervalMs = 24 * 60 * 60 * 1000;

export const derstandardDistricts = [
  { code: "1", label: "1010", id: "1990592" },
  { code: "2", label: "1020", id: "1990594" },
  { code: "3", label: "1030", id: "1991416" },
  { code: "4", label: "1040", id: "1991443" },
  { code: "5", label: "1050", id: "1991440" },
  { code: "6", label: "1060", id: "1990595" },
  { code: "7", label: "1070", id: "1990597" },
  { code: "8", label: "1080", id: "1990593" },
  { code: "9", label: "1090", id: "1990590" },
  { code: "10", label: "1100", id: "1991436" },
  { code: "11", label: "1110", id: "1991442" },
  { code: "12", label: "1120", id: "1990596" },
  { code: "13", label: "1130", id: "1990591" },
  { code: "14", label: "1140", id: "1990598" },
  { code: "15", label: "1150", id: "1990599" },
  { code: "16", label: "1160", id: "1991441" },
  { code: "17", label: "1170", id: "1991438" },
  { code: "18", label: "1180", id: "1990600" },
  { code: "19", label: "1190", id: "1991435" },
  { code: "20", label: "1200", id: "1991433" },
  { code: "21", label: "1210", id: "1991437" },
  { code: "22", label: "1220", id: "1991434" },
  { code: "23", label: "1230", id: "1991439" },
] as const;

export const derstandardDistrictCount = derstandardDistricts.length;
export const derstandardMinArea = 45;
export const derstandardMaxTotalCost = 1250;
export const derstandardMaxPages = 4;
