/**
 * Tiny server-side chart renderers. Output is static SVG/HTML styled through
 * CSS custom properties (see src/styles/data-pages.css), so charts need no
 * client JavaScript, follow light/dark mode and stay readable for crawlers.
 * Every chart is paired with a visually hidden data table for screen readers.
 */
import { escapeHtml } from "./html";

export interface ChartSeries {
  key: string;
  label: string;
  values: number[];
}

function niceMax(value: number): number {
  if (value <= 4) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value / 4) ?? 10;
  return Math.ceil(value / (step * magnitude)) * step * magnitude;
}

/** Stacked vertical bars, e.g. reports per week split by planned/unplanned. */
export function stackedBarChart(input: {
  labels: string[];
  tickLabels?: string[];
  series: ChartSeries[];
  title: string;
}): string {
  const width = 640;
  const height = 200;
  const pad = { top: 12, right: 8, bottom: 26, left: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totals = input.labels.map((_, index) => input.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const slot = innerW / Math.max(1, input.labels.length);
  const barW = Math.max(2, Math.min(18, slot * 0.68));
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;

  const grid = [0, 0.5, 1].map((fraction) => {
    const value = Math.round(max * fraction);
    const gy = y(value);
    return `<line class="chart-grid" x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}"/>`
      + `<text class="chart-axis" x="${pad.left - 6}" y="${gy + 3.5}" text-anchor="end">${value}</text>`;
  }).join("");

  const bars = input.labels.map((label, index) => {
    const x = pad.left + slot * index + (slot - barW) / 2;
    let base = 0;
    const parts = input.series.map((series) => {
      const value = series.values[index] ?? 0;
      if (!value) return "";
      const top = y(base + value);
      const rect = `<rect class="chart-series chart-series--${escapeHtml(series.key)}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(y(base) - top).toFixed(1)}" rx="1.5"><title>${escapeHtml(`${label}: ${series.label} ${value}`)}</title></rect>`;
      base += value;
      return rect;
    }).join("");
    return parts;
  }).join("");

  const ticks = (input.tickLabels ?? input.labels).map((label, index) => {
    if (!label) return "";
    const x = pad.left + slot * index + slot / 2;
    return `<text class="chart-axis" x="${x.toFixed(1)}" y="${height - 8}" text-anchor="middle">${escapeHtml(label)}</text>`;
  }).join("");

  return `<svg class="chart chart--bars" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.title)}" preserveAspectRatio="xMidYMid meet"><title>${escapeHtml(input.title)}</title>${grid}${bars}${ticks}</svg>`;
}

/** Weekday × hour heatmap (rows = weekdays, columns = 0–23 h). */
export function heatmapChart(input: { matrix: number[][]; rowLabels: string[]; title: string }): string {
  const cell = 22;
  const gap = 3;
  const left = 30;
  const top = 4;
  const width = left + 24 * (cell + gap);
  const height = top + input.matrix.length * (cell + gap) + 20;
  const max = Math.max(1, ...input.matrix.flat());
  const cells = input.matrix.map((row, rowIndex) => row.map((value, hour) => {
    const level = value === 0 ? 0 : Math.max(1, Math.ceil((value / max) * 4));
    const x = left + hour * (cell + gap);
    const yPos = top + rowIndex * (cell + gap);
    return `<rect class="heat heat--${level}" x="${x}" y="${yPos}" width="${cell}" height="${cell}" rx="3"><title>${escapeHtml(`${input.rowLabels[rowIndex]} ${String(hour).padStart(2, "0")}:00 · ${value}`)}</title></rect>`;
  }).join("")).join("");
  const rows = input.rowLabels.map((label, index) =>
    `<text class="chart-axis" x="${left - 6}" y="${top + index * (cell + gap) + cell / 2 + 4}" text-anchor="end">${escapeHtml(label)}</text>`
  ).join("");
  const hours = [0, 6, 12, 18, 23].map((hour) =>
    `<text class="chart-axis" x="${left + hour * (cell + gap) + cell / 2}" y="${height - 4}" text-anchor="middle">${String(hour).padStart(2, "0")}</text>`
  ).join("");
  return `<svg class="chart chart--heat" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(input.title)}"><title>${escapeHtml(input.title)}</title>${cells}${rows}${hours}</svg>`;
}

/** Horizontal distribution bars in plain HTML (wraps nicely on phones). */
export function distributionBars(input: { buckets: Array<{ label: string; count: number }>; tone?: string; title: string }): string {
  const max = Math.max(1, ...input.buckets.map((bucket) => bucket.count));
  const total = input.buckets.reduce((sum, bucket) => sum + bucket.count, 0) || 1;
  return `<ul class="dist${input.tone ? ` dist--${escapeHtml(input.tone)}` : ""}" aria-label="${escapeHtml(input.title)}">`
    + input.buckets.map((bucket) => {
      const share = Math.round((bucket.count / total) * 100);
      return `<li><span class="dist__label">${escapeHtml(bucket.label)}</span>`
        + `<span class="dist__track"><span class="dist__bar" style="width:${((bucket.count / max) * 100).toFixed(1)}%"></span></span>`
        + `<span class="dist__value">${bucket.count}<small>${share}%</small></span></li>`;
    }).join("")
    + `</ul>`;
}

export function sparkline(values: number[], label: string): string {
  const width = 84;
  const height = 22;
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}"><polyline points="${points}"/></svg>`;
}

/** Screen-reader table behind a chart. */
export function srTable(caption: string, headers: string[], rows: Array<Array<string | number>>): string {
  return `<table class="sr-only"><caption>${escapeHtml(caption)}</caption><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
