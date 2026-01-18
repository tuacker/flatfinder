export type InterestPriorityItem = {
  interest?: { rank?: number | null; requestedAt?: string | null };
};

export const getRequestedAtValue = (value: string | null | undefined) => {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
};

export const getPriority = (item: InterestPriorityItem) => {
  if (typeof item.interest?.rank === "number") {
    return { bucket: 0, value: item.interest.rank };
  }
  return { bucket: 1, value: getRequestedAtValue(item.interest?.requestedAt) };
};

export const comparePriority = (left: InterestPriorityItem, right: InterestPriorityItem) => {
  const leftPriority = getPriority(left);
  const rightPriority = getPriority(right);
  if (leftPriority.bucket !== rightPriority.bucket) {
    return leftPriority.bucket - rightPriority.bucket;
  }
  if (leftPriority.value < rightPriority.value) return -1;
  if (leftPriority.value > rightPriority.value) return 1;
  return 0;
};

export const sortByPriority = <T extends InterestPriorityItem>(items: T[]) =>
  [...items].sort(comparePriority);
