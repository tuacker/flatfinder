import type { FlatfinderState } from "./state.js";

export type RateLimiter = {
  consume: (amount: number) => boolean;
};

export const createRateLimiter = (state: FlatfinderState, max: number): RateLimiter => ({
  consume(amount: number) {
    const current = new Date().toISOString().slice(0, 7);
    if (state.rateLimit.month !== current) {
      state.rateLimit = { month: current, count: 0 };
    }
    if (state.rateLimit.count + amount > max) return false;
    state.rateLimit.count += amount;
    return true;
  },
});
