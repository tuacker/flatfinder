import { scheduleNextRefresh } from "../shared/refresh.js";

export type JobRunner = <T>(name: string, job: () => Promise<T>) => Promise<T | undefined>;

export const createSerialQueue = (): JobRunner => {
  let queue = Promise.resolve();
  return async <T>(name: string, job: () => Promise<T>) => {
    let result: T | undefined;
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          result = await job();
        } catch (error) {
          console.error(`[${name}]`, error instanceof Error ? error.message : error);
          result = undefined;
        }
      });
    await queue;
    return result;
  };
};

export const scheduleJob = (options: {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
  onSchedule: (nextAt: number) => void;
  lastRunAt?: string | null;
  runner?: JobRunner;
}) => {
  let pending = false;

  const execute = () => {
    if (pending) return;
    pending = true;
    const nextAt = scheduleNextRefresh(Date.now(), options.intervalMs);
    options.onSchedule(nextAt);
    const job = async () => {
      try {
        await options.run();
      } finally {
        pending = false;
      }
    };
    if (options.runner) {
      options.runner(options.name, job);
    } else {
      void job();
    }
  };

  const lastRunMs = options.lastRunAt ? new Date(options.lastRunAt).getTime() : Number.NaN;
  const elapsed = Number.isFinite(lastRunMs) ? Date.now() - lastRunMs : options.intervalMs;
  const initialDelay = elapsed >= options.intervalMs ? 0 : options.intervalMs - elapsed;
  options.onSchedule(Date.now() + initialDelay);

  setTimeout(() => {
    execute();
    setInterval(execute, options.intervalMs);
  }, initialDelay);
};
