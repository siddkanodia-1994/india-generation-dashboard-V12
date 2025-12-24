import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Shared electricity dashboard component
 * - Loads /public/data/<type>.csv baseline on every load (cache-busted)
 * - Optional localStorage edits per tab (keyed by type)
 * - Same UI: entry, import/export, stats, daily & monthly charts, tables
 */

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

// ----------------------
// Date helpers
// ----------------------

function parseISOKey(s: string) {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!ok) return null;
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : s;
}

// Parse DD-MM-YYYY (preferred) -> ISO, also accept ISO for backward compatibility
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

// NEW: Display short date DD/MM/YY (for From/To helper label + Week starting label)
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

// Week starts on Monday
function startOfWeekISO(iso: string) {
  const d = new Date(iso + "T00:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun,1=Mon,...
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diffToMon);
  return d.toISOString().slice(0, 10);
}

// ----------------------
// Number formatting
// ----------------------

function fmtNum(x: number | null | undefined, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  return new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(x);
}

function fmtPct(x: number | null | undefined, digits = 2) {
  if (x == null || Number.isNaN(x)) return "—";
  const sign = x > 0 ? "+" : "";
  return `${sign}${fmtNum(x, digits)}%`;
}

function pctColorClass(x: number | null | undefined) {
  if (x == null || Number.isNaN(x)) return "text-slate-500";
  if (x > 0) return "text-emerald-700";
  if (x < 0) return "text-rose-700";
  return "text-slate-600";
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ----------------------
// Domains (auto-scale axes with padding)
// ----------------------

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

// ----------------------
// Aggregation + growth
// ----------------------

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

function mergeRecords(
  existingMap: Map<string, number>,
  incoming: Array<{ date: string; value: number }>
) {
  const next = new Map(existingMap);
  for (const r of incoming) next.set(r.date, r.value);
  return next;
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

// ----------------------
// Data types
// ----------------------

type DailyPoint = { date: string; value: number };

type DailyChartPoint = {
  label: string;
  units: number;
  prev_year_units: number | null;
  yoy_pct: number | null;
  mom_pct: number | null; // weekly: WoW%, monthly: MoM%
};

// ----------------------
// KPI + monthly computation
// ----------------------

function computeKPIs(sortedDaily: DailyPoint[]) {
  if (sortedDaily.length === 0) {
    return {
      latest: null as DailyPoint | null,
      latestYoY: null as number | null,

      avg7: null as number | null,
      avg7YoY: null as number | null,

      avg30: null as number | null,
      avg30YoY: null as number | null,

      ytdTotal: null as number | null,
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
    ) {
      return tryDt.toISOString().slice(0, 10);
    }

    const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
    return lastDay.toISOString().slice(0, 10);
  };

  const sumAndCountInclusive = (startIso: string, endIso: string) => {
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
    const { sum, count } = sumAndCountInclusive(startIso, endIso);
    return { startIso, endIso, avg: sum != null && count ? sum / count : null };
  };

  const prevYearDate = isoAddYears(latest.date, -1);
  const prevYearVal = dailyLookup.get(prevYearDate) ?? null;
  const latestYoY = prevYearVal != null ? growthPct(latest.value, prevYearVal) : null;

  const last7 = avgForLastNDaysEnding(latest.date, 7);
  const py7 = sumAndCountInclusive(
    isoAddYears(last7.startIso, -1),
    isoAddYears(last7.endIso, -1)
  );
  const avg7 = last7.avg;
  const avg7PY = py7.sum != null && py7.count ? py7.sum / py7.count : null;
  const avg7YoY = avg7 != null && avg7PY != null ? growthPct(avg7, avg7PY) : null;

  const last30 = avgForLastNDaysEnding(latest.date, 30);
  const py30 = sumAndCountInclusive(
    isoAddYears(last30.startIso, -1),
    isoAddYears(last30.endIso, -1)
  );
  const avg30 = last30.avg;
  const avg30PY = py30.sum != null && py30.count ? py30.sum / py30.count : null;
  const avg30YoY = avg30 != null && avg30PY != null ? growthPct(avg30, avg30PY) : null;

  const latestY = Number(latest.date.slice(0, 4));
  const latestM = Number(latest.date.slice(5, 7));
  const fyStartYear = latestM >= 4 ? latestY : latestY - 1;
  const ytdStart = `${fyStartYear}-04-01`;

  const ytd = sumAndCountInclusive(ytdStart, latest.date);
  const ytdTotal = ytd.sum;

  const ytdPYStart = `${fyStartYear - 1}-04-01`;
  const ytdPYEnd = isoAddYears(latest.date, -1);
  const ytdPY = sumAndCountInclusive(ytdPYStart, ytdPYEnd);
  const ytdTotalPY = ytdPY.sum;
  const ytdYoY =
    ytdTotal != null && ytdTotalPY != null ? growthPct(ytdTotal, ytdTotalPY) : null;

  const thisMonthStart = `${latest.date.slice(0, 7)}-01`;
  const mtd = sumAndCountInclusive(thisMonthStart, latest.date);
  const mtdAvg = mtd.sum != null && mtd.count ? mtd.sum / mtd.count : null;

  const mtdPY = sumAndCountInclusive(
    isoAddYears(thisMonthStart, -1),
    isoAddYears(latest.date, -1)
  );
  const mtdAvgPY = mtdPY.sum != null && mtdPY.count ? mtdPY.sum / mtdPY.count : null;
  const mtdYoY = mtdAvg != null && mtdAvgPY != null ? growthPct(mtdAvg, mtdAvgPY) : null;

  return {
    latest,
    latestYoY,
    avg7,
    avg7YoY,
    avg30,
    avg30YoY,
    ytdTotal,
    ytdYoY,
    mtdAvg,
    mtdYoY,
  };
}

function buildMonthDayMap(sortedDaily: DailyPoint[]) {
  const map = new Map<string, { total: number; maxDay: number; byDay: Map<number, number> }>();

  for (const d of sortedDaily) {
    const m = monthKey(d.date);
    const day = Number(d.date.slice(8, 10));

    if (!map.has(m)) map.set(m, { total: 0, maxDay: 0, byDay: new Map() });

    const rec = map.get(m)!;
    rec.total += d.value;
    rec.maxDay = Math.max(rec.maxDay, day);
    rec.byDay.set(day, (rec.byDay.get(day) || 0) + d.value);
  }

  return map;
}

function sumMonthUpToDay(monthRec: { byDay: Map<number, number> } | undefined, dayLimit: number) {
  if (!monthRec) return null;
  let s = 0;
  let hasAny = false;
  for (let day = 1; day <= dayLimit; day++) {
    const v = monthRec.byDay.get(day);
    if (v != null) {
      s += v;
      hasAny = true;
    }
  }
  return hasAny ? s : null;
}

function toMonthly(sortedDaily: DailyPoint[]) {
  const monthMap = buildMonthDayMap(sortedDaily);
  const months = Array.from(monthMap.keys()).sort(sortISO);

  const out = months.map((m) => ({
    month: m,
    total_gwh: monthMap.get(m)!.total,
    max_day: monthMap.get(m)!.maxDay,
    yoy_pct: null as number | null,
    mom_pct: null as number | null,
  }));

  for (const r of out) {
    const prevMonth = addMonths(r.month, -1);
    const prevMonthRec = monthMap.get(prevMonth);
    const prevComparableMoM = sumMonthUpToDay(prevMonthRec, r.max_day);
    r.mom_pct = prevComparableMoM != null ? growthPct(r.total_gwh, prevComparableMoM) : null;

    const prevYearMonth = `${getYear(r.month) - 1}-${String(getMonth(r.month)).padStart(2, "0")}`;
    const prevYearRec = monthMap.get(prevYearMonth);
    const prevComparableYoY = sumMonthUpToDay(prevYearRec, r.max_day);
    r.yoy_pct = prevComparableYoY != null ? growthPct(r.total_gwh, prevComparableYoY) : null;
  }

  return out;
}

// ----------------------
// Weekly + FY helpers for table dropdown
// ----------------------

function fyLabelFromIso(iso: string) {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  // FY starts Apr => FY25 means Apr-2024 to Mar-2025
  const fyEndYear = m >= 4 ? y + 1 : y;
  return `FY${String(fyEndYear).slice(2)}`;
}

function fyStartIsoFromFYLabel(fy: string) {
  // FY25 => start 2024-04-01
  const yy = Number(fy.slice(2));
  const fyEndYear = 2000 + yy;
  const fyStartYear = fyEndYear - 1;
  return `${fyStartYear}-04-01`;
}

// ----------------------
// CSV helpers (type-aware)
// ----------------------

function csvParse(text: string, valueColumnKey: string) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows: string[][] = [];
  for (const line of lines) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols.length >= 2) rows.push(cols);
  }

  // header optional
  if (rows.length) {
    const h0 = (rows[0][0] || "").toLowerCase();
    const h1 = (rows[0][1] || "").toLowerCase();
    const key = valueColumnKey.toLowerCase();
    if (h0.includes("date") && (h1.includes(key) || h1.includes("gwh"))) rows.shift();
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

    if (!Number.isFinite(v) || v < 0) {
      errors.push(`Row ${i + 1}: invalid value '${vRaw}' (expected non-negative number)`);
      continue;
    }

    parsed.push({ date, value: v });
  }

  return { parsed, errors };
}

function sampleCSV(valueColumnKey: string) {
  return [
    `date,${valueColumnKey}`,
    "18-12-2025,4140",
    "19-12-2025,4215",
    "20-12-2025,4198",
  ].join("\n");
}

// ----------------------
// UI components
// ----------------------

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
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {sub ? <div className="mt-1">{sub}</div> : null}
    </div>
  );
}

function YoYSub({ value, suffix = "YoY" }: { value: number | null | undefined; suffix?: string }) {
  // Bigger + bolder YoY subtext per request
  return (
    <div className={`text-sm font-semibold ${pctColorClass(value)} tabular-nums`}>
      {fmtPct(value, 2)} <span className="font-semibold">{suffix}</span>
    </div>
  );
}

function MutedSub({ text }: { text: string }) {
  return <div className="text-sm font-medium text-slate-500">{text}</div>;
}

function EmptyState({ onLoadSample }: { onLoadSample: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <div className="mx-auto max-w-xl">
        <div className="text-lg font-semibold text-slate-900">No data yet</div>
        <div className="mt-2 text-sm text-slate-600">
          Add your first daily datapoint (units/MU) or import a CSV. The dashboard will compute monthly totals, YoY%, and
          MoM%.
        </div>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <button
            onClick={onLoadSample}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Load sample data
          </button>
        </div>
      </div>
    </div>
  );
}

// ----------------------
// Component
// ----------------------

export type ElectricityDashboardProps = {
  type: "generation" | "demand" | "supply";
  title: string;
  subtitle: string;
  seriesLabel: string; // e.g., "Generation", "Demand", "Supply"
  unitLabel: string; // e.g., "units / MU"
  valueColumnKey: string; // e.g., generation_gwh, demand_gwh, supply_gwh
  defaultCsvPath?: string; // default: /data/<type>.csv
  enableAutoFetch?: boolean; // default: true for generation
};

export default function ElectricityDashboard(props: ElectricityDashboardProps) {
  const {
    type,
    title,
    subtitle,
    seriesLabel,
    unitLabel,
    valueColumnKey,
    defaultCsvPath = `/data/${type}.csv`,
    enableAutoFetch = true,
  } = props;

  const STORAGE_KEY = `tusk_india_${type}_v1`;

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
        if (d && Number.isFinite(n) && n >= 0) m.set(d, n);
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

  // Series toggles
  const [showUnitsSeries, setShowUnitsSeries] = useState(true);
  const [showPrevYearSeries, setShowPrevYearSeries] = useState(true);
  const [showYoYSeries, setShowYoYSeries] = useState(true);
  const [showMoMSeries, setShowMoMSeries] = useState(true);
  const [showControlLines, setShowControlLines] = useState(false);

  // NEW: Monthly table periodicity dropdown
  const [tablePeriod, setTablePeriod] = useState<"monthly" | "weekly" | "yearly">("monthly");

  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.title = title;
  }, [title]);

  // ---- Load CSV baseline on each mount (cache-bust) ----
  useEffect(() => {
    let cancelled = false;

    async function loadDefaultCSV() {
      try {
        const url = `${defaultCsvPath}?v=${Date.now()}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const text = await res.text();
        const { parsed, errors: errs } = csvParse(text, valueColumnKey);
        if (cancelled) return;

        if (!parsed.length) {
          setErrors((prev) =>
            prev.length ? prev : [`Default CSV loaded but no valid rows were found for ${type}.`]
          );
          return;
        }

        const m = new Map<string, number>();
        for (const r of parsed) m.set(r.date, r.value);

        setDataMap(m);

        if (errs.length) {
          setFetchStatus(`Loaded ${type}.csv (${parsed.length} rows) with ${errs.length} issues.`);
        } else {
          setFetchStatus(`Loaded ${type}.csv (${parsed.length} rows).`);
        }
      } catch {
        if (!cancelled) {
          setErrors((prev) =>
            prev.length ? prev : [`Could not load default CSV (${defaultCsvPath}).`]
          );
        }
      }
    }

    loadDefaultCSV();
    return () => {
      cancelled = true;
    };
  }, [defaultCsvPath, type, valueColumnKey]);

  // Persist local edits
  useEffect(() => {
    const obj = Object.fromEntries(dataMap.entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
  }, [dataMap, STORAGE_KEY]);

  const sortedDaily = useMemo<DailyPoint[]>(() => {
    return Array.from(dataMap.entries())
      .map(([d, v]) => ({ date: d, value: v }))
      .sort((a, b) => sortISO(a.date, b.date));
  }, [dataMap]);

  // Initialize slicer after data loads
  useEffect(() => {
    if (!sortedDaily.length) return;
    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    if (!toIso) setToIso(lastIso);
    if (!fromIso) setFromIso(isoMinusDays(lastIso, clamp(rangeDays, 7, 3650)));
  }, [sortedDaily, toIso, fromIso, rangeDays]);

  // Chart data
  const dailyForChart = useMemo<DailyChartPoint[]>(() => {
    if (!sortedDaily.length) return [];

    const lastIso = sortedDaily[sortedDaily.length - 1].date;
    const effectiveTo = toIso || lastIso;
    const effectiveFrom = fromIso || isoMinusDays(lastIso, clamp(rangeDays, 7, 3650));

    const f = effectiveFrom <= effectiveTo ? effectiveFrom : effectiveTo;
    const t = effectiveFrom <= effectiveTo ? effectiveTo : effectiveFrom;

    const filtered = sortedDaily.filter((d) => d.date >= f && d.date <= t);
    const dailyLookup = new Map(sortedDaily.map((d) => [d.date, d.value]));

    const sumRangeInclusive = (startIso: string, endIso: string) => {
      if (startIso > endIso) return null;
      let s = 0;
      let hasAny = false;
      let cur = startIso;
      while (cur <= endIso) {
        const v = dailyLookup.get(cur);
        if (v != null) {
          s += v;
          hasAny = true;
        }
        cur = isoPlusDays(cur, 1);
      }
      return hasAny ? s : null;
    };

    if (aggFreq === "daily") {
      const sameDayPrevYear = (iso: string) => `${Number(iso.slice(0, 4)) - 1}${iso.slice(4)}`;
      const sameDayPrevMonth = (iso: string) => {
        const y = Number(iso.slice(0, 4));
        const m = Number(iso.slice(5, 7));
        const d = Number(iso.slice(8, 10));
        const dt = new Date(Date.UTC(y, m - 2, d));
        const iso2 = dt.toISOString().slice(0, 10);
        return Number(iso2.slice(8, 10)) === d ? iso2 : null;
      };

      return filtered.map((d) => {
        const pyDate = sameDayPrevYear(d.date);
        const pmDate = sameDayPrevMonth(d.date);
        const py = dailyLookup.get(pyDate) ?? null;
        const pm = pmDate ? dailyLookup.get(pmDate) ?? null : null;

        return {
          label: formatDDMMYYYY(d.date),
          units: d.value,
          prev_year_units: py,
          yoy_pct: py != null ? growthPct(d.value, py) : null,
          mom_pct: pm != null ? growthPct(d.value, pm) : null,
        };
      });
    }

    if (aggFreq === "rolling30") {
      const points: DailyChartPoint[] = [];
      let cur = f;
      while (cur <= t) {
        const start = isoMinusDays(cur, 29);
        const currSum = sumRangeInclusive(start, cur);

        const curPrevYear = isoMinusDays(cur, 365);
        const startPrevYear = isoMinusDays(curPrevYear, 29);
        const prevSum = sumRangeInclusive(startPrevYear, curPrevYear);

        points.push({
          label: formatDDMMYYYY(cur),
          units: currSum ?? 0,
          prev_year_units: prevSum,
          yoy_pct: currSum != null && prevSum != null ? growthPct(currSum, prevSum) : null,
          mom_pct: null,
        });

        cur = isoPlusDays(cur, 1);
      }
      return points;
    }

    if (aggFreq === "weekly") {
      const weekMap = new Map<string, number>();
      const weekOffsets = new Map<string, Set<number>>();

      for (const d of filtered) {
        const wk = startOfWeekISO(d.date);
        weekMap.set(wk, (weekMap.get(wk) || 0) + d.value);

        const off = Math.floor(
          (new Date(d.date + "T00:00:00Z").getTime() - new Date(wk + "T00:00:00Z").getTime()) /
            86400000
        );
        if (!weekOffsets.has(wk)) weekOffsets.set(wk, new Set());
        weekOffsets.get(wk)!.add(off);
      }

      const weeks = Array.from(weekMap.keys()).sort(sortISO);

      const sumWeekByOffsets = (weekStartIso: string, offsetsSet: Set<number>) => {
        let s = 0;
        let hasAny = false;
        for (const off of offsetsSet) {
          const key = isoPlusDays(weekStartIso, off);
          const v = dailyLookup.get(key);
          if (v != null) {
            s += v;
            hasAny = true;
          }
        }
        return hasAny ? s : null;
      };

      return weeks.map((wk) => {
        const curr = weekMap.get(wk)!;
        const offs = weekOffsets.get(wk) || new Set<number>();

        const prevWkYoY = isoMinusDays(wk, 364);
        const prevYoY = sumWeekByOffsets(prevWkYoY, offs);

        const prevWkWoW = isoMinusDays(wk, 7);
        const prevWoW = sumWeekByOffsets(prevWkWoW, offs);

        return {
          label: `Wk of ${formatDDMMYYYY(wk)}`,
          units: curr,
          prev_year_units: prevYoY,
          yoy_pct: prevYoY != null ? growthPct(curr, prevYoY) : null,
          mom_pct: prevWoW != null ? growthPct(curr, prevWoW) : null,
        };
      });
    }

    // monthly
    const mMap = new Map<string, number>();
    const monthDays = new Map<string, Set<number>>();

    for (const d of filtered) {
      const mk = monthKey(d.date);
      mMap.set(mk, (mMap.get(mk) || 0) + d.value);

      const day = Number(d.date.slice(8, 10));
      if (!monthDays.has(mk)) monthDays.set(mk, new Set());
      monthDays.get(mk)!.add(day);
    }

    const months = Array.from(mMap.keys()).sort(sortISO);

    const sumMonthByDaySet = (ym: string, daySet: Set<number>) => {
      const y = ym.slice(0, 4);
      const m = ym.slice(5, 7);
      let s = 0;
      let hasAny = false;
      for (const day of daySet) {
        const key = `${y}-${m}-${String(day).padStart(2, "0")}`;
        const v = dailyLookup.get(key);
        if (v != null) {
          s += v;
          hasAny = true;
        }
      }
      return hasAny ? s : null;
    };

    return months.map((m) => {
      const curr = mMap.get(m)!;
      const days = monthDays.get(m) || new Set<number>();

      const prevYearMonth = `${getYear(m) - 1}-${String(getMonth(m)).padStart(2, "0")}`;
      const prevYoY = sumMonthByDaySet(prevYearMonth, days);

      const prevMonth = addMonths(m, -1);
      const prevMoM = sumMonthByDaySet(prevMonth, days);

      return {
        label: m,
        units: curr,
        prev_year_units: prevYoY,
        yoy_pct: prevYoY != null ? growthPct(curr, prevYoY) : null,
        mom_pct: prevMoM != null ? growthPct(curr, prevMoM) : null,
      };
    });
  }, [sortedDaily, rangeDays, fromIso, toIso, aggFreq]);

  // Control lines for totals (left axis)
  const controlStatsLeft = useMemo(() => {
    if (!showControlLines) return null;
    if (!dailyForChart.length) return null;

    const values: number[] = [];

    if (showUnitsSeries) {
      for (const p of dailyForChart) {
        const n = asFiniteNumber(p.units);
        if (n != null) values.push(n);
      }
    } else if (showPrevYearSeries) {
      for (const p of dailyForChart) {
        const n = asFiniteNumber(p.prev_year_units);
        if (n != null) values.push(n);
      }
    } else {
      return null;
    }

    if (values.length < 2) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    const sd = Math.sqrt(variance);

    return {
      mean,
      sd,
      p1: mean + sd,
      p2: mean + 2 * sd,
      m1: mean - sd,
      m2: mean - 2 * sd,
    };
  }, [showControlLines, dailyForChart, showUnitsSeries, showPrevYearSeries]);

  // Control lines for YoY% (right axis)
  const controlStatsYoY = useMemo(() => {
    if (!showControlLines) return null;
    if (!dailyForChart.length) return null;
    if (!showYoYSeries) return null;

    const values: number[] = [];
    for (const p of dailyForChart) {
      const n = asFiniteNumber(p.yoy_pct);
      if (n != null) values.push(n);
    }

    if (values.length < 2) return null;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
    const sd = Math.sqrt(variance);

    return {
      mean,
      sd,
      p1: mean + sd,
      p2: mean + 2 * sd,
      m1: mean - sd,
      m2: mean - 2 * sd,
    };
  }, [showControlLines, dailyForChart, showYoYSeries]);

  const dailyForChartWithControl = useMemo(() => {
    const base = dailyForChart.map((p) => ({
      ...p,
      units: p.units != null ? Number(p.units.toFixed(2)) : p.units,
      prev_year_units:
        p.prev_year_units != null ? Number(p.prev_year_units.toFixed(2)) : p.prev_year_units,
      yoy_pct: p.yoy_pct != null ? Number(p.yoy_pct.toFixed(2)) : p.yoy_pct,
      mom_pct: p.mom_pct != null ? Number(p.mom_pct.toFixed(2)) : p.mom_pct,
    }));

    if (!showControlLines) return base as any;

    return base.map((p) => ({
      ...p,
      __mean_units: controlStatsLeft ? Number(controlStatsLeft.mean.toFixed(2)) : null,
      __p1_units: controlStatsLeft ? Number(controlStatsLeft.p1.toFixed(2)) : null,
      __p2_units: controlStatsLeft ? Number(controlStatsLeft.p2.toFixed(2)) : null,
      __m1_units: controlStatsLeft ? Number(controlStatsLeft.m1.toFixed(2)) : null,
      __m2_units: controlStatsLeft ? Number(controlStatsLeft.m2.toFixed(2)) : null,

      __mean_yoy: controlStatsYoY ? Number(controlStatsYoY.mean.toFixed(2)) : null,
      __p1_yoy: controlStatsYoY ? Number(controlStatsYoY.p1.toFixed(2)) : null,
      __p2_yoy: controlStatsYoY ? Number(controlStatsYoY.p2.toFixed(2)) : null,
      __m1_yoy: controlStatsYoY ? Number(controlStatsYoY.m1.toFixed(2)) : null,
      __m2_yoy: controlStatsYoY ? Number(controlStatsYoY.m2.toFixed(2)) : null,
    }));
  }, [dailyForChart, showControlLines, controlStatsLeft, controlStatsYoY]);

  const anyTotalsShown = showUnitsSeries || showPrevYearSeries || (showControlLines && !!controlStatsLeft);
  const anyPctShown = showYoYSeries || showMoMSeries || (showControlLines && !!controlStatsYoY);

  // NEW: Dynamic Y-axis domains (prevents flat/odd scales + improves readability)
  const leftAxisDomain = useMemo(() => {
    if (!dailyForChartWithControl?.length) return undefined;
    const vals: Array<number | null> = [];
    if (showUnitsSeries) vals.push(...(dailyForChartWithControl as any[]).map((d) => d.units));
    if (showPrevYearSeries) vals.push(...(dailyForChartWithControl as any[]).map((d) => d.prev_year_units));
    if (showControlLines) {
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__mean_units));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__p1_units));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__p2_units));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__m1_units));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__m2_units));
    }
    return computeDomain(vals, 0.05, 5);
  }, [dailyForChartWithControl, showUnitsSeries, showPrevYearSeries, showControlLines]);

  const rightAxisDomain = useMemo(() => {
    if (!dailyForChartWithControl?.length) return undefined;
    const vals: Array<number | null> = [];
    if (showYoYSeries) vals.push(...(dailyForChartWithControl as any[]).map((d) => d.yoy_pct));
    if (showMoMSeries) vals.push(...(dailyForChartWithControl as any[]).map((d) => d.mom_pct));
    if (showControlLines) {
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__mean_yoy));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__p1_yoy));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__p2_yoy));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__m1_yoy));
      vals.push(...(dailyForChartWithControl as any[]).map((d) => d.__m2_yoy));
    }
    return computeDomain(vals, 0.05, 1);
  }, [dailyForChartWithControl, showYoYSeries, showMoMSeries, showControlLines]);

  const monthly = useMemo(() => toMonthly(sortedDaily), [sortedDaily]);

  const monthlyForChart = useMemo(() => {
    if (!monthly.length) return [];
    return monthly.slice(Math.max(0, monthly.length - 24)).map((m) => ({
      month: m.month,
      total_units: m.total_gwh,
      yoy_pct: m.yoy_pct,
      mom_pct: m.mom_pct,
    }));
  }, [monthly]);

  const kpis = useMemo(() => computeKPIs(sortedDaily), [sortedDaily]);

  function upsertOne() {
    setMsg(null);
    setErrors([]);

    const iso = parseInputDate(date);
    if (!iso) {
      setErrors(["Please enter a valid date (DD-MM-YYYY)."]);
      return;
    }

    const v = Number(String(valueText).replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 0) {
      setErrors([`Please enter a valid non-negative number for ${seriesLabel.toLowerCase()}.`]);
      return;
    }

    setDataMap((prev) => {
      const next = new Map(prev);
      next.set(iso, v);
      return next;
    });

    setMsg(`Saved ${formatDDMMYYYY(iso)}: ${fmtNum(v)} units`);
    setValueText("");
  }

  function removeDate(isoDate: string) {
    setDataMap((prev) => {
      const next = new Map(prev);
      next.delete(isoDate);
      return next;
    });
  }

  function clearAll() {
    if (!confirm(`Clear all stored ${seriesLabel.toLowerCase()} data from this browser?`)) return;
    setDataMap(new Map());
    setMsg("Cleared all data.");
  }

  async function importCSV(file?: File) {
    setMsg(null);
    setErrors([]);
    if (!file) return;

    try {
      const text = await file.text();
      const { parsed, errors: errs } = csvParse(text, valueColumnKey);

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
    downloadCSV(
      `india_${type}_${new Date().toISOString().slice(0, 10)}.csv`,
      [header, ...lines].join("\n")
    );
  }

  function loadSample() {
    const { parsed } = csvParse(sampleCSV(valueColumnKey), valueColumnKey);
    setDataMap((prev) => mergeRecords(prev, parsed));
    setMsg("Loaded sample data.");
  }

  async function fetchLatestFromCEA() {
    setFetchStatus(null);

    const t = new Date();
    const dd = String(t.getDate()).padStart(2, "0");
    const mm = String(t.getMonth() + 1).padStart(2, "0");
    const yyyy = t.getFullYear();
    const ddmmyyyy = `${dd}-${mm}-${yyyy}`;

    setFetchStatus(`Fetching for ${ddmmyyyy}...`);

    try {
      const res = await fetch(`/api/cea/daily?date=${encodeURIComponent(ddmmyyyy)}&kind=${encodeURIComponent(type)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();

      const iso = parseInputDate(j?.date);
      const total = Number(j?.total_mu);
      if (!iso) throw new Error("Bad date");
      if (!Number.isFinite(total) || total < 0) throw new Error("Bad total_mu");

      setDataMap((prev) => {
        const next = new Map(prev);
        next.set(iso, total);
        return next;
      });

      setFetchStatus(`Fetched & saved ${j.date}: ${fmtNum(total)} units`);
    } catch {
      setFetchStatus("Auto-fetch failed (backend not deployed / source changed).");
    }
  }

  const hasData = sortedDaily.length > 0;

  // ----------------------
  // Monthly table dropdown data: Monthly / Weekly / Yearly(FY)
  // ----------------------

  const dailyLookup = useMemo(() => new Map(sortedDaily.map((d) => [d.date, d.value] as const)), [sortedDaily]);

  const weeklyRows = useMemo(() => {
    if (!sortedDaily.length) return [];

    // Sum per week + offsets set (to ensure comparable partial-week for WoW/YoY)
    const weekTotals = new Map<string, number>();
    const weekOffsets = new Map<string, Set<number>>();

    for (const d of sortedDaily) {
      const wk = startOfWeekISO(d.date);
      weekTotals.set(wk, (weekTotals.get(wk) || 0) + d.value);

      const off = Math.floor(
        (new Date(d.date + "T00:00:00Z").getTime() - new Date(wk + "T00:00:00Z").getTime()) / 86400000
      );
      if (!weekOffsets.has(wk)) weekOffsets.set(wk, new Set());
      weekOffsets.get(wk)!.add(off);
    }

    const sumWeekByOffsets = (weekStartIso: string, offsetsSet: Set<number>) => {
      let s = 0;
      let hasAny = false;
      for (const off of offsetsSet) {
        const key = isoPlusDays(weekStartIso, off);
        const v = dailyLookup.get(key);
        if (v != null) {
          s += v;
          hasAny = true;
        }
      }
      return hasAny ? s : null;
    };

    const weeks = Array.from(weekTotals.keys()).sort(sortISO);
    const lastWeeks = weeks.slice(Math.max(0, weeks.length - 104));

    return lastWeeks.map((wk) => {
      const curr = weekTotals.get(wk)!;
      const offs = weekOffsets.get(wk) || new Set<number>();

      const prevWeek = isoMinusDays(wk, 7);
      const prevComparable = sumWeekByOffsets(prevWeek, offs);
      const wow = prevComparable != null ? growthPct(curr, prevComparable) : null;

      const prevYearWeek = isoMinusDays(wk, 364);
      const prevYearComparable = sumWeekByOffsets(prevYearWeek, offs);
      const yoy = prevYearComparable != null ? growthPct(curr, prevYearComparable) : null;

      return {
        weekStart: wk,
        total: curr,
        wow_pct: wow,
        yoy_pct: yoy,
      };
    });
  }, [sortedDaily, dailyLookup]);

  const yearlyFYRows = useMemo(() => {
    if (!sortedDaily.length) return [];

    // group by FY
    const fyMap = new Map<string, { total: number; maxDate: string }>();
    for (const d of sortedDaily) {
      const fy = fyLabelFromIso(d.date);
      const rec = fyMap.get(fy) || { total: 0, maxDate: "0000-00-00" };
      rec.total += d.value;
      rec.maxDate = rec.maxDate < d.date ? d.date : rec.maxDate;
      fyMap.set(fy, rec);
    }

    const fys = Array.from(fyMap.keys()).sort((a, b) => {
      // FY25, FY26...
      const na = Number(a.slice(2));
      const nb = Number(b.slice(2));
      return na - nb;
    });

    // For current FY (incomplete), compare FY-to-date vs previous FY-to-date (same end date shifted -1y)
    const sumRangeInclusive = (startIso: string, endIso: string) => {
      if (startIso > endIso) return null;
      let s = 0;
      let hasAny = false;
      let cur = startIso;
      while (cur <= endIso) {
        const v = dailyLookup.get(cur);
        if (v != null) {
          s += v;
          hasAny = true;
        }
        cur = isoPlusDays(cur, 1);
      }
      return hasAny ? s : null;
    };

    const isoAddYears = (iso: string, deltaYears: number) => {
      const y = Number(iso.slice(0, 4));
      const m = Number(iso.slice(5, 7));
      const d = Number(iso.slice(8, 10));
      const tryDt = new Date(Date.UTC(y + deltaYears, m - 1, d));
      if (
        tryDt.getUTCFullYear() === y + deltaYears &&
        tryDt.getUTCMonth() === m - 1 &&
        tryDt.getUTCDate() === d
      ) return tryDt.toISOString().slice(0, 10);
      const lastDay = new Date(Date.UTC(y + deltaYears, m, 0));
      return lastDay.toISOString().slice(0, 10);
    };

    return fys.map((fy) => {
      const total = fyMap.get(fy)!.total;

      const prevFY = `FY${String(Number(fy.slice(2)) - 1).padStart(2, "0")}`;
      const prevFYRec = fyMap.get(prevFY);

      // Determine if FY is complete: FY ends Mar-31 of fy end year
      const fyEndYear = 2000 + Number(fy.slice(2));
      const fyEnd = `${fyEndYear}-03-31`;

      const maxDate = fyMap.get(fy)!.maxDate;
      const isComplete = maxDate >= fyEnd;

      let yoy: number | null = null;

      if (prevFYRec) {
        if (isComplete) {
          // Full FY vs full FY
          yoy = growthPct(total, prevFYRec.total);
        } else {
          // FY-to-date vs previous FY-to-date (same end date - 1y)
          const start = fyStartIsoFromFYLabel(fy);
          const prevStart = fyStartIsoFromFYLabel(prevFY);
          const prevEnd = isoAddYears(maxDate, -1);

          const currToDate = sumRangeInclusive(start, maxDate);
          const prevToDate = sumRangeInclusive(prevStart, prevEnd);

          yoy = currToDate != null && prevToDate != null ? growthPct(currToDate, prevToDate) : null;
        }
      }

      return { fy, total, yoy_pct: yoy, isComplete };
    });
  }, [sortedDaily, dailyLookup]);

  const monthlyRowsForTable = useMemo(() => {
    // already last 24 months in monthlyForChart
    return monthlyForChart;
  }, [monthlyForChart]);

  // ----------------------

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
                placeholder="e.g., 4200"
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
                  Supported: <span className="font-mono">date,{valueColumnKey}</span> (DD-MM-YYYY, number)
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
              <EmptyState onLoadSample={loadSample} />
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Stat
                  label="Latest day"
                  value={kpis.latest ? formatDDMMYYYY(kpis.latest.date) : "—"}
                  sub={kpis.latest ? <MutedSub text={`${fmtNum(kpis.latest.value)} units`} /> : null}
                />

                <Stat
                  label="Latest YoY (same day)"
                  value={fmtPct(kpis.latestYoY, 2)}
                  sub={<MutedSub text="vs same date last year (if available)" />}
                />

                <Stat
                  label="Current 7-Day Average Units"
                  value={kpis.avg7 != null ? `${fmtNum(kpis.avg7)} units` : "—"}
                  sub={<YoYSub value={kpis.avg7YoY} suffix="YoY" />}
                />

                <Stat
                  label="Current 30-Day Average Units"
                  value={kpis.avg30 != null ? `${fmtNum(kpis.avg30)} units` : "—"}
                  sub={<YoYSub value={kpis.avg30YoY} suffix="YoY" />}
                />

                <Stat
                  label="YTD Total Units (from 1 Apr)"
                  value={kpis.ytdTotal != null ? `${fmtNum(kpis.ytdTotal)} units` : "—"}
                  sub={<YoYSub value={kpis.ytdYoY} suffix="YoY" />}
                />

                <Stat
                  label="MTD Average Units"
                  value={kpis.mtdAvg != null ? `${fmtNum(kpis.mtdAvg)} units` : "—"}
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
                      <th className="px-3 py-2 text-xs font-semibold text-slate-600">{seriesLabel} (units)</th>
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
                          <td className="px-3 py-2 text-slate-700">{fmtNum(r.value)}</td>
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => removeDate(r.date)}
                              className="rounded-lg px-2 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        {/* ✅ Layout change: Daily card full width; Monthly totals card below it full width */}
        <div className="mt-6 grid grid-cols-1 gap-4">
          <Card
            title={`Daily ${seriesLabel.toLowerCase()}`}
            right={
              hasData ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500">Range</span>
                  <select
                    value={rangeDays}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setRangeDays(v);
                      if (sortedDaily.length) {
                        const lastIso = sortedDaily[sortedDaily.length - 1].date;
                        setToIso(lastIso);
                        setFromIso(isoMinusDays(lastIso, clamp(v, 7, 3650)));
                      }
                    }}
                    className="rounded-xl border border-slate-200 bg-white px-2 py-1 text-sm text-slate-700"
                  >
                    <option value={60}>Last 60 days</option>
                    <option value={120}>Last 120 days</option>
                    <option value={365}>Last 12 months</option>
                    <option value={730}>Last 24 months</option>
                    <option value={1825}>Last 5 years</option>
                    <option value={3650}>Last 10 years</option>
                  </select>
                </div>
              ) : null
            }
          >
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the daily chart.</div>
            ) : (
              <>
                {/* Controls */}
                <div className="mb-3 rounded-2xl bg-slate-50 p-2 ring-1 ring-slate-200">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
                    <div className="flex-1">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                          <div className="text-xs font-medium text-slate-600">From</div>
                          <input
                            type="date"
                            value={fromIso}
                            onChange={(e) => setFromIso(e.target.value)}
                            className="mt-1 w-full min-w-[180px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums"
                          />
                          {/* ✅ Full visible DD/MM/YY */}
                          <div className="mt-1 text-[12px] font-medium text-slate-600 tabular-nums">
                            {fromIso ? formatDDMMYY(fromIso) : ""}
                          </div>
                        </div>

                        <div>
                          <div className="text-xs font-medium text-slate-600">To</div>
                          <input
                            type="date"
                            value={toIso}
                            onChange={(e) => setToIso(e.target.value)}
                            className="mt-1 w-full min-w-[180px] rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-slate-300 tabular-nums"
                          />
                          {/* ✅ Full visible DD/MM/YY */}
                          <div className="mt-1 text-[12px] font-medium text-slate-600 tabular-nums">
                            {toIso ? formatDDMMYY(toIso) : ""}
                          </div>
                        </div>
                      </div>

                      <div className="mt-3">
                        <div className="text-xs font-medium text-slate-600">View as</div>
                        <select
                          value={aggFreq}
                          onChange={(e) => setAggFreq(e.target.value as any)}
                          className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700"
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly (sum)</option>
                          <option value="monthly">Monthly (sum)</option>
                          <option value="rolling30">Last 30 Days Rolling Sum (YoY Growth)</option>
                        </select>
                      </div>
                    </div>

                    <div className="lg:w-[360px] lg:shrink-0">
                      <div className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-slate-700">Series toggles</div>
                          <label className="flex items-center gap-2 text-[12px] text-slate-700">
                            <input
                              type="checkbox"
                              checked={showControlLines}
                              onChange={(e) => setShowControlLines(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Show Control Lines</span>
                          </label>
                        </div>

                        <div className="mt-2 grid grid-cols-2 gap-2 text-[12px] text-slate-700">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showUnitsSeries}
                              onChange={(e) => setShowUnitsSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Total Current</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showPrevYearSeries}
                              onChange={(e) => setShowPrevYearSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">Total (previous year)</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showYoYSeries}
                              onChange={(e) => setShowYoYSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">YoY %</span>
                          </label>

                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={showMoMSeries}
                              onChange={(e) => setShowMoMSeries(e.target.checked)}
                              className="h-4 w-4 rounded border-slate-300"
                            />
                            <span className="font-medium">{aggFreq === "weekly" ? "WoW %" : "MoM %"}</span>
                          </label>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(false);
                              setShowPrevYearSeries(false);
                              setShowMoMSeries(false);
                              setShowYoYSeries(true);
                            }}
                            className="rounded-lg bg-slate-900 px-2 py-1 text-[12px] font-semibold text-white hover:bg-slate-800"
                          >
                            YoY% only
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setShowUnitsSeries(true);
                              setShowPrevYearSeries(true);
                              setShowMoMSeries(false);
                              setShowYoYSeries(false);
                            }}
                            className="rounded-lg bg-white px-2 py-1 text-[12px] font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
                          >
                            Totals only
                          </button>
                        </div>
                      </div>

                      <div className="mt-2 text-[11px] text-slate-500">
                        Weekly/Monthly uses the same day-window for YoY and prior-period % (prevents partial-period distortion).
                      </div>
                    </div>
                  </div>
                </div>

                {/* ✅ Taller chart + extra margins to avoid axis clipping */}
                <div className="h-[380px] sm:h-[460px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart
                      data={dailyForChartWithControl}
                      margin={{ top: 12, right: 42, bottom: 12, left: 42 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="label" tick={{ fontSize: 12 }} minTickGap={24} />

                      {anyTotalsShown ? (
                        <YAxis
                          yAxisId="left"
                          width={88}
                          tickMargin={10}
                          domain={leftAxisDomain ?? ["auto", "auto"]}
                          padding={{ top: 10, bottom: 10 }}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => fmtNum(asFiniteNumber(v) ?? null, 2)}
                        />
                      ) : null}

                      {anyPctShown ? (
                        <YAxis
                          yAxisId="right"
                          orientation="right"
                          width={84}
                          tickMargin={10}
                          domain={rightAxisDomain ?? ["auto", "auto"]}
                          padding={{ top: 10, bottom: 10 }}
                          tick={{ fontSize: 12 }}
                          tickFormatter={(v) => fmtPct(asFiniteNumber(v) ?? null, 2)}
                        />
                      ) : null}

                      <Tooltip
                        wrapperStyle={{ outline: "none" }}
                        formatter={(v: any, name: any, item: any) => {
                          const key = (item && (item.dataKey as string)) || (name as string);
                          const num = asFiniteNumber(v);

                          if (key === "units") return [`${fmtNum(num ?? null, 2)} units`, "Total Current"];
                          if (key === "prev_year_units") return [`${fmtNum(num ?? null, 2)} units`, "Total (previous year)"];
                          if (key === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY %"];
                          if (key === "mom_pct") return [fmtPct(num ?? null, 2), aggFreq === "weekly" ? "WoW %" : "MoM %"];

                          if (key === "__mean_units") return [`${fmtNum(num ?? null, 2)} units`, "Mean"];
                          if (key === "__p1_units") return [`${fmtNum(num ?? null, 2)} units`, "+1σ"];
                          if (key === "__p2_units") return [`${fmtNum(num ?? null, 2)} units`, "+2σ"];
                          if (key === "__m1_units") return [`${fmtNum(num ?? null, 2)} units`, "-1σ"];
                          if (key === "__m2_units") return [`${fmtNum(num ?? null, 2)} units`, "-2σ"];

                          if (key === "__mean_yoy") return [fmtPct(num ?? null, 2), "Mean (YoY%)"];
                          if (key === "__p1_yoy") return [fmtPct(num ?? null, 2), "+1σ (YoY%)"];
                          if (key === "__p2_yoy") return [fmtPct(num ?? null, 2), "+2σ (YoY%)"];
                          if (key === "__m1_yoy") return [fmtPct(num ?? null, 2), "-1σ (YoY%)"];
                          if (key === "__m2_yoy") return [fmtPct(num ?? null, 2), "-2σ (YoY%)"];

                          if (num != null) return [fmtNum(num, 2), String(name)];
                          return [v, String(name)];
                        }}
                        labelFormatter={(l: any) =>
                          `${aggFreq === "daily" ? "Date" : aggFreq === "weekly" ? "Week" : aggFreq === "monthly" ? "Month" : "Date"}: ${l}`
                        }
                      />
                      <Legend />

                      {showUnitsSeries ? (
                        <Line yAxisId="left" type="monotone" dataKey="units" name="Total Current" dot={false} strokeWidth={2} stroke="#dc2626" />
                      ) : null}

                      {showPrevYearSeries ? (
                        <Line yAxisId="left" type="monotone" dataKey="prev_year_units" name="Total (previous year)" dot={false} strokeWidth={2} stroke="#6b7280" connectNulls />
                      ) : null}

                      {showYoYSeries ? (
                        <Line yAxisId="right" type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" connectNulls />
                      ) : null}

                      {showMoMSeries ? (
                        <Line yAxisId="right" type="monotone" dataKey="mom_pct" name={aggFreq === "weekly" ? "WoW %" : "MoM %"} dot={false} strokeWidth={2} stroke="#dc2626" connectNulls />
                      ) : null}

                      {showControlLines && controlStatsLeft ? (
                        <>
                          <Line yAxisId="left" type="monotone" dataKey="__mean_units" name="Mean" dot={false} strokeWidth={2} stroke="#000000" connectNulls />
                          <Line yAxisId="left" type="monotone" dataKey="__p1_units" name="+1σ" dot={false} strokeWidth={2} stroke="#2563eb" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="left" type="monotone" dataKey="__p2_units" name="+2σ" dot={false} strokeWidth={2} stroke="#4f46e5" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="left" type="monotone" dataKey="__m1_units" name="-1σ" dot={false} strokeWidth={2} stroke="#f97316" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="left" type="monotone" dataKey="__m2_units" name="-2σ" dot={false} strokeWidth={2} stroke="#eab308" strokeDasharray="6 4" connectNulls />
                        </>
                      ) : null}

                      {showControlLines && controlStatsYoY ? (
                        <>
                          <Line yAxisId="right" type="monotone" dataKey="__mean_yoy" name="Mean (YoY%)" dot={false} strokeWidth={2} stroke="#000000" connectNulls />
                          <Line yAxisId="right" type="monotone" dataKey="__p1_yoy" name="+1σ (YoY%)" dot={false} strokeWidth={2} stroke="#2563eb" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="right" type="monotone" dataKey="__p2_yoy" name="+2σ (YoY%)" dot={false} strokeWidth={2} stroke="#4f46e5" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="right" type="monotone" dataKey="__m1_yoy" name="-1σ (YoY%)" dot={false} strokeWidth={2} stroke="#f97316" strokeDasharray="6 4" connectNulls />
                          <Line yAxisId="right" type="monotone" dataKey="__m2_yoy" name="-2σ (YoY%)" dot={false} strokeWidth={2} stroke="#eab308" strokeDasharray="6 4" connectNulls />
                        </>
                      ) : null}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Card>

          <Card title="Monthly totals + growth">
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see monthly totals and growth.</div>
            ) : (
              <div className="space-y-4">
                <div className="h-[280px] sm:h-[320px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtNum(asFiniteNumber(v) ?? null, 2)} />
                      <Tooltip
                        formatter={(v: any, n: any) => {
                          const num = asFiniteNumber(v);
                          if (n === "total_units") return [`${fmtNum(num ?? null, 2)} units`, "Monthly total"];
                          if (n === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null, 2), "MoM"];
                          return [v, n];
                        }}
                      />
                      <Legend />
                      <Bar dataKey="total_units" name="Monthly total (units)" fill="#dc2626" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>

                <div className="h-[260px] sm:h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={monthlyForChart} margin={{ top: 10, right: 18, bottom: 10, left: 12 }}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="month" tick={{ fontSize: 12 }} minTickGap={18} />
                      <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => fmtPct(asFiniteNumber(v) ?? null, 2)} />
                      <Tooltip
                        formatter={(v: any, n: any) => {
                          const num = asFiniteNumber(v);
                          if (n === "yoy_pct") return [fmtPct(num ?? null, 2), "YoY"];
                          if (n === "mom_pct") return [fmtPct(num ?? null, 2), "MoM"];
                          return [v, n];
                        }}
                      />
                      <Legend />
                      <Line type="monotone" dataKey="yoy_pct" name="YoY %" dot={false} strokeWidth={2} stroke="#16a34a" />
                      <Line type="monotone" dataKey="mom_pct" name="MoM %" dot={false} strokeWidth={2} stroke="#dc2626" />
                    </LineChart>
                  </ResponsiveContainer>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200">
                  <div className="text-xs font-semibold text-slate-700">How growth is calculated</div>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
                    <li>
                      <span className="font-medium">MoM%</span> compares the same day-range (e.g., 1st–15th vs 1st–15th of
                      prior month if current month is incomplete).
                    </li>
                    <li>
                      <span className="font-medium">YoY%</span> compares the same day-range (e.g., 1st–15th vs 1st–15th last
                      year if current month is incomplete).
                    </li>
                  </ul>
                </div>
              </div>
            )}
          </Card>
        </div>

        {/* Monthly table with dropdown */}
        <div className="mt-6">
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
            {!hasData ? (
              <div className="text-sm text-slate-600">Add data to see the table.</div>
            ) : (
              <div className="overflow-auto rounded-xl ring-1 ring-slate-200">
                {tablePeriod === "monthly" ? (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Month</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Total (units)</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">MoM%</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlyRowsForTable
                        .slice()
                        .reverse()
                        .map((m) => (
                          <tr key={m.month} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">{m.month}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtNum(m.total_units, 2)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(m.mom_pct, 2)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(m.yoy_pct, 2)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : tablePeriod === "weekly" ? (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Week</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Total (units)</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">WoW%</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {weeklyRows
                        .slice()
                        .reverse()
                        .map((w) => (
                          <tr key={w.weekStart} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">
                              Week starting {formatDDMMYY(w.weekStart)}
                            </td>
                            <td className="px-3 py-2 text-slate-700">{fmtNum(w.total, 2)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(w.wow_pct, 2)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(w.yoy_pct, 2)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                ) : (
                  <table className="w-full border-collapse bg-white text-left text-sm">
                    <thead className="sticky top-0 bg-slate-50">
                      <tr>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">FY</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">Total (units)</th>
                        <th className="px-3 py-2 text-xs font-semibold text-slate-600">YoY%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {yearlyFYRows
                        .slice()
                        .reverse()
                        .map((r) => (
                          <tr key={r.fy} className="border-t border-slate-100">
                            <td className="px-3 py-2 font-medium text-slate-900">{r.fy}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtNum(r.total, 2)}</td>
                            <td className="px-3 py-2 text-slate-700">{fmtPct(r.yoy_pct, 2)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="mt-6 text-xs text-slate-500">
          Tip: Auto-fetch needs a backend proxy because sources often block browser-to-site requests (CORS).
        </div>
      </div>
    </div>
  );
}
