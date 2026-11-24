const shanghaiClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

function parts(now: Date) {
  const { year, month, day, hour } = Object.fromEntries(shanghaiClock.formatToParts(now).map(part => [part.type, part.value]));
  return { date: `${year}-${month}-${day}`, hour: Number(hour) };
}

export function dateInShanghai(now: Date) {
  return parts(now).date;
}

export function nightDate(now: Date) {
  if (!Number.isFinite(now.getTime())) return;
  const { date, hour } = parts(now);
  if (hour >= 21) return date;
}
