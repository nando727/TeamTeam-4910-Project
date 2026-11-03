// Pure numbers for the sales charts (story AD-31, and Sales by Driver). Both
// charts cover every filtered row, never one page. The templates only draw what
// they are handed, as inline SVG with no library.
const { DAY_MS, isoDate, dollars } = require('./helpers');

const RANKED_LIMIT = 10;
const LABEL_CHARS = 26;
const DAY_TIER_MAX = 31;
const WEEK_TIER_MAX = 182;
// Past this, a wide date range starts at the first sale and ends at the last,
// rather than drawing years of empty months.
const MAX_SPAN_DAYS = 1096;

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
}

const n1 = value => +value.toFixed(1);
const plural = (count, noun) => `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
const shortLabel = (value, max = LABEL_CHARS) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

// Axis ticks: compact from $1,000 up, with cents only when the step needs them.
function compactDollars(cents) {
  const whole = cents / 100;
  if (whole >= 1000000) return `$${+(whole / 1000000).toFixed(1)}M`;
  if (whole >= 1000) return `$${+(whole / 1000).toFixed(1)}K`;
  return Number.isInteger(whole) ? `$${whole}` : `$${whole.toFixed(2)}`;
}

// Rounded at the data end, square at the baseline.
function columnPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  return `M${n1(x)} ${n1(y + h)}V${n1(y + r)}Q${n1(x)} ${n1(y)} ${n1(x + r)} ${n1(y)}` +
    `H${n1(x + w - r)}Q${n1(x + w)} ${n1(y)} ${n1(x + w)} ${n1(y + r)}V${n1(y + h)}Z`;
}
function barPath(x, y, w, h) {
  const r = Math.min(4, h / 2, w);
  return `M${n1(x)} ${n1(y)}H${n1(x + w - r)}Q${n1(x + w)} ${n1(y)} ${n1(x + w)} ${n1(y + r)}` +
    `V${n1(y + h - r)}Q${n1(x + w)} ${n1(y + h)} ${n1(x + w - r)} ${n1(y + h)}H${n1(x)}Z`;
}

// Totals by sponsor or driver, largest first. `items` is every filtered row:
// { name, tipName?, totalCents, sales, points }. The tail folds into one
// "All others" bar, so the chart still accounts for every sale. With only one
// entity a bar compares nothing, so the template shows its total as a figure.
function buildRankedBars(items, { noun, limit = RANKED_LIMIT } = {}) {
  const all = items.map(item => ({
    ...item, totalCents: Number(item.totalCents), sales: Number(item.sales), points: Number(item.points),
  }));
  const withSales = all.filter(item => item.sales > 0).sort((a, b) => b.totalCents - a.totalCents);
  if (!withSales.length) return null;
  const notShown = all.length - withSales.length;
  if (withSales.length === 1) return { single: withSales[0], notShown, noun };

  const shown = withSales.slice(0, limit);
  const rest = withSales.slice(limit);
  if (rest.length) {
    shown.push({
      name: `All others (${plural(rest.length, noun)})`, other: true,
      totalCents: rest.reduce((sum, item) => sum + item.totalCents, 0),
      sales: rest.reduce((sum, item) => sum + item.sales, 0),
      points: rest.reduce((sum, item) => sum + item.points, 0),
    });
  }

  const W = 760; const L = 200; const R = 104; const T = 4; const B = 4; const ROW = 32; const BAR = 20;
  const H = T + shown.length * ROW + B;
  const plotW = W - L - R;
  const max = Math.max(...shown.map(item => item.totalCents)) || 1;
  const bars = shown.map((item, i) => {
    const y = T + i * ROW + (ROW - BAR) / 2;
    const w = item.totalCents > 0 ? Math.max(2, (item.totalCents / max) * plotW) : 0;
    const name = item.tipName || item.name;
    const detail = `${plural(item.sales, 'sale')}, ${item.points.toLocaleString('en-US')} points`;
    return {
      name: item.name, other: Boolean(item.other), totalCents: item.totalCents, sales: item.sales, points: item.points,
      label: shortLabel(item.name), centerY: n1(y + BAR / 2), valueX: n1(L + w + 8),
      d: w > 0 ? barPath(L, y, w, BAR) : null,
      hit: { x: 0, y: T + i * ROW, w: W, h: ROW },
      value: dollars(item.totalCents), tipLabel: `${name}, ${detail}`, spoken: `${name}: ${dollars(item.totalCents)}, ${detail}`,
    };
  });
  return {
    W, H, L, T, B, bars, notShown, noun, folded: rest.length > 0, shownCount: Math.min(limit, withSales.length),
    summary: `Bar chart of sales totals by ${noun}, largest first. The highest is ${bars[0].spoken}.`,
  };
}

const dayLabel = (day, withYear) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC',
});
const monthOf = day => {
  const [y, m] = day.split('-').map(Number);
  return y * 12 + (m - 1);
};
const spanDays = (start, end) => Math.round((Date.parse(end) - Date.parse(start)) / DAY_MS) + 1;

// The empty periods of the range, one bar's worth each: days for up to a month,
// weeks for up to six months, then calendar months.
function emptyBuckets(start, end, unit) {
  if (unit === 'month') {
    const buckets = [];
    for (let month = monthOf(start); month <= monthOf(end); month++) {
      const first = isoDate(new Date(Date.UTC(Math.floor(month / 12), month % 12, 1)));
      const date = new Date(`${first}T00:00:00Z`);
      buckets.push({
        tick: date.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
        name: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        sales: 0, totalCents: 0,
      });
    }
    return buckets;
  }
  const size = unit === 'week' ? 7 : 1;
  return Array.from({ length: Math.ceil(spanDays(start, end) / size) }, (_, i) => {
    const first = isoDate(new Date(Date.parse(start) + i * size * DAY_MS));
    return { tick: dayLabel(first), name: `${size === 7 ? 'Week of ' : ''}${dayLabel(first, true)}`, sales: 0, totalCents: 0 };
  });
}

// Sales dollars over time. `daily` is { day, sales, totalCents } for every day
// in the filtered set that has a sale, in date order.
function buildTimeColumns(daily, { from = null, to = null } = {}) {
  if (!daily.length) return null;
  const first = daily[0].day;
  const last = daily[daily.length - 1].day;
  let start = from || first;
  let end = to || last;
  if (spanDays(start, end) > MAX_SPAN_DAYS) {
    if (first > start) start = first;
    if (last < end) end = last;
  }
  const span = spanDays(start, end);
  const unit = span <= DAY_TIER_MAX ? 'day' : span <= WEEK_TIER_MAX ? 'week' : 'month';
  const buckets = emptyBuckets(start, end, unit);
  for (const row of daily) {
    const index = unit === 'month'
      ? monthOf(row.day) - monthOf(start)
      : Math.floor((spanDays(start, row.day) - 1) / (unit === 'week' ? 7 : 1));
    const bucket = buckets[index];
    if (!bucket) continue;
    bucket.sales += Number(row.sales);
    bucket.totalCents += Number(row.totalCents);
  }

  const W = 760; const H = 220; const L = 56; const R = 24; const T = 24; const B = 28;
  const plotW = W - L - R; const plotH = H - T - B; const baseY = T + plotH;
  const peakCents = Math.max(...buckets.map(bucket => bucket.totalCents));
  const step = niceStep(peakCents / 4);
  const yMax = Math.max(step, Math.ceil(peakCents / step) * step);
  const yOf = cents => T + (1 - cents / yMax) * plotH;
  const slot = plotW / buckets.length;
  const barW = Math.min(24, Math.max(1.5, slot - 2));

  // Empty periods draw nothing and take no tab stop; the axis still shows them.
  const bars = [];
  buckets.forEach((bucket, i) => {
    if (!bucket.sales) return;
    const h = bucket.totalCents > 0 ? Math.max(2, baseY - yOf(bucket.totalCents)) : 0;
    const x = L + i * slot + (slot - barW) / 2;
    const detail = plural(bucket.sales, 'sale');
    bars.push({
      index: i, d: h > 0 ? columnPath(x, baseY - h, barW, h) : null,
      hit: { x: n1(L + i * slot), y: T, w: n1(slot), h: plotH },
      centerX: x + barW / 2, top: baseY - h,
      name: bucket.name, sales: bucket.sales, totalCents: bucket.totalCents,
      value: dollars(bucket.totalCents), tipLabel: `${bucket.name}, ${detail}`, spoken: `${bucket.name}: ${dollars(bucket.totalCents)}, ${detail}`,
    });
  });
  if (!bars.length) return null;
  const peakBar = bars.find(bar => bar.totalCents === peakCents);
  const peak = {
    x: n1(Math.min(W - R - 30, Math.max(L + 30, peakBar.centerX))), y: n1(peakBar.top - 6),
    value: peakBar.value,
    when: unit === 'day' ? `on ${peakBar.name}` : unit === 'week' ? `in the week of ${peakBar.name.replace('Week of ', '')}` : `in ${peakBar.name}`,
  };

  const ticks = [];
  for (let value = 0; value <= yMax + 1e-9; value += step) ticks.push({ y: n1(yOf(value)), label: compactDollars(value) });
  const every = Math.max(1, Math.ceil(buckets.length / 6));
  const labelled = [];
  for (let i = 0; i < buckets.length; i += every) labelled.push(i);
  // The last period gets a label too, unless it would crowd its neighbor.
  if (buckets.length - 1 - labelled[labelled.length - 1] >= Math.ceil(every / 2)) labelled.push(buckets.length - 1);
  const xLabels = labelled.map(i => ({ x: n1(L + i * slot + slot / 2), label: buckets[i].tick }));

  return {
    W, H, L, R, T, B, baseY, unit, start, end, ticks, xLabels, bars, peak,
    summary: `Column chart of sales dollars per ${unit} from ${start} to ${end}. The highest is ${peakBar.spoken}.`,
  };
}

module.exports = { niceStep, compactDollars, shortLabel, buildRankedBars, buildTimeColumns };
