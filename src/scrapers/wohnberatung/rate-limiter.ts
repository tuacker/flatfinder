import {
  planungsprojekteRequestCost,
  rateLimitMonthly,
  wohnungssuchePreviewCost,
  wohnungssucheResultCost,
} from "./config.js";
import { loadRateLimit, saveRateLimit } from "../../state/flatfinder-state.js";
import type { FlatfinderState, RateLimitState } from "../../state/flatfinder-state.js";

export type RateLimiter = {
  consume: (amount: number) => boolean;
  canConsume: (amount: number) => boolean;
};

const formatMonth = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
};

const currentMonth = () => formatMonth(new Date());

export const createRateLimiter = (state: FlatfinderState, max: number): RateLimiter => {
  const ensureMonth = (): RateLimitState => {
    const current = currentMonth();
    let rateLimit = loadRateLimit();
    if (rateLimit.month !== current) {
      if (rateLimit.month < current) {
        rateLimit = { month: current, count: 0 };
        saveRateLimit(rateLimit);
      }
    }
    state.rateLimit = rateLimit;
    return rateLimit;
  };
  return {
    canConsume(amount: number) {
      const rateLimit = ensureMonth();
      return rateLimit.count + amount <= max;
    },
    consume(amount: number) {
      const rateLimit = ensureMonth();
      if (rateLimit.count + amount > max) return false;
      const next = { ...rateLimit, count: rateLimit.count + amount };
      saveRateLimit(next);
      state.rateLimit = next;
      return true;
    },
  };
};

const getRemainingBudget = () => {
  const current = currentMonth();
  const rateLimit = loadRateLimit();
  const count = rateLimit.month >= current ? rateLimit.count : 0;
  return Math.max(0, rateLimitMonthly - count);
};

const getRemainingMonthMs = () => {
  const now = new Date();
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  return Math.max(0, endOfMonth.getTime() - now.getTime());
};

export const calculateWohnberatungIntervalsMs = (_state: FlatfinderState) => {
  const remainingMs = getRemainingMonthMs();
  const remainingBudget = getRemainingBudget();
  const wohnCost = wohnungssuchePreviewCost + wohnungssucheResultCost * 2;
  const planCost = planungsprojekteRequestCost;
  const ratio = 3;

  if (remainingMs <= 0 || remainingBudget <= 0) {
    const delay = Math.max(60_000, remainingMs || 0);
    return {
      wohnungenIntervalMs: delay,
      planungsprojekteIntervalMs: delay,
      remainingBudget,
      remainingMs,
    };
  }

  const budgetPerMs = remainingBudget / remainingMs;
  const planRunsPerMs = budgetPerMs / (planCost + ratio * wohnCost);
  const planIntervalMs = Math.max(1, Math.ceil(1 / planRunsPerMs));
  const wohnungenIntervalMs = Math.max(1, Math.ceil(planIntervalMs / ratio));

  return {
    wohnungenIntervalMs,
    planungsprojekteIntervalMs: planIntervalMs,
    remainingBudget,
    remainingMs,
  };
};
