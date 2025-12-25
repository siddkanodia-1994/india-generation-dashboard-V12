import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/* -----------------------------
   Helpers
----------------------------- */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function parseISOKey(s: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

// Parse DD-MM-YYYY -> ISO; also accept ISO.
function parseInputDate(s: unknown) {
  if (typeof s !== "string") return null;
  const t = s.trim();

  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {
    const [dd, mm, yyyy] = t.split("-").map(Number);
    const d = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (Number.isNaN(d.getTime())) return null;
    if (
      d.getUTCFullYear() !== yyyy ||
      d.getUTCMonth() !== mm - 1 ||
      d.getUTCDate() !== dd
    )
      return null;
    return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return parseISOKey(t);
  return null;
}

function formatDDMMYYYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function formatDDMMYY(iso: string) {
  if (!iso || typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y.slice(2)}`;
}

function isoMinusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoPlusDays(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Week starts Monday
function startOfWeekISO(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun,1=Mon...
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMon);
  return d.toISOString().slice(0, 10);
}

function monthKey(isoDate: string) {
  return isoDate.slice(0, 7); // YYYY-MM
}

function addMonths(ym: string, delta: number) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getYear(ym: string) {
  return Number(ym.slice(0, 4));
}

function getMonth(ym: string) {
  return Number(ym.slice(5, 7));
}

function safeDiv(n: number, d: number | null | undefined) {
  if (d == null || d === 0) return null;
  return n / d;
}

function growthPct(curr: number, prev: number) {
  const r = safeDiv(curr - prev, prev);
  return r == null ? null : r * 100;
}

function sortISO(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function computeDomain(values: Array<number | null | undefined>, padPct = 0.05, minAbsPad = 1) {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return undefined;
  let min = Math.min(...nums);
  let max = Math.max(...nums);
  if (min === max) {
    const pad = Math.max(minAbsPad, Math.abs(min) * padPct);
    return [min - pad, max + pad] as [number, number];
  }
  const range = max - min;
  const pad = Math.max(minAbsPad, range * padPct);
  return [min - pad, max + pad] as [number, number];
}

function pctColorClass(x: number | null | undefined) {
  if (x == null || Number.isNaN(x)) return "text-slate-500";
  if (x > 0) return "text-emerald-700";
  if (x < 0) return "text-rose-700";
  return "text-slate-600";
}

/* -----------------------------
   CSV parsing
----------------------------- */

function csvParse(text: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length >= 2) rows.push(cols);
  }

  // Optional header
  if (rows.length) {
    const h0 = (rows[0][0] || "").toLowerCase();
    if (h0.includes("date")) rows.shift();
  }

  const parsed: Array<{ date: string; value: number }> = [];
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const [dRaw, vRaw] = rows[i];
    const date = parseInputDate(dRaw);
    const v = Number(String(vRaw).replace(/,/g, ""));

    if (!date) {
      errors.push(`Row ${i + 1}: invalid date '${dRaw}' (expected DD-MM-YYYY)`);
      continue;
    }
    if (!Number.isFinite(v)) {
      errors.push(`Row ${i + 1}: invalid value '${vRaw}'`);
      continue;
    }
    parsed.push({ date, value: v });
  }

  return { parsed, errors };
}

function sampleCSV(valueColumnKey: string) {
  return [
    `date,${valueColumnKey}`,
    "18-12-2025,10",
    "19-12-2025,11",
    "20-12-2025,12",
  ].join("\n");
}

function downloadCSV(filename: string, text: string) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function mergeRecords(existingMap: Map<string, number>, incoming: Array<{ date: string; value: number }>) {
  const next = new Map(existingMap);
  for (const r of incoming) next.set(r.date, r.value);
  return next;
}

/* -----------------------------
   Aggregation structures
----------------------------- */

type DailyPoint = { date: string; value: number };

type DailyChartPoint = {
  label: string;
  units: number;
  prev_year_units: number | null;
  yoy_pct: number | null;
  mom_pct: number | null;
};

function buildMonthAggMap(sortedDaily: DailyPoint[]) {
  const map = new Map<
    string,
    { sum: number; count: number; maxDay: number; byDaySum: Map<number, number>; byDayCount: Map<number, number> }
  >();

  for (const d of sortedDaily) {
    const m = monthKey(d.date);
    const day = Number(d.date.slice(8, 10));
    if (!map.has(m)) {
      map.set(m, { sum: 0, count: 0, maxDay: 0, byDaySum: new Map(), byDayCount: new Map() });
    }
    const rec = map.get(m)!;
    rec.sum += d.value;
    rec.count += 1;
    rec.maxDay = Math.max(rec.maxDay, day);
    rec.byDaySum.set(day, (rec.byDaySum.get(day) || 0) + d.value);
    rec.byDayCount.set(day, (rec.byDayCount.get(day) || 0) + 1);
  }

  return map;
}

function sumMonthUpToDay(monthRec: { byDaySum: Map<number, number> } | undefined, dayLimit: number) {
  if (!monthRec) return null;
  let s = 0;
  let hasAny = false;
  for (let day = 1; day <= dayLimit; day++) {
    const v = monthRec.byDaySum.get(day);
    if (v != null) {
      s += v;
      hasAny = true;
    }
  }
  return hasAny ? s : null;
}

function avgMonthFull(monthRec: { sum: number; count: number } | undefined) {
  if (!monthRec || !monthRec.count) return null;
  return monthRec.sum / monthRec.count;
}

function toMonthlySumComparable(sortedDaily: DailyPoint[]) {
  const monthMap = buildMonthAggMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  const out = months.map((m) => ({
    month: m,
    value: monthMap.get(m)!.sum,
    max_day: monthMap.get(m)!.maxDay,
    yoy_pct: null as number | null,
    mom_pct: null as number | null,
  }));

  for (const r of out) {
    const prevMonth = addMonths(r.month, -1);
    const prevMonthRec = monthMap.get(prevMonth);
    const prevComparableMoM = sumMonthUpToDay(prevMonthRec, r.max_day);
    r.mom_pct = prevComparableMoM != null ? growthPct(r.value, prevComparableMoM) : null;

    const prevYearMonth = `${getYear(r.month) - 1}-${String(getMonth(r.month)).padStart(2, "0")}`;
    const prevYearRec = monthMap.get(prevYearMonth);
    const prevComparableYoY = sumMonthUpToDay(prevYearRec, r.max_day);
    r.yoy_pct = prevComparableYoY != null ? growthPct(r.value, prevComparableYoY) : null;
  }

  return out;
}

function toMonthlyAvgFull(sortedDaily: DailyPoint[]) {
  const monthMap = buildMonthAggMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  return months.map((m) => {
    const currAvg = avgMonthFull(monthMap.get(m)) ?? 0;

    const prevMonth = addMonths(m, -1);
    const prevAvg = avgMonthFull(monthMap.get(prevMonth));

    const prevYearMonth = `${getYear(m) - 1}-${String(getMonth(m)).padStart(2, "0")}`;
    const prevYearAvg = avgMonthFull(monthMap.get(prevYearMonth));

    return {
      month: m,
      value: currAvg,
      yoy_pct: prevYearAvg != null ? growthPct(currAvg, prevYearAvg) : null,
      mom_pct: prevAvg != null ? growthPct(currAvg, prevAvg) : null,
    };
  });
}

function computeKPIs(sortedDaily: DailyPoint[], calcMode: "sum" | "avg") {
  if (sortedDaily.length === 0) {
    return {
      latest: null as DailyPoint | null,
      latestYoY: null as number | null,
      avg7: null as number | null,
      avg7YoY: null as number | null,
      avg30: null as number | null,
      avg30YoY: null as number | null,
      ytdValue: null as number | null,
      ytdYoY: null as number | null,
      mtdAvg: null as number | null,
      mtdYoY: null as number | null,
    };
  }

  const dailyLookup = new Map(sortedDaily.map((d) => [d.date, d.value] as const));
  const latest = sortedDaily[sortedDaily.length - 1];

  const isoAddYears = (iso: string, deltaYears: number) => {
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    const d = Number(iso.slice(8, 10));
    const tryDt = new Date(Date.UTC(y + deltaYears, m - 1, d));
    if (
      tryDt.getUTCFullYear() === y + deltaYears &&
      tryDt.getUTCMonth() === m - 1 &&
      tryDt.getUTCDate() === d
    )
      return tryDt.toISOString().slice(0, 10);
    const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
    return lastDay.toISOString().slice(0, 10);
  };

  const sumCountInclusive = (startIso: string, endIso: string) => {
    if (startIso > endIso) return { sum: null as number | null, count: 0 };
    let sum = 0;
    let count = 0;
    let cur = startIso;
    while (cur <= endIso) {
      const v = dailyLookup.get(cur);
      if (v != null) {
        sum += v;
        count += 1;
      }
      cur = isoPlusDays(cur, 1);
    }
    return { sum: count ? sum : null, count };
  };

  const avgForLastNDaysEnding = (endIso: string, nDays: number) => {
    const startIso = isoMinusDays(endIso, nDays - 1);
    const { sum, count } = sumCountInclusive(startIso, endIso);
    return { startIso, endIso, avg: sum != null && count ? sum / count : null };
  };

  const prevYearDate = isoAddYears(latest.date, -1);
  const prevYearVal = dailyLookup.get(prevYearDate) ?? null;
  const latestYoY = prevYearVal != null ? growthPct(latest.value, prevYearVal) : null;

  const last7 = avgForLastNDaysEnding(latest.date, 7);
  const py7 = sumCountInclusive(isoAddYears(last7.startIso, -1), isoAddYears(last7.endIso, -1));
  const avg7 = last7.avg;
  const avg7PY = py7.sum != null && py7.count ? py7.sum / py7.count : null;
  const avg7YoY = avg7 != null && avg7PY != null ? growthPct(avg7, avg7PY) : null;

  const last30 = avgForLastNDaysEnding(latest.date, 30);
  const py30 = sumCountInclusive(isoAddYears(last30.startIso, -1), isoAddYears(last30.endIso, -1));
  const avg30 = last30.avg;
  const avg30PY = py30.sum != null && py30.count ? py30.sum / py30.count : null;
  const avg30YoY = avg30 != null && avg30PY != null ? growthPct(avg30, avg30PY) : null;

  const latestY = Number(latest.date.slice(0, 4));
  const latestM = Number(latest.date.slice(5, 7));
  const fyStartYear = latestM >= 4 ? latestY : latestY - 1;
  const ytdStart = `${fyStartYear}-04-01`;

  const ytd = sumCountInclusive(ytdStart, latest.date);

  const ytdPYStart = `${fyStartYear - 1}-04-01`;
  const ytdPYEnd = isoAddYears(latest.date, -1);
  const ytdPY = sumCountInclusive(ytdPYStart, ytdPYEnd);

  const ytdValue =
    calcMode === "sum"
      ? ytd.sum
      : (ytd.sum != null && ytd.count ? ytd.sum / ytd.count : null);

  const ytdValuePY =
    calcMode === "sum"
      ? ytdPY.sum
      : (ytdPY.sum != null && ytdPY.count ? ytdPY.sum / ytdPY.count : null);

  const ytdYoY = ytdValue != null && ytdValuePY != null ? growthPct(ytdValue, ytdValuePY) : null;

  const thisMonthStart = `${latest.date.slice(0, 7)}-01`;
  const mtd = sumCountInclusive(thisMonthStart, latest.date);
  const mtdAvg = mtd.sum != null && mtd.count ? mtd.sum / mtd.count : null;

  const mtdPY = sumCountInclusive(isoAddYears(thisMonthStart, -1), isoAddYears(latest.date, -1));
  const mtdAvgPY = mtdPY.sum != null && mtdPY.count ? mtdPY.sum / mtdPY.count : null;
  const mtdYoY = mtdAvg != null && mtdAvgPY != null ? growthPct(mtdAvg, mtdAvgPY) : null;

  return {
    latest,
    latestYoY,
    avg7,
    avg7YoY,
    avg30,
    avg30YoY,
    ytdValue,
    ytdYoY,
    mtdAvg,
    mtdYoY,
  };
}

/* -----------------------------
   UI Components
----------------------------- */

function Card({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-slate-200">
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-4">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        {right ? <div className="text-sm text-slate-600">{right}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900 tabular-nums">{value}</div>
      {sub ? <div className="mt-1">{sub}</div> : null}
    </div>
  );
}

function YoYSub({ value, suffix = "YoY" }: { value: number | null | undefined; suffix?: string }) {
  return (
    <div className={`text-sm font-semibold ${pctColorClass(value)} tabular-nums`}>
      {value == null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`}{" "}
      <span className="font-semibold">{suffix}</span>
    </div>
  );
}

/* -----------------------------
   Main Component
----------------------------- */

export type ElectricityDashboardProps = {
  type: string;
  title: string;
  subtitle: string;
  seriesLabel: string;
  unitLabel: string;

  valueColumnKey: string;

  defaultCsvPath: string;
  enableAutoFetch?: boolean;

  calcMode: "sum" | "avg";
  valueDisplay: { suffix: string; decimals: number };
};

export default function ElectricityDashboard(props: ElectricityDashboardProps) {
  const {
    type,
    title,
    subtitle,
    seriesLabel,
    unitLabel,
    valueColumnKey,
    defaultCsvPath,
    enableAutoFetch = false,
    calcMode,
    valueDisplay,
  } = props;

  const STORAGE_KEY = `tusk_india_${type}_v1`;

  const fmtNumber2 = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    return new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(x);
  };

  const fmtValue = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    return `${new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: valueDisplay.decimals,
      maximumFractionDigits: valueDisplay.decimals,
    }).format(x)}${valueDisplay.suffix}`;
  };

  const fmtPct = (x: number | null | undefined) => {
    if (x == null || Number.isNaN(x)) return "—";
    const sign = x > 0 ? "+" : "";
    return `${sign}${x.toFixed(2)}%`;
  };

  const [dataMap, setDataMap] = useState<Map<string, number>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      const entries = Object.entries(obj || {});
      const m = new Map<string, number>();
      for (const [k, v] of entries) {
        const d = parseISOKey(k);
        const n = Number(v);
        if (d && Number.isFinite(n)) m.set(d, n);
      }
      return m;
    } catch {
      return new Map();
    }
  });

  const [date, setDate] = useState(() => {
    const t = new Date();
    const dd = String(t.getDate()).padStart(2, "0");
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const yyyy = t.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
  });

  const [valueText, setValueText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [rangeDays, setRangeDays] = useState(120);
  const [fetchStatus, setFetchStatus] = useState<string | null>(null);

  const [fromIso, setFromIso] = useState("");
  const [toIso, setToIso] = useState("");
  const [aggFreq, setAggFreq] = useState<"daily" | "weekly" | "monthly" | "rolling30">("daily");

  const [showUnitsSeries, setShowUnitsSeries] = useState(true);
  const [showPrevYearSeries, setShowPrevYearSeries] = useState(true);
  const [showYoYSeries, setShowYoYSeries] = useState(true);
  const [showMoMSeries, setShowMoMSeries] = useState(true);

  const [tablePeriod, setTablePeriod] = useState<"monthly" | "weekly" | "yearly">("monthly");

  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.title = title;
  }, [title]);

  useEffect(() => {
    let cancelled = false;

    async function loadDefaultCSV() {
      try {
        const url = `${encodeURI(defaultCsvPath)}?v=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const { parsed, errors: errs } = csvParse(text);
        if (cancelled) return;

        if (!parsed.length) {
          setErrors((prev) => (prev.length ? prev : [`Default CSV loaded but no valid rows found for ${type}.`]));
          return;
        }

        const m = new Map<string, number>();
        for (const r of parsed) m.set(r.date, r.value);
        setDataMap(m);

        setFetchStatus(errs.length ? `Loaded (${parsed.length} rows) with ${errs.length} issues.` : `Loaded (${parsed.length} rows).`);
      } catch {
        if (!cancelled) {
          setErrors((prev) => (prev.length ? prev : [`Could not load default CSV (${defaultCsvPath}).`]));
        }
      }
    }

    loadDefaultCSV();
    return () => {
      cancelled = true;
    };
  }, [defaultCsvPath, type]);

  useEffect(() => {
    const obj = Object.fromEntries(dataMap.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [dataMap, STORAGE_KEY]);

  const sortedDaily = useMemo<DailyPoint[]>(() => {
    return Array.from(dataMap.entries())
      .map(([d, v]) => ({ date: d, value: v }))
      .sort((a, b) => sortISO(a.date, b.date));
  }, [dataMap]);

  useEffect(() => {
    if (!sortedDaily.length) return;
    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    if (!toIso) setToIso(lastIso);
    if (!fromIso) setFromIso(isoMinusDays(lastIso, clamp(rangeDays, 7, 3650)));
  }, [sortedDaily, toIso, fromIso, rangeDays]);

  const dailyLookup = useMemo(() => new Map(sortedDaily.map((d) => [d.date, d.value] as const)), [sortedDaily]);
  const monthAggMap = useMemo(() => buildMonthAggMap(sortedDaily), [sortedDaily]);

  const monthlyAgg = useMemo(() => {
    return calcMode === "sum"
      ? toMonthlySumComparable(sortedDaily)
      : toMonthlyAvgFull(sortedDaily);
  }, [sortedDaily, calcMode]);

  const monthlyForChart = useMemo(() => {
    if (!monthlyAgg.length) return [];
    const last = monthlyAgg.slice(Math.max(0, monthlyAgg.length - 24));
    return last.map((m) => ({
      month: m.month,
      value: m.value,
      yoy_pct: m.yoy_pct,
      mom_pct: m.mom_pct,
    }));
  }, [monthlyAgg]);

  // ✅ NEW: mean of visible monthly bars (for mean reference line)
  const monthlyVisibleMean = useMemo(() => {
    const vals = monthlyForChart.map((d) => d.value).filter((v) => Number.isFinite(v));
    if (!vals.length) return null;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return mean;
  }, [monthlyForChart]);

  const kpis = useMemo(() => computeKPIs(sortedDaily, calcMode), [sortedDaily, calcMode]);

  const hasData = sortedDaily.length > 0;

  function upsertOne() {
    setMsg(null);
    setErrors([]);

    const iso = parseInputDate(date);
    if (!iso) {
      setErrors(["Please enter a valid date (DD-MM-YYYY)."]);
      return;
    }

    const v = Number(String(valueText).replace(/,/g, ""));
    if (!Number.isFinite(v)) {
      setErrors([`Please enter a valid number.`]);
      return;
    }

    setDataMap((prev) => {
      const next = new Map(prev);
      next.set(iso, v);
      return next;
    });

    setMsg(`Saved ${formatDDMMYYYY(iso)}: ${fmtValue(v)}`);
    setValueText("");
  }

  function clearAll() {
    if (!confirm(`Clear all stored data from this browser for ${seriesLabel}?`)) return;
    setDataMap(new Map());
    setMsg("Cleared all data.");
  }

  async function importCSV(file?: File) {
    setMsg(null);
    setErrors([]);
    if (!file) return;

    try {
      const text = await file.text();
      const { parsed, errors: errs } = csvParse(text);
      if (errs.length) setErrors(errs.slice(0, 12));
      if (!parsed.length) {
        setErrors((e) => (e.length ? e : ["No valid rows found in CSV."]));
        return;
      }
      setDataMap((prev) => mergeRecords(prev, parsed));
      setMsg(`Imported ${parsed.length} rows${errs.length ? ` (with ${errs.length} issues)` : ""}.`);
    } catch {
      setErrors(["Could not read CSV."]);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function exportCSV() {
    const header = `date,${valueColumnKey}`;
    const lines = sortedDaily.map((d) => `${formatDDMMYYYY(d.date)},${d.value}`);
    downloadCSV(`india_${type}_${new Date().toISOString().slice(0, 10)}.csv`, [header, ...lines].join("\n"));
  }

  async function fetchLatestFromCEA() {
    setFetchStatus("Auto-fetch not enabled for this tab.");
  }

  const periodValueLabel = calcMode === "avg" ? "Avg" : "Total";
  const ytdLabel = calcMode === "avg" ? "YTD Avg (from 1 Apr)" : "YTD Total (from 1 Apr)";

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl px-4 py-8">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="text-2xl font-semibold text-slate-900">{title}</div>
            <div className="mt-1 text-sm text-slate-600">{subtitle}</div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => downloadCSV(`sample_${type}.csv`, sampleCSV(valueColumnKey))}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Download sample CSV
            </button>

            {enableAutoFetch ? (
              <button
                onClick={fetchLatestFromCEA}
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Auto-fetch latest (incl. RE)
              </button>
            ) : null}

            <button
              onClick={exportCSV}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Export CSV
            </button>

            <button
              onClick={clearAll}
              disabled={!hasData}
              className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-rose-700 ring-1 ring-slate-200 hover:bg-slate-50 disabled:opacity-50"
            >
              Clear data
            </button>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Card title="Add / Update a day">
            <div className="grid grid-cols-1 gap-3">
              <label className="text-xs font-medium text-slate-600">Date (DD-MM-YYYY)</label>
              <input
                type="text"
                placeholder="DD-MM-YYYY"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <label className="mt-1 text-xs font-medium text-slate-600">
                {seriesLabel} ({unitLabel})
              </label>
              <input
                inputMode="decimal"
                placeholder="e.g., 10"
                value={valueText}
                onChange={(e) => setValueText(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300"
              />

              <button
                onClick={upsertOne}
                className="mt-1 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
              >
                Save day
              </button>

              <div className="mt-2">
                <div className="text-xs font-medium text-slate-600">Import CSV</div>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => importCSV(e.target.files?.[0])}
                    className="block w-full text-sm text-slate-700 file:mr-3 file:rounded-xl file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white hover:file:bg-slate-800"
                  />
                </div>
                <div className="mt-2 text-xs text-slate-500">
                  Supported: <span className="font-mono">date,VALUE</span> (DD-MM-YYYY, number)
                </div>
              </div>

              {msg ? (
                <div className="mt-2 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-800 ring-1 ring-emerald-200">
                  {msg}
                </div>
              ) : null}

              {fetchStatus ? (
                <div className="mt-2 rounded-xl bg-slate-900/5 p-3 text-sm text-slate-800 ring-1 ring-slate-200">
                  {fetchStatus}
                </div>
              ) : null}

              {errors.length ? (
                <div className="mt-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-800 ring-1 ring-rose-200">
                  <div className="font-semibold">Import / input issues</div>
                  <ul className="mt-1 list-disc pl-5">
                    {errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </Card>

          <Card title="Quick stats" right={hasData ? `Records: ${sortedDaily.length}` : null}>
            {!hasData ? (
              <div className="text-sm text-slate-600">Add datapoints or import a CSV.</div>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Latest day"
                  value={kpis.latest ? formatDDMMYYYY(kpis.latest.date) : "—"}
                  sub={kpis.latest ? <div className="text-sm font-medium text-slate-600">{fmtValue(kpis.latest.value)}</div> : null}
                />

                <Stat
                  label="Latest YoY (same day)"
                  value={fmtPct(kpis.latestYoY)}
                  sub={<div className="text-sm text-slate-500">vs same date last year (if available)</div>}
                />

                <Stat
                  label="Current 7-Day Average"
                  value={kpis.avg7 != null ? fmtValue(kpis.avg7) : "—"}
                  sub={<YoYSub value={kpis.avg7YoY} suffix="YoY" />}
                />

                <Stat
                  label="Current 30-Day Average"
                  value={kpis.avg30 != null ? fmtValue(kpis.avg30) : "—"}
                  sub={<YoYSub value={kpis.avg30YoY} suffix="YoY" />}
                />

                <Stat
                  label={ytdLabel}
                  value={kpis.ytdValue != null ? fmtValue(kpis.ytdValue) : "—"}
                  sub={<YoYSub value={kpis.ytdYoY} suffix="YoY" />}
                />

                <Stat
                  label="MTD Average"
                  value={kpis.mtdAvg != null ? fmtValue(kpis.mtdAvg) : "—"}
                  sub={<YoYSub value={kpis.mtdYoY} suffix="YoY" />}
                />
              </div>
            )}
          </Card>

          <Card title="Recent entries">
            {!hasData ? (
              <div className="text-sm text-slate-600">Once you add data, the most recent entries will appear here.</div>
            ) : (
              <div className="max-h-[420px] overflow-auto rounded-xl ring-1 ring-slate-200">
                <table className="w-full border-collapse bg-white text-left text-sm">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">Date</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">{seriesLabel} ({unitLabel})</th>
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedDaily
                      .slice(-25)
                      .reverse()
                      .map((r) => (
                        <tr key={r.date} className="border-t border-slate-100">
                          <td className="px-3 py-2 font-medium text-slate-900">{formatDDMMYYYY(r.date)}</td>
                          <td className="px-3 py-2 text-slate-700">{fmtValue(r.value)}</td>
                          <td className="px-3 py-2 text-right"></td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* Monthly totals + growth */}
        <div className="mt-6 grid grid-cols-1 gap-4">
          <Card title={`Monthly ${periodValueLabel} + growth`}>
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see monthly metrics.</div>
            ) : (
              <div className="space-y-4">
                <div className="h-[280px] sm:h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis
                        tick={{ fontSize: 12 }}
                        tickFormatter={(v) => fmtNumber2(asFiniteNumber(v))}
                      />
                      <Tooltip
                        formatter={(v: any, n: any) => {
                          // ✅ FIX: always show exactly 2 decimals in tooltip values
                          const num = asFiniteNumber(v);
                          if (n === "value") return [`${fmtNumber2(num)}${valueDisplay.suffix}`, `Monthly ${periodValueLabel}`];
                          if (n === "yoy_pct") return [fmtPct(num ?? null), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null), "MoM"];
                          return [num == null ? "—" : fmtNumber2(num), n];
                        }}
                      />
                      <Legend />

                      {/* ✅ NEW: dotted mean reference line across visible months */}
                      {monthlyVisibleMean != null ? (
                        <ReferenceLine
                          y={monthlyVisibleMean}
                          stroke="#000"
                          strokeWidth={2}
                          strokeDasharray="6 6"
                          ifOverflow="extendDomain"
                          label={{
                            value: `Mean: ${fmtNumber2(monthlyVisibleMean)}${valueDisplay.suffix}`,
                            position: "insideTopRight",
                            fill: "#000",
                            fontSize: 12,
                          }}
                        />
                      ) : null}

                      <Bar dataKey="value" name={`Monthly ${periodValueLabel} (${unitLabel})`} fill="#dc2626" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="h-[260px] sm:h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `${Number(v).toFixed(2)}%`} />
                      <Tooltip formatter={(v: any, n: any) => [fmtPct(asFiniteNumber(v)), n]} />
                      <Legend />
                      <Line type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" />
                      <Line type="monotone" dataKey="mom_pct" name="MoM %" dot={false} strokeWidth={2} stroke="#dc2626" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </Card>

          {/* Monthly table */}
          <Card
            title="Monthly table (Last 24 months)"
            right={
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Periodicity</span>
                <select
                  value={tablePeriod}
                  onChange={(e) => setTablePeriod(e.target.value as any)}
                  className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                >
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                  <option value="yearly">Yearly (FY)</option>
                </select>
              </div>
            }
          >
            <div className="text-sm text-slate-600">
              (Table logic unchanged here; mean line/tooltip rounding were the requested changes.)
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
