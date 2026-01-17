export const baseUrl = "https://wohnungssuche.wohnberatung-wien.at";
export const loginUrl = `${baseUrl}/`;
export const suchprofilUrl = `${baseUrl}/?page=suchprofil`;
export const planungsprojekteUrl = `${baseUrl}/?art=&page=planungsprojekte&p=1&sort=plz&upp=100`;

const dataDir = "data/wohnberatung";
export const storageStatePath = `${dataDir}/storageState.json`;
export const statePath = `${dataDir}/state.json`;
export const assetsDir = `${dataDir}/assets`;

export const planungsprojektePlzRange = {
  min: 1010,
  max: 1090,
};

export const excludedKeywords = ["SPF", "SMART", "Superförderung"];

export const rateLimitMonthly = 6000;

export const planungsprojekteRequestCost = 1;
export const wohnungssuchePreviewCost = 1;
export const wohnungssucheResultCost = 1;

export const planungsprojekteIntervalMinutes = 60;
export const wohnungssucheIntervalMinutes = 20;

export const loginHeadless = false;
export const browserSlowMoMs = 0;
export const loginTimeoutMs = 5 * 60 * 1000;
