import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import Papa from "papaparse";
import { cloudConfigured, getCurrentSession, loadCloudData, saveCloudData, signIn, signOut, signUp } from "./cloud.js";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  Cell,
  ReferenceLine,
} from "recharts";
import {
  Plus,
  Upload,
  Pencil,
  Trash2,
  X,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  ListTree,
  CalendarDays,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
  Flame,
  Target,
  Percent,
  Download,
  Tag as TagIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const POINT_VALUE = { NQ: 20, MNQ: 2, ES: 50, MES: 5 };
const INSTRUMENTS = ["NQ", "ES", "MES", "MNQ"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const uid = () => `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

const DEFAULT_TAGS = [
  { id: "tag_calm", emoji: "😌", label: "Calm" },
  { id: "tag_fear", emoji: "😨", label: "Fear" },
  { id: "tag_greed", emoji: "🤑", label: "Greed" },
  { id: "tag_fomo", emoji: "🔥", label: "FOMO" },
  { id: "tag_disciplined", emoji: "🎯", label: "Disciplined" },
  { id: "tag_frustrated", emoji: "😤", label: "Frustrated" },
  { id: "tag_hesitant", emoji: "🤔", label: "Hesitant" },
  { id: "tag_revenge", emoji: "⚔️", label: "Revenge trade" },
];

function parseDate(dateStr) {
  // dateStr expected "YYYY-MM-DD"
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function dayOfWeek(dateStr) {
  if (!dateStr) return "";
  return WEEKDAYS[parseDate(dateStr).getDay()];
}

function fmtMoney(n, opts = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString(undefined, {
    minimumFractionDigits: opts.decimals ?? 2,
    maximumFractionDigits: opts.decimals ?? 2,
  })}`;
}

function fmtNum(n, decimals = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDateShort(dateStr) {
  if (!dateStr) return "";
  const d = parseDate(dateStr);
  return `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
}

function computePnL(trade) {
  const pv = POINT_VALUE[trade.instrument] ?? 0;
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  const contracts = Number(trade.contracts);
  if (!isFinite(entry) || !isFinite(exit) || !isFinite(contracts)) return 0;
  const diff = trade.direction === "Short" ? entry - exit : exit - entry;
  return diff * contracts * pv;
}

function computeRPoints(trade) {
  // risk in points based on entry/SL
  const entry = Number(trade.entryPrice);
  const sl = Number(trade.slPrice);
  if (!isFinite(entry) || !isFinite(sl) || entry === sl) return null;
  return Math.abs(entry - sl);
}

function computeRealizedR(trade) {
  const risk = computeRPoints(trade);
  if (risk === null) return null;
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  const reward = trade.direction === "Short" ? entry - exit : exit - entry;
  return reward / risk;
}

function computePlannedR(trade) {
  const risk = computeRPoints(trade);
  const entry = Number(trade.entryPrice);
  const tp = Number(trade.tpPrice);
  if (risk === null || !isFinite(tp)) return null;
  return Math.abs(tp - entry) / risk;
}

function enrichTrade(trade) {
  const pnl = computePnL(trade);
  return {
    ...trade,
    pnl,
    realizedR: computeRealizedR(trade),
    plannedR: computePlannedR(trade),
    dow: dayOfWeek(trade.date),
  };
}

function csvHeaderKey(h) {
  return String(h || "").toLowerCase().replace(/[\s_]+/g, "");
}

function normalizeDirection(v) {
  const s = String(v || "").trim().toLowerCase();
  if (["long", "buy", "l", "b"].includes(s)) return "Long";
  if (["short", "sell", "s"].includes(s)) return "Short";
  return "Long";
}

function normalizeInstrument(v) {
  const s = String(v || "").trim().toUpperCase();
  return INSTRUMENTS.includes(s) ? s : "NQ";
}

const CSV_FIELD_MAP = {
  date: "date",
  tradedate: "date",
  instrument: "instrument",
  symbol: "instrument",
  direction: "direction",
  side: "direction",
  contracts: "contracts",
  qty: "contracts",
  quantity: "contracts",
  size: "contracts",
  entry: "entryPrice",
  entryprice: "entryPrice",
  exit: "exitPrice",
  exitprice: "exitPrice",
  tp: "tpPrice",
  tpprice: "tpPrice",
  takeprofit: "tpPrice",
  sl: "slPrice",
  slprice: "slPrice",
  stoploss: "slPrice",
  notes: "notes",
  comment: "notes",
  comments: "notes",
};

function rowToTrade(row) {
  const t = {
    id: uid(),
    date: "",
    instrument: "NQ",
    direction: "Long",
    contracts: 1,
    entryPrice: "",
    exitPrice: "",
    tpPrice: "",
    slPrice: "",
    notes: "",
  };
  Object.entries(row).forEach(([rawKey, rawVal]) => {
    const key = CSV_FIELD_MAP[csvHeaderKey(rawKey)];
    if (!key) return;
    if (key === "date") {
      const v = String(rawVal || "").trim();
      // try to coerce common formats to YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) t.date = v;
      else {
        const parsed = new Date(v);
        if (!isNaN(parsed.getTime())) {
          t.date = `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(
            parsed.getDate()
          ).padStart(2, "0")}`;
        }
      }
    } else if (key === "instrument") t.instrument = normalizeInstrument(rawVal);
    else if (key === "direction") t.direction = normalizeDirection(rawVal);
    else if (key === "contracts") t.contracts = Number(rawVal) || 1;
    else if (key === "notes") t.notes = String(rawVal || "");
    else t[key] = rawVal === "" || rawVal === undefined ? "" : Number(rawVal);
  });
  return t;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const STORAGE_KEY = "tape:trades";
const TAGS_STORAGE_KEY = "tape:tags";

function loadLocalTrades() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadLocalTags() {
  try {
    const raw = window.localStorage.getItem(TAGS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : DEFAULT_TAGS;
    return Array.isArray(parsed) && parsed.length ? parsed : DEFAULT_TAGS;
  } catch {
    return DEFAULT_TAGS;
  }
}

function persistLocalTrades(trades) {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades)); } catch {}
}

function persistLocalTags(tags) {
  try { window.localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(tags)); } catch {}
}

function mergeById(primary, secondary) {
  const map = new Map();
  [...primary, ...secondary].forEach((item) => {
    if (item?.id) map.set(item.id, item);
  });
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function PnLText({ value, decimals = 2, size = "inherit" }) {
  const cls = value > 0 ? "tj-pos" : value < 0 ? "tj-neg" : "tj-neu";
  return (
    <span className={cls} style={{ fontSize: size }}>
      {value > 0 ? "+" : ""}
      {fmtMoney(value, { decimals })}
    </span>
  );
}

function StatBlock({ label, value, sub }) {
  return (
    <div className="tj-stat">
      <div className="tj-stat-label">{label}</div>
      <div className="tj-stat-value">{value}</div>
      {sub ? <div className="tj-stat-sub">{sub}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trade Form (Add / Edit)
// ---------------------------------------------------------------------------

function ConfidenceDots({ value, onChange }) {
  return (
    <div className="tj-conf-dots">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          type="button"
          key={n}
          className={`tj-conf-dot ${value && n <= Number(value) ? "tj-conf-dot-filled" : ""}`}
          onClick={() => onChange(value === n ? "" : n)}
          aria-label={`${n} out of 5`}
        >
          {n}
        </button>
      ))}
      {value ? <span className="tj-conf-clear-label">{value}/5</span> : <span className="tj-conf-clear-label tj-neu">not set</span>}
    </div>
  );
}

function TradeForm({ initial, tagLibrary, onCreateTag, onDeleteTag, onSave, onCancel, onDelete }) {
  const [form, setForm] = useState(
    () =>
      initial || {
        id: uid(),
        date: new Date().toISOString().slice(0, 10),
        instrument: "NQ",
        direction: "Long",
        contracts: 1,
        entryPrice: "",
        exitPrice: "",
        tpPrice: "",
        slPrice: "",
        notes: "",
        tags: [],
        confidenceBefore: "",
        confidenceAfter: "",
      }
  );
  const [error, setError] = useState("");
  const [newTagOpen, setNewTagOpen] = useState(false);
  const [newTagEmoji, setNewTagEmoji] = useState("");
  const [newTagLabel, setNewTagLabel] = useState("");

  const toggleTag = (tagId) => {
    setForm((f) => {
      const cur = f.tags || [];
      const has = cur.includes(tagId);
      return { ...f, tags: has ? cur.filter((t) => t !== tagId) : [...cur, tagId] };
    });
  };

  const submitNewTag = () => {
    const label = newTagLabel.trim();
    if (!label) return;
    const emoji = newTagEmoji.trim() || "🏷️";
    const tag = { id: uid(), emoji, label };
    onCreateTag(tag);
    setForm((f) => ({ ...f, tags: [...(f.tags || []), tag.id] }));
    setNewTagEmoji("");
    setNewTagLabel("");
    setNewTagOpen(false);
  };

  const set = (k) => (e) => {
    const v = e && e.target ? e.target.value : e;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const previewPnl = useMemo(() => {
    if (!form.entryPrice || !form.exitPrice || !form.contracts) return null;
    return computePnL(form);
  }, [form.entryPrice, form.exitPrice, form.contracts, form.direction, form.instrument]);

  const submit = () => {
    if (!form.date) return setError("Pick a date.");
    if (!form.entryPrice || isNaN(Number(form.entryPrice))) return setError("Enter a valid entry price.");
    if (!form.exitPrice || isNaN(Number(form.exitPrice))) return setError("Enter a valid exit price.");
    if (!form.contracts || isNaN(Number(form.contracts)) || Number(form.contracts) <= 0)
      return setError("Enter a valid contract count.");
    setError("");
    onSave({
      ...form,
      contracts: Number(form.contracts),
      entryPrice: Number(form.entryPrice),
      exitPrice: Number(form.exitPrice),
      tpPrice: form.tpPrice === "" ? "" : Number(form.tpPrice),
      slPrice: form.slPrice === "" ? "" : Number(form.slPrice),
    });
  };

  return (
    <div className="tj-modal-backdrop" onMouseDown={onCancel}>
      <div className="tj-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tj-modal-head">
          <h3>{initial ? "Edit trade" : "Log a trade"}</h3>
          <button className="tj-icon-btn" onClick={onCancel} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <div className="tj-form-grid">
          <label className="tj-field">
            <span>Date</span>
            <input type="date" value={form.date} onChange={set("date")} />
          </label>

          <label className="tj-field">
            <span>Day of week</span>
            <input type="text" value={form.date ? dayOfWeek(form.date) : ""} readOnly disabled />
          </label>

          <label className="tj-field">
            <span>Instrument</span>
            <select value={form.instrument} onChange={set("instrument")}>
              {INSTRUMENTS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </label>

          <label className="tj-field">
            <span>Direction</span>
            <div className="tj-toggle-pair">
              <button
                type="button"
                className={`tj-toggle-btn ${form.direction === "Long" ? "tj-toggle-active-pos" : ""}`}
                onClick={() => setForm((f) => ({ ...f, direction: "Long" }))}
              >
                Long
              </button>
              <button
                type="button"
                className={`tj-toggle-btn ${form.direction === "Short" ? "tj-toggle-active-neg" : ""}`}
                onClick={() => setForm((f) => ({ ...f, direction: "Short" }))}
              >
                Short
              </button>
            </div>
          </label>

          <label className="tj-field">
            <span>Contracts</span>
            <input type="number" min="1" step="1" value={form.contracts} onChange={set("contracts")} />
          </label>

          <label className="tj-field">
            <span>Entry price</span>
            <input type="number" step="0.01" value={form.entryPrice} onChange={set("entryPrice")} placeholder="e.g. 19850.25" />
          </label>

          <label className="tj-field">
            <span>Exit price</span>
            <input type="number" step="0.01" value={form.exitPrice} onChange={set("exitPrice")} placeholder="e.g. 19875.00" />
          </label>

          <label className="tj-field">
            <span>Take-profit price</span>
            <input type="number" step="0.01" value={form.tpPrice} onChange={set("tpPrice")} placeholder="optional" />
          </label>

          <label className="tj-field">
            <span>Stop-loss price</span>
            <input type="number" step="0.01" value={form.slPrice} onChange={set("slPrice")} placeholder="optional" />
          </label>

          <label className="tj-field tj-field-wide">
            <span>Notes</span>
            <textarea rows={3} value={form.notes} onChange={set("notes")} placeholder="Setup, mistakes, mindset..." />
          </label>

          <div className="tj-field tj-field-wide">
            <span>Confidence before entry</span>
            <ConfidenceDots value={form.confidenceBefore} onChange={(v) => setForm((f) => ({ ...f, confidenceBefore: v }))} />
          </div>

          <div className="tj-field tj-field-wide">
            <span>Confidence after exit</span>
            <ConfidenceDots value={form.confidenceAfter} onChange={(v) => setForm((f) => ({ ...f, confidenceAfter: v }))} />
          </div>

          <div className="tj-field tj-field-wide">
            <span>Tags</span>
            <div className="tj-tag-picker">
              {tagLibrary.map((t) => {
                const active = (form.tags || []).includes(t.id);
                return (
                  <button
                    type="button"
                    key={t.id}
                    className={`tj-tag-chip ${active ? "tj-tag-chip-active" : ""}`}
                    onClick={() => toggleTag(t.id)}
                  >
                    <span>{t.emoji}</span>
                    {t.label}
                    <span
                      className="tj-tag-remove"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteTag(t.id);
                      }}
                      title="Remove tag from library"
                    >
                      <X size={11} />
                    </span>
                  </button>
                );
              })}

              {newTagOpen ? (
                <div className="tj-tag-new">
                  <input
                    className="tj-tag-new-emoji"
                    value={newTagEmoji}
                    onChange={(e) => setNewTagEmoji(e.target.value)}
                    placeholder="🙂"
                    maxLength={4}
                  />
                  <input
                    className="tj-tag-new-label"
                    value={newTagLabel}
                    onChange={(e) => setNewTagLabel(e.target.value)}
                    placeholder="Label"
                    onKeyDown={(e) => e.key === "Enter" && submitNewTag()}
                    autoFocus
                  />
                  <button type="button" className="tj-tag-new-add" onClick={submitNewTag}>
                    Add
                  </button>
                  <button type="button" className="tj-icon-btn" onClick={() => setNewTagOpen(false)}>
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <button type="button" className="tj-tag-chip tj-tag-chip-new" onClick={() => setNewTagOpen(true)}>
                  <Plus size={12} /> New tag
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="tj-form-preview">
          <span>Realized P&amp;L</span>
          {previewPnl === null ? <span className="tj-neu">—</span> : <PnLText value={previewPnl} />}
        </div>

        {error ? <div className="tj-form-error">{error}</div> : null}

        <div className="tj-modal-actions">
          {initial ? (
            <button className="tj-btn tj-btn-danger" onClick={() => onDelete(form.id)}>
              <Trash2 size={14} /> Delete
            </button>
          ) : (
            <span />
          )}
          <div style={{ display: "flex", gap: 10 }}>
            <button className="tj-btn" onClick={onCancel}>
              Cancel
            </button>
            <button className="tj-btn tj-btn-primary" onClick={submit}>
              {initial ? "Save changes" : "Add trade"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function Dashboard({ trades, tagLibrary }) {
  const stats = useMemo(() => {
    if (trades.length === 0) return null;
    const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : 1));
    let cum = 0;
    const equity = sorted.map((t) => {
      cum += t.pnl;
      return { date: t.date, label: fmtDateShort(t.date), cum };
    });
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = (wins.length / trades.length) * 100;
    const avgPnL = totalPnL / trades.length;
    const best = trades.reduce((m, t) => (t.pnl > m.pnl ? t : m), trades[0]);
    const worst = trades.reduce((m, t) => (t.pnl < m.pnl ? t : m), trades[0]);
    const rValues = trades.map((t) => t.realizedR).filter((r) => r !== null && isFinite(r));
    const avgR = rValues.length ? rValues.reduce((s, r) => s + r, 0) / rValues.length : null;
    const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
    const avgWin = wins.length ? grossWin / wins.length : 0;
    const avgLoss = losses.length ? grossLoss / losses.length : 0;

    // streak (most recent first)
    const byDateDesc = [...trades].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0));
    let streak = 0;
    if (byDateDesc.length) {
      const dir = byDateDesc[0].pnl >= 0 ? 1 : -1;
      for (const t of byDateDesc) {
        const d = t.pnl >= 0 ? 1 : -1;
        if (d === dir) streak += 1;
        else break;
      }
      streak *= dir;
    }

    // day of week aggregation
    const dowMap = {};
    WEEKDAYS.forEach((d) => (dowMap[d] = { pnl: 0, count: 0, wins: 0 }));
    trades.forEach((t) => {
      dowMap[t.dow].pnl += t.pnl;
      dowMap[t.dow].count += 1;
      if (t.pnl > 0) dowMap[t.dow].wins += 1;
    });
    const dowData = [1, 2, 3, 4, 5].map((i) => ({
      day: WEEKDAYS[i].slice(0, 3),
      pnl: dowMap[WEEKDAYS[i]].pnl,
      count: dowMap[WEEKDAYS[i]].count,
    }));

    // instrument breakdown
    const instMap = {};
    INSTRUMENTS.forEach((i) => (instMap[i] = { pnl: 0, count: 0, wins: 0 }));
    trades.forEach((t) => {
      instMap[t.instrument].pnl += t.pnl;
      instMap[t.instrument].count += 1;
      if (t.pnl > 0) instMap[t.instrument].wins += 1;
    });

    // tag performance
    const tagMap = {};
    trades.forEach((t) => {
      (t.tags || []).forEach((tid) => {
        if (!tagMap[tid]) tagMap[tid] = { pnl: 0, count: 0, wins: 0 };
        tagMap[tid].pnl += t.pnl;
        tagMap[tid].count += 1;
        if (t.pnl > 0) tagMap[tid].wins += 1;
      });
    });
    const tagRows = tagLibrary
      .map((tag) => ({ tag, ...tagMap[tag.id] }))
      .filter((r) => r.count)
      .sort((a, b) => b.count - a.count);

    // confidence averages
    const beforeVals = trades.map((t) => Number(t.confidenceBefore)).filter((v) => v >= 1 && v <= 5);
    const afterVals = trades.map((t) => Number(t.confidenceAfter)).filter((v) => v >= 1 && v <= 5);
    const avgConfBefore = beforeVals.length ? beforeVals.reduce((s, v) => s + v, 0) / beforeVals.length : null;
    const avgConfAfter = afterVals.length ? afterVals.reduce((s, v) => s + v, 0) / afterVals.length : null;

    return {
      equity,
      totalPnL,
      winRate,
      avgPnL,
      best,
      worst,
      avgR,
      profitFactor,
      avgWin,
      avgLoss,
      streak,
      dowData,
      instMap,
      tagRows,
      avgConfBefore,
      avgConfAfter,
      count: trades.length,
    };
  }, [trades, tagLibrary]);

  if (!stats) {
    return (
      <div className="tj-empty">
        <h2>No trades logged yet</h2>
        <p>Add your first trade or import a CSV to see your performance take shape here.</p>
      </div>
    );
  }

  const equityPositive = stats.totalPnL >= 0;

  return (
    <div>
      <div className="tj-stat-row">
        <StatBlock label="Total P&L" value={<PnLText value={stats.totalPnL} decimals={0} />} sub={`${stats.count} trades`} />
        <StatBlock
          label="Win rate"
          value={<span className={stats.winRate >= 50 ? "tj-pos" : "tj-neg"}>{fmtNum(stats.winRate, 1)}%</span>}
        />
        <StatBlock label="Avg P&L / trade" value={<PnLText value={stats.avgPnL} decimals={0} />} />
        <StatBlock
          label="Avg R multiple"
          value={
            stats.avgR === null ? (
              "—"
            ) : (
              <span className={stats.avgR >= 0 ? "tj-pos" : "tj-neg"}>
                {stats.avgR >= 0 ? "+" : ""}
                {fmtNum(stats.avgR, 2)}R
              </span>
            )
          }
        />
        <StatBlock
          label="Profit factor"
          value={stats.profitFactor === Infinity ? "∞" : fmtNum(stats.profitFactor, 2)}
        />
        <StatBlock label="Best trade" value={<PnLText value={stats.best.pnl} decimals={0} />} sub={fmtDateShort(stats.best.date)} />
        <StatBlock label="Worst trade" value={<PnLText value={stats.worst.pnl} decimals={0} />} sub={fmtDateShort(stats.worst.date)} />
        <StatBlock
          label="Current streak"
          value={
            stats.streak === 0 ? (
              "—"
            ) : (
              <span className={stats.streak > 0 ? "tj-pos" : "tj-neg"}>
                {Math.abs(stats.streak)} {stats.streak > 0 ? "win" : "loss"}{Math.abs(stats.streak) > 1 ? "es" : ""}
              </span>
            )
          }
        />
        <StatBlock label="Avg confidence before" value={stats.avgConfBefore === null ? "—" : `${fmtNum(stats.avgConfBefore, 1)}/5`} />
        <StatBlock label="Avg confidence after" value={stats.avgConfAfter === null ? "—" : `${fmtNum(stats.avgConfAfter, 1)}/5`} />
      </div>

      <div className="tj-panel">
        <div className="tj-panel-head">
          <h3>Equity curve</h3>
          <span className="tj-panel-sub">Cumulative P&L over time</span>
        </div>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={stats.equity} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="tjEquityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={equityPositive ? "#4FAE7C" : "#C1584A"} stopOpacity={0.35} />
                <stop offset="100%" stopColor={equityPositive ? "#4FAE7C" : "#C1584A"} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#26302B" strokeDasharray="2 4" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: "#8B968F", fontSize: 11 }} axisLine={{ stroke: "#2A342E" }} tickLine={false} minTickGap={30} />
            <YAxis
              tick={{ fill: "#8B968F", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v.toLocaleString()}`}
              width={70}
            />
            <ReferenceLine y={0} stroke="#3A453E" />
            <Tooltip
              contentStyle={{ background: "#151D18", border: "1px solid #2A342E", borderRadius: 3, fontFamily: "var(--font-mono)" }}
              labelStyle={{ color: "#8B968F" }}
              formatter={(v) => [fmtMoney(v, { decimals: 0 }), "Cumulative"]}
            />
            <Area type="monotone" dataKey="cum" stroke={equityPositive ? "#4FAE7C" : "#C1584A"} strokeWidth={2} fill="url(#tjEquityFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="tj-two-col">
        <div className="tj-panel">
          <div className="tj-panel-head">
            <h3>P&L by day of week</h3>
            <span className="tj-panel-sub">Where your edge shows up</span>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={stats.dowData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#26302B" strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="day" tick={{ fill: "#8B968F", fontSize: 11 }} axisLine={{ stroke: "#2A342E" }} tickLine={false} />
              <YAxis tick={{ fill: "#8B968F", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} width={55} />
              <ReferenceLine y={0} stroke="#3A453E" />
              <Tooltip
                contentStyle={{ background: "#151D18", border: "1px solid #2A342E", borderRadius: 3, fontFamily: "var(--font-mono)" }}
                labelStyle={{ color: "#8B968F" }}
                formatter={(v, n, p) => [fmtMoney(v, { decimals: 0 }), `${p.payload.count} trades`]}
              />
              <Bar dataKey="pnl" radius={[2, 2, 0, 0]}>
                {stats.dowData.map((d, i) => (
                  <Cell key={i} fill={d.pnl >= 0 ? "#4FAE7C" : "#C1584A"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="tj-panel">
          <div className="tj-panel-head">
            <h3>By instrument</h3>
            <span className="tj-panel-sub">Performance breakdown</span>
          </div>
          <div className="tj-inst-list">
            {INSTRUMENTS.filter((i) => stats.instMap[i].count > 0).map((i) => {
              const d = stats.instMap[i];
              const wr = (d.wins / d.count) * 100;
              return (
                <div className="tj-inst-row" key={i}>
                  <span className="tj-inst-name">{i}</span>
                  <span className="tj-inst-count">{d.count} trades</span>
                  <span className="tj-inst-wr">{fmtNum(wr, 0)}% win</span>
                  <PnLText value={d.pnl} decimals={0} />
                </div>
              );
            })}
            {INSTRUMENTS.every((i) => stats.instMap[i].count === 0) && <div className="tj-panel-sub">No data yet.</div>}
          </div>
        </div>
      </div>

      {stats.tagRows.length > 0 && (
        <div className="tj-panel">
          <div className="tj-panel-head">
            <h3>Performance by tag</h3>
            <span className="tj-panel-sub">How your state of mind maps to results</span>
          </div>
          <div className="tj-inst-list">
            {stats.tagRows.map((r) => {
              const wr = (r.wins / r.count) * 100;
              return (
                <div className="tj-inst-row tj-tag-perf-row" key={r.tag.id}>
                  <span className="tj-inst-name">
                    {r.tag.emoji} {r.tag.label}
                  </span>
                  <span className="tj-inst-count">{r.count} trades</span>
                  <span className="tj-inst-wr">{fmtNum(wr, 0)}% win</span>
                  <PnLText value={r.pnl} decimals={0} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Trades tab
// ---------------------------------------------------------------------------

function TradesTab({ trades, tagLibrary, onEdit }) {
  const tagById = useMemo(() => {
    const m = {};
    tagLibrary.forEach((t) => (m[t.id] = t));
    return m;
  }, [tagLibrary]);
  const [filterInst, setFilterInst] = useState("all");
  const [filterResult, setFilterResult] = useState("all");

  const filtered = useMemo(() => {
    let list = [...trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    if (filterInst !== "all") list = list.filter((t) => t.instrument === filterInst);
    if (filterResult === "wins") list = list.filter((t) => t.pnl > 0);
    if (filterResult === "losses") list = list.filter((t) => t.pnl < 0);
    return list;
  }, [trades, filterInst, filterResult]);

  return (
    <div>
      <div className="tj-filters">
        <select value={filterInst} onChange={(e) => setFilterInst(e.target.value)}>
          <option value="all">All instruments</option>
          {INSTRUMENTS.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <select value={filterResult} onChange={(e) => setFilterResult(e.target.value)}>
          <option value="all">All results</option>
          <option value="wins">Wins only</option>
          <option value="losses">Losses only</option>
        </select>
        <span className="tj-filters-count">{filtered.length} trades</span>
      </div>

      {filtered.length === 0 ? (
        <div className="tj-empty">
          <h2>No trades match</h2>
          <p>Try clearing your filters, or log a new trade.</p>
        </div>
      ) : (
        <div className="tj-table-wrap">
          <table className="tj-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Day</th>
                <th>Inst</th>
                <th>Dir</th>
                <th>Ctr</th>
                <th>Entry</th>
                <th>Exit</th>
                <th>R</th>
                <th>P&amp;L</th>
                <th>Tags</th>
                <th>Conf.</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} onClick={() => onEdit(t)} className="tj-table-row">
                  <td>{fmtDateShort(t.date)}</td>
                  <td className="tj-table-dim">{t.dow.slice(0, 3)}</td>
                  <td>{t.instrument}</td>
                  <td className={t.direction === "Long" ? "tj-pos" : "tj-neg"}>
                    {t.direction === "Long" ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                  </td>
                  <td>{t.contracts}</td>
                  <td className="tj-table-dim">{fmtNum(t.entryPrice, 2)}</td>
                  <td className="tj-table-dim">{fmtNum(t.exitPrice, 2)}</td>
                  <td className="tj-table-dim">{t.realizedR === null ? "—" : `${t.realizedR >= 0 ? "+" : ""}${fmtNum(t.realizedR, 2)}R`}</td>
                  <td>
                    <PnLText value={t.pnl} decimals={0} />
                  </td>
                  <td>
                    <div className="tj-table-tags">
                      {(t.tags || []).map((tid) => (tagById[tid] ? <span key={tid} title={tagById[tid].label}>{tagById[tid].emoji}</span> : null))}
                    </div>
                  </td>
                  <td className="tj-table-dim">
                    {t.confidenceBefore || t.confidenceAfter
                      ? `${t.confidenceBefore || "–"}→${t.confidenceAfter || "–"}`
                      : "—"}
                  </td>
                  <td>
                    <Pencil size={14} className="tj-edit-icon" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calendar tab
// ---------------------------------------------------------------------------

function dayColor(pnl, hasTrades) {
  if (!hasTrades) return "tj-cal-empty";
  if (pnl > 0) return "tj-cal-win";
  if (pnl < 0) return "tj-cal-loss";
  return "tj-cal-flat";
}

function CalendarTab({ trades }) {
  const [mode, setMode] = useState("day"); // day | week | month
  const [cursor, setCursor] = useState(() => new Date());

  const byDate = useMemo(() => {
    const m = {};
    trades.forEach((t) => {
      if (!m[t.date]) m[t.date] = { pnl: 0, count: 0 };
      m[t.date].pnl += t.pnl;
      m[t.date].count += 1;
    });
    return m;
  }, [trades]);

  const byMonth = useMemo(() => {
    const m = {};
    trades.forEach((t) => {
      const key = t.date.slice(0, 7); // YYYY-MM
      if (!m[key]) m[key] = { pnl: 0, count: 0 };
      m[key].pnl += t.pnl;
      m[key].count += 1;
    });
    return m;
  }, [trades]);

  const year = cursor.getFullYear();
  const month = cursor.getMonth();

  const goPrev = () => {
    if (mode === "month") setCursor(new Date(year - 1, 0, 1));
    else setCursor(new Date(year, month - 1, 1));
  };
  const goNext = () => {
    if (mode === "month") setCursor(new Date(year + 1, 0, 1));
    else setCursor(new Date(year, month + 1, 1));
  };

  // ---- DAY VIEW (classic month grid) ----
  const dayGrid = useMemo(() => {
    const first = new Date(year, month, 1);
    const startOffset = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      cells.push({ d, dateStr });
    }
    return cells;
  }, [year, month]);

  // ---- WEEK VIEW (rows of weeks within the month) ----
  const weekRows = useMemo(() => {
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const rows = [];
    let currentRow = [];
    // pad leading
    for (let i = 0; i < first.getDay(); i++) currentRow.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      currentRow.push({ d, dateStr });
      if (currentRow.length === 7) {
        rows.push(currentRow);
        currentRow = [];
      }
    }
    if (currentRow.length) {
      while (currentRow.length < 7) currentRow.push(null);
      rows.push(currentRow);
    }
    return rows.map((row) => {
      const dates = row.filter(Boolean).map((c) => c.dateStr);
      const pnl = dates.reduce((s, ds) => s + (byDate[ds]?.pnl || 0), 0);
      const count = dates.reduce((s, ds) => s + (byDate[ds]?.count || 0), 0);
      const label =
        row.find(Boolean) && row.filter(Boolean).length
          ? `${fmtDateShort(row.find(Boolean).dateStr)} – ${fmtDateShort([...row].reverse().find(Boolean).dateStr)}`
          : "";
      return { row, pnl, count, label };
    });
  }, [year, month, byDate]);

  // ---- MONTH VIEW (year grid of 12 months) ----
  const monthCells = useMemo(() => {
    return MONTH_NAMES.map((name, i) => {
      const key = `${year}-${String(i + 1).padStart(2, "0")}`;
      const data = byMonth[key];
      return { name, key, pnl: data?.pnl || 0, count: data?.count || 0 };
    });
  }, [year, byMonth]);

  const monthTotal = useMemo(() => {
    let pnl = 0,
      count = 0;
    dayGrid.forEach((c) => {
      if (!c) return;
      const d = byDate[c.dateStr];
      if (d) {
        pnl += d.pnl;
        count += d.count;
      }
    });
    return { pnl, count };
  }, [dayGrid, byDate]);

  return (
    <div>
      <div className="tj-cal-controls">
        <div className="tj-tab-switch">
          <button className={mode === "day" ? "tj-tab-active" : ""} onClick={() => setMode("day")}>
            Day
          </button>
          <button className={mode === "week" ? "tj-tab-active" : ""} onClick={() => setMode("week")}>
            Week
          </button>
          <button className={mode === "month" ? "tj-tab-active" : ""} onClick={() => setMode("month")}>
            Month
          </button>
        </div>
        <div className="tj-cal-nav">
          <button className="tj-icon-btn" onClick={goPrev} aria-label="Previous">
            <ChevronLeft size={16} />
          </button>
          <span className="tj-cal-title">{mode === "month" ? year : `${MONTH_NAMES[month]} ${year}`}</span>
          <button className="tj-icon-btn" onClick={goNext} aria-label="Next">
            <ChevronRight size={16} />
          </button>
        </div>
        {mode !== "month" && (
          <div className="tj-cal-total">
            Month total: <PnLText value={monthTotal.pnl} decimals={0} /> <span className="tj-panel-sub">({monthTotal.count} trades)</span>
          </div>
        )}
      </div>

      {mode === "day" && (
        <div className="tj-cal-panel">
          <div className="tj-cal-weekday-row">
            {WEEKDAYS_SHORT.map((w, i) => (
              <div key={i} className="tj-cal-weekday">
                {w}
              </div>
            ))}
          </div>
          <div className="tj-cal-grid">
            {dayGrid.map((c, i) => {
              if (!c) return <div key={i} className="tj-cal-cell tj-cal-cell-blank" />;
              const data = byDate[c.dateStr];
              const cls = dayColor(data?.pnl, !!data);
              return (
                <div key={i} className={`tj-cal-cell ${cls}`}>
                  <span className="tj-cal-daynum">{c.d}</span>
                  {data ? (
                    <>
                      <span className="tj-cal-amount">{fmtMoney(data.pnl, { decimals: 0 })}</span>
                      <span className="tj-cal-count">{data.count} trade{data.count > 1 ? "s" : ""}</span>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {mode === "week" && (
        <div className="tj-cal-panel">
          {weekRows.map((wr, i) => {
            const hasTrades = wr.count > 0;
            const cls = dayColor(wr.pnl, hasTrades);
            return (
              <div key={i} className={`tj-week-row ${cls}`}>
                <div className="tj-week-label">{wr.label || `Week ${i + 1}`}</div>
                <div className="tj-week-mini">
                  {wr.row.map((c, j) =>
                    c ? (
                      <span
                        key={j}
                        className={`tj-week-dot ${dayColor(byDate[c.dateStr]?.pnl, !!byDate[c.dateStr])}`}
                        title={`${c.dateStr}`}
                      />
                    ) : (
                      <span key={j} className="tj-week-dot tj-week-dot-blank" />
                    )
                  )}
                </div>
                <div className="tj-week-stats">
                  <span className="tj-panel-sub">{wr.count} trade{wr.count === 1 ? "" : "s"}</span>
                  {hasTrades ? <PnLText value={wr.pnl} decimals={0} /> : <span className="tj-neu">—</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {mode === "month" && (
        <div className="tj-month-grid">
          {monthCells.map((m) => {
            const cls = dayColor(m.pnl, m.count > 0);
            return (
              <div key={m.key} className={`tj-month-cell ${cls}`} onClick={() => m.count > 0 && (setCursor(new Date(year, MONTH_NAMES.indexOf(m.name), 1)), setMode("day"))}>
                <span className="tj-month-name">{m.name}</span>
                {m.count > 0 ? (
                  <>
                    <span className="tj-cal-amount">{fmtMoney(m.pnl, { decimals: 0 })}</span>
                    <span className="tj-cal-count">{m.count} trades</span>
                  </>
                ) : (
                  <span className="tj-cal-count">No trades</span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------

export default function TradingJournal() {
  const [rawTrades, setRawTrades] = useState([]);
  const [tagLibrary, setTagLibrary] = useState(DEFAULT_TAGS);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [authMode, setAuthMode] = useState("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState("dashboard");
  const [formOpen, setFormOpen] = useState(false);
  const [editingTrade, setEditingTrade] = useState(null);
  const [importMsg, setImportMsg] = useState("");
  const fileInputRef = useRef(null);

  const sync = useCallback(async (nextTrades, nextTags) => {
    persistLocalTrades(nextTrades);
    persistLocalTags(nextTags);
    if (!session || !cloudConfigured) return;
    setSyncing(true);
    try {
      await saveCloudData(nextTrades, nextTags);
    } catch (e) {
      setImportMsg(`Saved locally; cloud sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }, [session]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!cloudConfigured) {
        if (mounted) {
          setRawTrades(loadLocalTrades());
          setTagLibrary(loadLocalTags());
          setLoading(false);
        }
        return;
      }
      try {
        const current = await getCurrentSession();
        if (!mounted) return;
        if (current) {
          setSession(current);
          const cloud = await loadCloudData();
          if (!mounted) return;
          const localTrades = loadLocalTrades();
          const localTags = loadLocalTags();
          const mergedTrades = mergeById(cloud?.trades || [], localTrades);
          const mergedTags = mergeById(cloud?.tags || [], localTags);
          setRawTrades(mergedTrades);
          setTagLibrary(mergedTags.length ? mergedTags : DEFAULT_TAGS);
          await saveCloudData(mergedTrades, mergedTags.length ? mergedTags : DEFAULT_TAGS);
          persistLocalTrades(mergedTrades);
          persistLocalTags(mergedTags.length ? mergedTags : DEFAULT_TAGS);
        } else {
          setRawTrades([]);
          setTagLibrary(DEFAULT_TAGS);
        }
      } catch (e) {
        setAuthError(e.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    setAuthMessage("");
    if (!authEmail || !authPassword) return setAuthError("Enter your email and password.");
    if (authPassword.length < 6) return setAuthError("Password must be at least 6 characters.");
    setLoading(true);
    try {
      const localTrades = loadLocalTrades();
      const localTags = loadLocalTags();
      const data = authMode === "signup" ? await signUp(authEmail, authPassword) : await signIn(authEmail, authPassword);
      if (!data?.access_token) {
        setAuthMessage("Account created. Check your email to confirm it, then sign in.");
        setAuthMode("signin");
        return;
      }
      const current = await getCurrentSession();
      setSession(current);
      const cloud = await loadCloudData();
      const mergedTrades = mergeById(cloud?.trades || [], localTrades);
      const mergedTags = mergeById(cloud?.tags || [], localTags);
      const finalTags = mergedTags.length ? mergedTags : DEFAULT_TAGS;
      setRawTrades(mergedTrades);
      setTagLibrary(finalTags);
      await saveCloudData(mergedTrades, finalTags);
      persistLocalTrades(mergedTrades);
      persistLocalTags(finalTags);
    } catch (e2) {
      setAuthError(e2.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = () => {
    signOut();
    setSession(null);
    setRawTrades([]);
    setTagLibrary(DEFAULT_TAGS);
  };

  const handleCreateTag = useCallback((tag) => {
    setTagLibrary((prev) => {
      const next = [...prev, tag];
      sync(rawTrades, next);
      return next;
    });
  }, [rawTrades, sync]);

  const handleDeleteTag = useCallback((tagId) => {
    setTagLibrary((prev) => {
      const next = prev.filter((t) => t.id !== tagId);
      sync(rawTrades, next);
      return next;
    });
  }, [rawTrades, sync]);

  const trades = useMemo(() => rawTrades.map(enrichTrade), [rawTrades]);

  const handleAddNew = () => {
    setEditingTrade(null);
    setFormOpen(true);
  };

  const handleEdit = (trade) => {
    setEditingTrade(trade);
    setFormOpen(true);
  };

  const handleSave = (trade) => {
    setRawTrades((prev) => {
      const exists = prev.some((t) => t.id === trade.id);
      const next = exists ? prev.map((t) => (t.id === trade.id ? trade : t)) : [...prev, trade];
      sync(next, tagLibrary);
      return next;
    });
    setFormOpen(false);
    setEditingTrade(null);
  };

  const handleDelete = (id) => {
    setRawTrades((prev) => {
      const next = prev.filter((t) => t.id !== id);
      sync(next, tagLibrary);
      return next;
    });
    setFormOpen(false);
    setEditingTrade(null);
  };

  const handleCsv = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const parsed = results.data
          .map(rowToTrade)
          .filter((t) => t.date && t.entryPrice !== "" && t.exitPrice !== "");

        if (parsed.length === 0) {
          setImportMsg("No valid rows found. Check your CSV columns.");
        } else {
          setRawTrades((prev) => {
            const existingIds = new Set(prev.map((t) => t.id));
            const next = [...prev, ...parsed.filter((t) => !existingIds.has(t.id))];
            sync(next, tagLibrary);
            return next;
          });
          setImportMsg(`Imported ${parsed.length} trade${parsed.length > 1 ? "s" : ""}.`);
        }
        setTimeout(() => setImportMsg(""), 4000);
      },
      error: () => setImportMsg("Couldn't read that file."),
    });
    e.target.value = "";
  };

  const downloadTemplate = () => {
    const csv =
      "date,instrument,direction,contracts,entry,exit,tp,sl,notes\n" +
      "2026-09-08,NQ,Long,1,19850.25,19875.00,19900.00,19825.00,Example trade\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trade-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const tabLabel = { dashboard: "Dashboard", trades: "Trades", calendar: "Calendar" }[tab];

  if (cloudConfigured && !session && !loading) {
    return (
      <div className="tj-auth-page">
        <style>{`
          .tj-auth-page { min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0F1512; color:#E8ECE9; font-family:'IBM Plex Mono',monospace; padding:24px; }
          .tj-auth-card { width:100%; max-width:420px; border:1px solid #34413A; background:#141B17; padding:32px; }
          .tj-auth-card h1 { font-family:'Fraunces',serif; font-weight:500; margin:0 0 8px; font-size:28px; }
          .tj-auth-card p { color:#8B968F; font-size:12px; line-height:1.6; margin:0 0 24px; }
          .tj-auth-field { display:block; margin-bottom:14px; }
          .tj-auth-field span { display:block; color:#8B968F; font-size:11px; margin-bottom:6px; }
          .tj-auth-field input { width:100%; padding:10px 12px; background:#171F1B; border:1px solid #34413A; color:#E8ECE9; font:13px 'IBM Plex Mono',monospace; }
          .tj-auth-submit { width:100%; padding:11px; border:1px solid #D9A84E; background:#D9A84E; color:#241a06; font:600 12px 'IBM Plex Mono',monospace; cursor:pointer; margin-top:4px; }
          .tj-auth-switch { background:none; border:0; color:#8B968F; cursor:pointer; font:11px 'IBM Plex Mono',monospace; padding:12px 0 0; }
          .tj-auth-error { color:#C1584A; font-size:11px; line-height:1.5; margin:12px 0 0; }
          .tj-auth-msg { color:#D9A84E; font-size:11px; line-height:1.5; margin:12px 0 0; }
        `}</style>
        <form className="tj-auth-card" onSubmit={handleAuth}>
          <h1>Farley Trades<span style={{color:'#D9A84E'}}>.</span></h1>
          <p>{authMode === "signup" ? "Create an account so your journal syncs across your phone, laptop, and desktop." : "Sign in to access the same journal from every device."}</p>
          <label className="tj-auth-field"><span>Email</span><input type="email" value={authEmail} onChange={(e) => setAuthEmail(e.target.value)} autoComplete="email" /></label>
          <label className="tj-auth-field"><span>Password</span><input type="password" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} autoComplete={authMode === "signup" ? "new-password" : "current-password"} /></label>
          <button className="tj-auth-submit" type="submit">{authMode === "signup" ? "Create account" : "Sign in"}</button>
          {authError ? <div className="tj-auth-error">{authError}</div> : null}
          {authMessage ? <div className="tj-auth-msg">{authMessage}</div> : null}
          <button type="button" className="tj-auth-switch" onClick={() => { setAuthMode(authMode === "signup" ? "signin" : "signup"); setAuthError(""); setAuthMessage(""); }}>
            {authMode === "signup" ? "Already have an account? Sign in" : "Need an account? Create one"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="tj-app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap');

        html, body, #root {
          margin: 0;
          padding: 0;
          width: 100%;
          min-height: 100%;
          background: #0F1512;
        }

        body {
          background: #0F1512;
        }

        .tj-app {
          --bg: #0F1512;
          --surface: #141B17;
          --surface-2: #171F1B;
          --border: #26302B;
          --border-strong: #34413A;
          --text: #E8ECE9;
          --text-dim: #8B968F;
          --text-faint: #5C6660;
          --gain: #4FAE7C;
          --gain-dim: #2E5C46;
          --loss: #C1584A;
          --loss-dim: #603229;
          --accent: #D9A84E;
          --font-serif: 'Fraunces', serif;
          --font-mono: 'IBM Plex Mono', monospace;

          display: flex;
          min-height: 100vh;
          width: 100%;
          background: var(--bg);
          color: var(--text);
          font-family: var(--font-mono);
          font-size: 13px;
          box-sizing: border-box;
        }
        .tj-app * { box-sizing: border-box; }
        .tj-pos { color: var(--gain); }
        .tj-neg { color: var(--loss); }
        .tj-neu { color: var(--text-faint); }

        /* Sidebar */
        .tj-sidebar {
          width: 200px;
          flex-shrink: 0;
          border-right: 1px solid var(--border);
          padding: 24px 16px;
          display: flex;
          flex-direction: column;
          gap: 28px;
        }
        .tj-wordmark {
          font-family: var(--font-serif);
          font-style: italic;
          font-weight: 500;
          font-size: 26px;
          letter-spacing: 0.3px;
          color: var(--text);
        }
        .tj-wordmark span { color: var(--accent); }
        .tj-nav { display: flex; flex-direction: column; gap: 2px; }
        .tj-nav-item {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 9px 10px;
          border-radius: 3px;
          color: var(--text-dim);
          cursor: pointer;
          border: 1px solid transparent;
          font-size: 13px;
          background: none;
          text-align: left;
        }
        .tj-nav-item:hover { color: var(--text); }
        .tj-nav-item.tj-nav-active {
          background: var(--surface-2);
          border-color: var(--border);
          color: var(--text);
        }
        .tj-sidebar-actions { margin-top: auto; display: flex; flex-direction: column; gap: 8px; }

        /* Main */
        .tj-main { flex: 1; min-width: 0; padding: 28px 36px 60px; }
        .tj-header { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 22px; flex-wrap: wrap; gap: 12px; }
        .tj-header h1 { font-family: var(--font-serif); font-weight: 500; font-size: 24px; margin: 0; }
        .tj-header-actions { display: flex; gap: 10px; align-items: center; }
        .tj-import-msg { font-size: 12px; color: var(--accent); }
        .tj-sync-status { font-size: 11px; color: var(--text-faint); }

        /* Buttons */
        .tj-btn {
          display: inline-flex; align-items: center; gap: 6px;
          background: var(--surface-2); color: var(--text);
          border: 1px solid var(--border-strong);
          padding: 8px 14px; border-radius: 3px; cursor: pointer;
          font-family: var(--font-mono); font-size: 12.5px;
        }
        .tj-btn:hover { border-color: var(--accent); }
        .tj-btn-primary { background: var(--accent); color: #241a06; border-color: var(--accent); font-weight: 600; }
        .tj-btn-primary:hover { filter: brightness(1.08); }
        .tj-btn-danger { color: var(--loss); border-color: var(--loss-dim); background: transparent; }
        .tj-btn-danger:hover { border-color: var(--loss); }
        .tj-icon-btn {
          background: none; border: 1px solid transparent; color: var(--text-dim);
          cursor: pointer; padding: 6px; border-radius: 3px; display: inline-flex;
        }
        .tj-icon-btn:hover { color: var(--text); border-color: var(--border); }

        /* Stat row */
        .tj-stat-row {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
          border: 1px solid var(--border);
          margin-bottom: 22px;
        }
        .tj-stat {
          padding: 14px 16px;
          border-right: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
        }
        .tj-stat-label { font-size: 11px; color: var(--text-dim); margin-bottom: 6px; }
        .tj-stat-value { font-size: 19px; font-weight: 500; }
        .tj-stat-sub { font-size: 11px; color: var(--text-faint); margin-top: 3px; }

        /* Panels */
        .tj-panel { border: 1px solid var(--border); padding: 18px 20px; margin-bottom: 20px; background: var(--surface); }
        .tj-panel-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
        .tj-panel-head h3 { font-family: var(--font-serif); font-weight: 500; font-size: 16px; margin: 0; }
        .tj-panel-sub { font-size: 11.5px; color: var(--text-dim); }
        .tj-two-col { display: grid; grid-template-columns: 1.3fr 1fr; gap: 20px; }
        @media (max-width: 900px) { .tj-two-col { grid-template-columns: 1fr; } }

        .tj-inst-list { display: flex; flex-direction: column; }
        .tj-inst-row {
          display: grid; grid-template-columns: 50px 1fr 70px 90px;
          align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border);
          font-size: 12.5px;
        }
        .tj-inst-row:last-child { border-bottom: none; }
        .tj-inst-name { font-weight: 600; }
        .tj-inst-count, .tj-inst-wr { color: var(--text-dim); }
        .tj-tag-perf-row { grid-template-columns: 160px 1fr 70px 90px; }

        /* Tag picker (in form) */
        .tj-tag-picker { display: flex; flex-wrap: wrap; gap: 8px; }
        .tj-tag-chip {
          display: inline-flex; align-items: center; gap: 6px;
          background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text-dim);
          padding: 6px 10px; border-radius: 14px; cursor: pointer; font-family: var(--font-mono); font-size: 12px;
        }
        .tj-tag-chip-active { border-color: var(--accent); color: var(--text); background: rgba(217,168,78,0.12); }
        .tj-tag-chip-new { color: var(--text-faint); border-style: dashed; }
        .tj-tag-chip-new:hover { color: var(--text-dim); border-color: var(--text-dim); }
        .tj-tag-remove {
          display: inline-flex; color: var(--text-faint); margin-left: 2px; border-radius: 50%;
        }
        .tj-tag-remove:hover { color: var(--loss); }
        .tj-tag-new { display: inline-flex; align-items: center; gap: 6px; background: var(--surface-2); border: 1px solid var(--accent); border-radius: 14px; padding: 4px 8px; }
        .tj-tag-new-emoji { width: 40px; background: none; border: none; color: var(--text); font-family: var(--font-mono); font-size: 13px; text-align: center; }
        .tj-tag-new-label { width: 100px; background: none; border: none; border-bottom: 1px solid var(--border-strong); color: var(--text); font-family: var(--font-mono); font-size: 12px; padding: 2px 4px; }
        .tj-tag-new-label:focus, .tj-tag-new-emoji:focus { outline: none; }
        .tj-tag-new-add { background: var(--accent); color: #241a06; border: none; border-radius: 10px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-weight: 600; }

        /* Confidence dots */
        .tj-conf-dots { display: flex; align-items: center; gap: 6px; }
        .tj-conf-dot {
          width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border-strong);
          background: var(--surface-2); color: var(--text-faint); cursor: pointer; font-family: var(--font-mono); font-size: 11px;
        }
        .tj-conf-dot-filled { background: var(--accent); border-color: var(--accent); color: #241a06; font-weight: 600; }
        .tj-conf-clear-label { margin-left: 4px; font-size: 11px; color: var(--text-dim); }

        /* Tags in trade table */
        .tj-table-tags { display: flex; gap: 4px; font-size: 14px; }

        /* Empty state */
        .tj-empty { border: 1px dashed var(--border-strong); padding: 60px 24px; text-align: center; }
        .tj-empty h2 { font-family: var(--font-serif); font-weight: 500; font-size: 19px; margin: 0 0 8px; }
        .tj-empty p { color: var(--text-dim); font-size: 13px; margin: 0; }

        /* Trades table */
        .tj-filters { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; }
        .tj-filters select {
          background: var(--surface-2); color: var(--text); border: 1px solid var(--border-strong);
          padding: 7px 10px; border-radius: 3px; font-family: var(--font-mono); font-size: 12.5px;
        }
        .tj-filters-count { color: var(--text-dim); font-size: 12px; margin-left: auto; }
        .tj-table-wrap { border: 1px solid var(--border); overflow-x: auto; }
        .tj-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
        .tj-table th {
          text-align: left; padding: 10px 14px; color: var(--text-dim); font-weight: 500;
          border-bottom: 1px solid var(--border); font-size: 11px; white-space: nowrap;
        }
        .tj-table td { padding: 10px 14px; border-bottom: 1px solid var(--border); white-space: nowrap; }
        .tj-table-row { cursor: pointer; }
        .tj-table-row:hover { background: var(--surface-2); }
        .tj-table-row:last-child td { border-bottom: none; }
        .tj-table-dim { color: var(--text-dim); }
        .tj-edit-icon { color: var(--text-faint); }
        .tj-table-row:hover .tj-edit-icon { color: var(--accent); }

        /* Modal / form */
        .tj-modal-backdrop {
          position: fixed; inset: 0; background: rgba(6,9,7,0.7);
          display: flex; align-items: center; justify-content: center;
          z-index: 50; padding: 20px;
        }
        .tj-modal {
          background: var(--surface); border: 1px solid var(--border-strong);
          width: 100%; max-width: 640px; max-height: 90vh; overflow-y: auto;
          padding: 24px 26px; border-radius: 4px;
        }
        .tj-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
        .tj-modal-head h3 { font-family: var(--font-serif); font-weight: 500; font-size: 18px; margin: 0; }
        .tj-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .tj-field { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: var(--text-dim); }
        .tj-field-wide { grid-column: 1 / -1; }
        .tj-field input, .tj-field select, .tj-field textarea {
          background: var(--surface-2); border: 1px solid var(--border-strong); color: var(--text);
          padding: 9px 10px; border-radius: 3px; font-family: var(--font-mono); font-size: 13px;
        }
        .tj-field input:focus, .tj-field select:focus, .tj-field textarea:focus { outline: none; border-color: var(--accent); }
        .tj-field input:disabled { color: var(--text-faint); }
        .tj-toggle-pair { display: flex; gap: 8px; }
        .tj-toggle-btn {
          flex: 1; padding: 9px; border-radius: 3px; border: 1px solid var(--border-strong);
          background: var(--surface-2); color: var(--text-dim); cursor: pointer; font-family: var(--font-mono); font-size: 12.5px;
        }
        .tj-toggle-active-pos { border-color: var(--gain); color: var(--gain); background: rgba(79,174,124,0.1); }
        .tj-toggle-active-neg { border-color: var(--loss); color: var(--loss); background: rgba(193,88,74,0.1); }
        .tj-form-preview {
          display: flex; justify-content: space-between; align-items: center;
          margin-top: 18px; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border);
          font-size: 13px;
        }
        .tj-form-error { color: var(--loss); font-size: 12px; margin-top: 10px; }
        .tj-modal-actions { display: flex; justify-content: space-between; align-items: center; margin-top: 20px; }

        /* Calendar */
        .tj-cal-controls { display: flex; align-items: center; gap: 18px; margin-bottom: 18px; flex-wrap: wrap; }
        .tj-tab-switch { display: flex; border: 1px solid var(--border-strong); border-radius: 3px; overflow: hidden; }
        .tj-tab-switch button {
          background: var(--surface-2); color: var(--text-dim); border: none; padding: 7px 14px;
          cursor: pointer; font-family: var(--font-mono); font-size: 12px; border-right: 1px solid var(--border-strong);
        }
        .tj-tab-switch button:last-child { border-right: none; }
        .tj-tab-active { color: var(--text) !important; background: var(--surface) !important; }
        .tj-cal-nav { display: flex; align-items: center; gap: 6px; }
        .tj-cal-title { font-family: var(--font-serif); font-size: 15px; min-width: 130px; text-align: center; }
        .tj-cal-total { margin-left: auto; font-size: 12.5px; }

        .tj-cal-panel { border: 1px solid var(--border); padding: 16px; }
        .tj-cal-weekday-row { display: grid; grid-template-columns: repeat(7, 1fr); margin-bottom: 8px; }
        .tj-cal-weekday { text-align: center; font-size: 11px; color: var(--text-faint); }
        .tj-cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
        .tj-cal-cell {
          aspect-ratio: 1 / 0.85; border: 1px solid var(--border); border-radius: 2px;
          padding: 6px; display: flex; flex-direction: column; gap: 2px; font-size: 10.5px;
        }
        .tj-cal-cell-blank { border: none; }
        .tj-cal-daynum { color: var(--text-dim); font-size: 11px; }
        .tj-cal-amount { font-size: 12.5px; font-weight: 600; margin-top: auto; }
        .tj-cal-count { color: var(--text-faint); font-size: 10px; }
        .tj-cal-empty { background: var(--surface-2); }
        .tj-cal-empty .tj-cal-amount { display: none; }
        .tj-cal-win { background: rgba(79,174,124,0.14); border-color: var(--gain-dim); }
        .tj-cal-win .tj-cal-amount { color: var(--gain); }
        .tj-cal-loss { background: rgba(193,88,74,0.14); border-color: var(--loss-dim); }
        .tj-cal-loss .tj-cal-amount { color: var(--loss); }
        .tj-cal-flat { background: var(--surface-2); }
        .tj-cal-flat .tj-cal-amount { color: var(--text-dim); }

        .tj-week-row {
          display: flex; align-items: center; gap: 16px; padding: 12px 14px;
          border-bottom: 1px solid var(--border); border-left: 3px solid transparent;
        }
        .tj-week-row:last-child { border-bottom: none; }
        .tj-week-row.tj-cal-win { border-left-color: var(--gain); background: rgba(79,174,124,0.06); }
        .tj-week-row.tj-cal-loss { border-left-color: var(--loss); background: rgba(193,88,74,0.06); }
        .tj-week-row.tj-cal-empty, .tj-week-row.tj-cal-flat { border-left-color: var(--border-strong); }
        .tj-week-label { width: 140px; font-size: 12px; color: var(--text-dim); flex-shrink: 0; }
        .tj-week-mini { display: flex; gap: 4px; }
        .tj-week-dot { width: 9px; height: 9px; border-radius: 2px; background: var(--surface-2); border: 1px solid var(--border); }
        .tj-week-dot-blank { border: none; background: transparent; }
        .tj-week-dot.tj-cal-win { background: var(--gain); border-color: var(--gain); }
        .tj-week-dot.tj-cal-loss { background: var(--loss); border-color: var(--loss); }
        .tj-week-stats { margin-left: auto; display: flex; align-items: center; gap: 10px; font-size: 13px; }

        .tj-month-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
        @media (max-width: 700px) { .tj-month-grid { grid-template-columns: repeat(2, 1fr); } }
        .tj-month-cell {
          border: 1px solid var(--border); border-radius: 2px; padding: 16px;
          display: flex; flex-direction: column; gap: 4px; cursor: pointer;
        }
        .tj-month-name { font-family: var(--font-serif); font-size: 15px; margin-bottom: 6px; }
        .tj-month-cell.tj-cal-win { background: rgba(79,174,124,0.1); border-color: var(--gain-dim); }
        .tj-month-cell.tj-cal-loss { background: rgba(193,88,74,0.1); border-color: var(--loss-dim); }
        .tj-month-cell .tj-cal-amount { font-size: 15px; }

        input[type="file"] { display: none; }
      `}</style>

      <aside className="tj-sidebar">
        <div className="tj-wordmark">
          Farley Trades<span>.</span>
        </div>
        <nav className="tj-nav">
          <button className={`tj-nav-item ${tab === "dashboard" ? "tj-nav-active" : ""}`} onClick={() => setTab("dashboard")}>
            <LayoutGrid size={15} /> Dashboard
          </button>
          <button className={`tj-nav-item ${tab === "trades" ? "tj-nav-active" : ""}`} onClick={() => setTab("trades")}>
            <ListTree size={15} /> Trades
          </button>
          <button className={`tj-nav-item ${tab === "calendar" ? "tj-nav-active" : ""}`} onClick={() => setTab("calendar")}>
            <CalendarDays size={15} /> Calendar
          </button>
        </nav>
        <div className="tj-sidebar-actions">
          <button className="tj-btn tj-btn-primary" onClick={handleAddNew}>
            <Plus size={14} /> Log trade
          </button>
          <button className="tj-btn" onClick={() => fileInputRef.current?.click()}>
            <Upload size={14} /> Import CSV
          </button>
          <button className="tj-btn" onClick={downloadTemplate} style={{ fontSize: 11.5, color: "var(--text-dim)" }}>
            <Download size={13} /> CSV template
          </button>
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCsv} />
        </div>
      </aside>

      <main className="tj-main">
        <div className="tj-header">
          <h1>{tabLabel}</h1>
          <div className="tj-header-actions">
            {importMsg ? <span className="tj-import-msg">{importMsg}</span> : null}
            {cloudConfigured && session ? <><span className="tj-sync-status">{syncing ? "Syncing…" : "Cloud synced"}</span><button className="tj-btn" onClick={handleSignOut}>Sign out</button></> : null}
          </div>
        </div>

        {loading ? (
          <div className="tj-empty">
            <h2>Loading...</h2>
          </div>
        ) : (
          <>
            {tab === "dashboard" && <Dashboard trades={trades} tagLibrary={tagLibrary} />}
            {tab === "trades" && <TradesTab trades={trades} tagLibrary={tagLibrary} onEdit={handleEdit} />}
            {tab === "calendar" && <CalendarTab trades={trades} />}
          </>
        )}
      </main>

      {formOpen && (
        <TradeForm
          initial={editingTrade}
          tagLibrary={tagLibrary}
          onCreateTag={handleCreateTag}
          onDeleteTag={handleDeleteTag}
          onSave={handleSave}
          onCancel={() => {
            setFormOpen(false);
            setEditingTrade(null);
          }}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
