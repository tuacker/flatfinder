export type JobRunner = (name: string, job: () => Promise<void>) => Promise<void> | void;

export const createSerialQueue = (): JobRunner => {
  let queue = Promise.resolve();
  return (name, job) => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        try {
          await job();
        } catch (error) {
          console.error(`[${name}]`, error instanceof Error ? error.message : error);
        }
      });
    return queue;
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
    const nextAt = Date.now() + options.intervalMs;
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
