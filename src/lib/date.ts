import i18n from "../i18n";

/** 本地时区的日期键，用于画廊时间线分组（同一天归为一组） */
export function dayKey(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** 时间线分组标题：今天 / 昨天 / M月D日 / YYYY年M月D日 */
export function dayLabel(unixSeconds: number, now = Date.now()): string {
  const d = new Date(unixSeconds * 1000);
  const today = new Date(now);
  const startOf = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return i18n.t("今天");
  if (diffDays === 1) return i18n.t("昨天");
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() === today.getFullYear()
    ? i18n.t("{{month}}月{{day}}日", { month, day })
    : i18n.t("{{year}}年{{month}}月{{day}}日", {
        year: d.getFullYear(),
        month,
        day,
      });
}
