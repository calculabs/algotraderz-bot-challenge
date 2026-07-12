// Futures trading calendar for the weekly challenge.
//
// The competition follows the CME session clock, anchored to US Pacific time
// (no timezone is ever shown to users — traders are global):
//
//   Day 1  Sun 3pm -> Mon 2pm
//   Day 2  Mon 3pm -> Tue 2pm
//   Day 3  Tue 3pm -> Wed 2pm
//   Day 4  Wed 3pm -> Thu 2pm
//   Day 5  Thu 3pm -> Fri 2pm (week closes Fri 2pm)
//
// Each session runs 3pm -> 2pm the next day; the 2pm-3pm hour is the daily
// maintenance break. "Every week starts at 0" = the P&L window opens Sun 3pm.
// The Sunday-evening session books to Monday's trade date, so a week's data
// spans Mon..Fri trade dates == Days 1..5.

const TZ = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function ptParts(date) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, weekday: "short",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(date).reduce((a, x) => ((a[x.type] = x.value), a), {});
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: WEEKDAY[p.weekday]
  };
}

// Offset (ms) such that PT-wall-clock-as-UTC === realUTC + offset.
// The PT parts only resolve to whole seconds, so compare against a whole-second instant:
// subtracting the raw getTime() would fold the current millisecond into the offset, and
// every timestamp derived from it (weekStart, weekEnd, close) would jitter by a few ms on
// each call — which silently broke any key derived from them.
function ptOffsetMs(date) {
  const p = ptParts(date);
  const wholeSecond = Math.floor(date.getTime() / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - wholeSecond;
}

export function weekSchedule(now = new Date()) {
  const p = ptParts(now);
  const offset = ptOffsetMs(now);
  // UTC instant of "today's PT calendar date at 15:00 PT", then step back to Sunday.
  const today3pm = Date.UTC(p.year, p.month - 1, p.day, 15, 0, 0) - offset;
  let weekOpen = today3pm - p.weekday * DAY_MS;
  if (now.getTime() < weekOpen) weekOpen -= 7 * DAY_MS; // before Sunday 3pm -> previous week

  const totalDays = 5;
  const closeMs = weekOpen + 4 * DAY_MS + 23 * 60 * 60 * 1000; // Fri 2pm
  const elapsed = now.getTime() - weekOpen;

  let currentDay;
  let phase;
  if (elapsed < 0) {
    currentDay = 0;
    phase = "pre";
  } else if (now.getTime() >= closeMs) {
    currentDay = totalDays;
    phase = "done";
  } else {
    currentDay = Math.min(totalDays, Math.floor(elapsed / DAY_MS) + 1);
    phase = elapsed - (currentDay - 1) * DAY_MS >= 23 * 60 * 60 * 1000 ? "break" : "active";
  }

  const days = [];
  for (let i = 1; i <= totalDays; i++) {
    const date = new Date(weekOpen + i * DAY_MS).toISOString().slice(0, 10);
    let state;
    if (phase === "done" || i < currentDay) state = "past";
    else if (i === currentDay && phase !== "pre") state = "live";
    else state = "future";
    days.push({ day: i, date, state });
  }

  return {
    weekStart: new Date(weekOpen).toISOString(),
    weekEnd: new Date(weekOpen + 7 * DAY_MS).toISOString(),
    close: new Date(closeMs).toISOString(),
    currentDay,
    totalDays,
    phase,
    days
  };
}

// Resolve the active competition week — the live futures week, or a fixed window
// pinned via challenge.weekStart / challenge.weekEnd. Returns { schedule, range }.
// Shared by the Node scrape and the in-browser board so they can't drift.
export function resolveWeek(challenge = {}, now = new Date()) {
  const base = weekSchedule(now);
  const schedule =
    challenge.weekStart && challenge.weekEnd
      ? { ...base, weekStart: challenge.weekStart, weekEnd: challenge.weekEnd }
      : base;
  return { schedule, range: { start: schedule.weekStart, end: schedule.weekEnd } };
}
