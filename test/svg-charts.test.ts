import { describe, expect, it } from "vitest";
import { distributionBars, heatmapChart, sparkline, srTable, stackedBarChart } from "../src/svg-charts";

describe("stackedBarChart", () => {
  const svg = stackedBarChart({
    labels: ["w1", "w2", "w3"],
    tickLabels: ["1. Jan", "", "15. Jan"],
    title: 'Reports <per> "week" & more',
    series: [
      { key: "unplanned", label: "Unplanned", values: [2, 0, 5] },
      { key: "planned", label: "Planned", values: [1, 3, 0] }
    ]
  });

  it("produces an accessible, balanced SVG", () => {
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain('viewBox="0 0 640 200"');
    expect(svg.match(/<rect /g)?.length).toBe(4); // zero values draw no rect
    expect(svg.match(/<rect /g)?.length).toBe(svg.match(/<\/rect>/g)?.length);
  });

  it("escapes the title in the aria-label and <title>", () => {
    expect(svg).toContain('aria-label="Reports &lt;per&gt; &quot;week&quot; &amp; more"');
    expect(svg).toContain("<title>Reports &lt;per&gt; &quot;week&quot; &amp; more</title>");
    expect(svg).not.toContain("<per>");
  });

  it("labels bars and skips empty tick labels", () => {
    expect(svg).toContain("<title>w3: Unplanned 5</title>");
    expect(svg).toContain(">1. Jan</text>");
    expect(svg).toContain(">15. Jan</text>");
    expect(svg.match(/text-anchor="middle"/g)?.length).toBe(2);
  });

  it("handles an all-zero series without NaN coordinates", () => {
    const empty = stackedBarChart({ labels: ["a", "b"], title: "Empty", series: [{ key: "x", label: "X", values: [0, 0] }] });
    expect(empty).not.toContain("NaN");
    expect(empty).not.toContain("<rect");
  });
});

describe("distributionBars", () => {
  it("shows counts with rounded percentages and widths relative to the largest bucket", () => {
    const html = distributionBars({
      title: "Lead <time>",
      tone: "planned",
      buckets: [{ label: "< 1 day", count: 1 }, { label: "1–3 days", count: 2 }, { label: "> 3 days", count: 0 }]
    });
    expect(html).toContain('class="dist dist--planned"');
    expect(html).toContain('aria-label="Lead &lt;time&gt;"');
    expect(html).toContain("&lt; 1 day");
    expect(html).toContain("1<small>33%</small>");
    expect(html).toContain("2<small>67%</small>");
    expect(html).toContain("0<small>0%</small>");
    expect(html).toContain('style="width:50.0%"');
    expect(html).toContain('style="width:100.0%"');
    expect(html.match(/<li>/g)?.length).toBe(3);
  });

  it("does not divide by zero for empty buckets", () => {
    const html = distributionBars({ title: "Empty", buckets: [{ label: "a", count: 0 }] });
    expect(html).not.toContain("NaN");
    expect(html).toContain("0<small>0%</small>");
  });
});

describe("other chart helpers", () => {
  it("renders a heatmap cell per value with intensity levels", () => {
    const matrix = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    matrix[2][8] = 4;
    matrix[0][0] = 1;
    const svg = heatmapChart({ matrix, rowLabels: ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"], title: "Heat" });
    expect(svg.match(/<rect /g)?.length).toBe(7 * 24);
    expect(svg).toContain('class="heat heat--4"');
    expect(svg).toContain('class="heat heat--1"');
    expect(svg).toContain("<title>Mi 08:00 · 4</title>");
  });

  it("renders a sparkline and a screen-reader table with escaped cells", () => {
    expect(sparkline([0, 2, 1], "Trend")).toContain('points="0.0,20.0 42.0,2.0 84.0,11.0"');
    const table = srTable("Cap", ["A", "B"], [["<x>", 1]]);
    expect(table).toContain('<table class="sr-only"><caption>Cap</caption>');
    expect(table).toContain("<td>&lt;x&gt;</td><td>1</td>");
  });
});
