export const formatTimeLeft = (iso: string | null) => {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return "abgelaufen";
  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
};

export const formatRefreshLeft = (iso: string | null) => {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diffMs)) return null;
  if (diffMs <= 0) return "now";
  if (diffMs < 60000) return `${Math.ceil(diffMs / 1000)}s`;
  return formatTimeLeft(iso);
};
