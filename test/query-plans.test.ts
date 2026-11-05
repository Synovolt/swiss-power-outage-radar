/**
 * Guards the D1 rows-read budget (free plan: 5M rows/day). Each recurring
 * query must seek through an index instead of scanning a whole table; a
 * partial index stops matching silently when its query's WHERE is edited, so
 * the plans are checked here with the exact SQL and parameters the code sends.
 */
import { describe, expect, it } from "vitest";
import { migratedDatabase, type SqliteD1 } from "./helpers/sqlite-d1";
import {
  createWorkflowRun,
  getEventsNeedingIntelligence,
  getHistoricalBackfillTargets,
  getPendingOutageEventEmails,
  getPublicFeedItem,
  getUnlinkedRelevantItems,
  getUnplannedEventsDueForResearchRefresh
} from "../src/db";
import { getPublicPlace, listPublicItems, refreshPublicProjection, summarizePublicSlice } from "../src/public-projection";

interface Captured {
  sql: string;
  params: unknown[];
}

type AnyStatement = { sql: string; params: unknown[]; bind(...values: unknown[]): AnyStatement; all(): Promise<unknown>; first(): Promise<unknown>; run(): Promise<unknown> };

function capturing(sqlite: SqliteD1): { db: D1Database; captured: Captured[] } {
  const captured: Captured[] = [];
  const wrap = (statement: AnyStatement): unknown => ({
    statement,
    bind: (...values: unknown[]) => wrap(statement.bind(...values)),
    all: () => { captured.push({ sql: statement.sql, params: statement.params }); return statement.all(); },
    first: () => { captured.push({ sql: statement.sql, params: statement.params }); return statement.first(); },
    run: () => { captured.push({ sql: statement.sql, params: statement.params }); return statement.run(); }
  });
  const db = {
    prepare: (sql: string) => wrap(sqlite.prepare(sql) as unknown as AnyStatement),
    batch: (list: Array<{ statement: AnyStatement }>) => {
      for (const item of list) captured.push({ sql: item.statement.sql, params: item.statement.params });
      return sqlite.batch(list.map((item) => item.statement) as never);
    }
  };
  return { db: db as unknown as D1Database, captured };
}

function plan(sqlite: SqliteD1, query: Captured): string[] {
  const rows = sqlite.sqlite.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...(query.params as never[])) as Array<{ detail: string }>;
  return rows.map((row) => row.detail);
}

/** A bare "SCAN table" (no index) reads every row of that table. */
function fullScans(lines: string[]): string[] {
  return lines.filter((line) => /^SCAN \w+(?: AS \w+)?$/.test(line.trim()));
}

async function plansOf(run: (db: D1Database) => Promise<unknown>, match: RegExp): Promise<{ sqlite: SqliteD1; lines: string[] }> {
  const sqlite = migratedDatabase();
  const { db, captured } = capturing(sqlite);
  await run(db);
  const query = captured.find((entry) => match.test(entry.sql));
  if (!query) throw new Error(`query ${match} was not sent`);
  return { sqlite, lines: plan(sqlite, query) };
}

describe("D1 query plans", () => {
  it("guards overlapping cron runs through the running-runs index", async () => {
    const { lines } = await plansOf((db) => createWorkflowRun(db, "2026-11-04T16:00:00.000Z"), /INSERT INTO workflow_runs/);
    expect(fullScans(lines)).toEqual([]);
    expect(lines.join("\n")).toContain("idx_workflow_runs_running");
  });

  it("finds pending event mails through the partial pending-mail index", async () => {
    const { lines } = await plansOf((db) => getPendingOutageEventEmails(db), /WHERE email_sent = 0/);
    expect(fullScans(lines)).toEqual([]);
    expect(lines.join("\n")).toContain("idx_outage_events_email_pending");
    expect(lines.join("\n")).not.toContain("TEMP B-TREE");
  });

  it("finds events without intelligence through the partial index", async () => {
    const { lines } = await plansOf((db) => getEventsNeedingIntelligence(db, 5), /fact_sheet_json IS NULL/);
    expect(fullScans(lines)).toEqual([]);
    expect(lines.join("\n")).toContain("idx_outage_events_needs_intelligence");
    expect(lines.join("\n")).not.toContain("TEMP B-TREE");
  });

  it("walks the historical backfill queue in index order", async () => {
    const { lines } = await plansOf(
      (db) => getHistoricalBackfillTargets(db, "2026-11-03T04:00:00.000Z", 3),
      /backfill_source_id/
    );
    expect(fullScans(lines)).toEqual([]);
    expect(lines[0]).toMatch(/^SEARCH event USING INDEX idx_outage_events_backfill_queue/);
    expect(lines.join("\n")).toContain("idx_outage_facts_event_extractor");
    // The only sort is the per-event "primary source" subquery (a few rows each).
    const sorts = lines.flatMap((line, index) => (line.includes("TEMP B-TREE") ? [index] : []));
    const sourceLookup = lines.findIndex((line) => line.startsWith("SEARCH candidate USING INDEX idx_outage_sources_event"));
    expect(sorts.every((index) => sourceLookup >= 0 && index > sourceLookup)).toBe(true);
  });

  it("resumes the historical backfill walk at the cursor through the index", async () => {
    const { lines } = await plansOf(
      (db) => getHistoricalBackfillTargets(db, "2026-11-03T04:00:00.000Z", 3, { sortAt: "2026-10-01T00:00:00.000Z", id: 7 }),
      /backfill_source_id/
    );
    expect(lines[0]).toBe("SEARCH event USING INDEX idx_outage_events_backfill_queue (<expr>>? AND <expr><?)");
  });

  it("returns the backfill targets after the cursor, oldest first", async () => {
    const sqlite = migratedDatabase();
    const db = sqlite.asD1();
    for (let id = 1; id <= 5; id++) {
      const at = `2026-10-0${id}T08:00:00.000Z`;
      await db.prepare(
        `INSERT INTO outage_events (id, title, first_seen_at, last_seen_at, received_at, status, country, origin)
         VALUES (?, ?, ?, ?, ?, 'resolved', 'CH', 'media')`
      ).bind(id, `Event ${id}`, at, at, at).run();
      await db.prepare(
        `INSERT INTO publication_decisions (outage_event_id, publishable, trust, reasons_json, evaluator_version, decided_at)
         VALUES (?, 1, 'reported', '[]', 'test', ?)`
      ).bind(id, at).run();
      await db.prepare("INSERT INTO alert_items (id, feed_language, title, url, fetched_at, item_hash) VALUES (?, 'de', 't', ?, ?, ?)")
        .bind(id, `https://news.ch/${id}`, at, `hash-${id}`).run();
      await db.prepare("INSERT INTO outage_sources (outage_event_id, alert_item_id, source_url, source_title) VALUES (?, ?, ?, 't')")
        .bind(id, id, `https://news.ch/${id}`).run();
    }
    await db.prepare(
      `INSERT INTO outage_facts (outage_event_id, fact_type, value_text, evidence_excerpt, extractor_version)
       VALUES (2, 'status', 'historical', 'x', 'historical-backfill/v1')`
    ).run();

    const fromStart = await getHistoricalBackfillTargets(db, "2026-11-01T00:00:00.000Z", 3);
    expect(fromStart.map((row) => row.id)).toEqual([1, 3, 4]);
    expect(fromStart[2].backfill_sort_at).toBe("2026-10-04T08:00:00.000Z");

    const resumed = await getHistoricalBackfillTargets(db, "2026-11-01T00:00:00.000Z", 3, { sortAt: fromStart[2].backfill_sort_at, id: 4 });
    expect(resumed.map((row) => row.id)).toEqual([5]);
    expect(await getHistoricalBackfillTargets(db, "2026-11-01T00:00:00.000Z", 3, { sortAt: "2026-11-01T00:00:00.000Z", id: 0 })).toEqual([]);
  });

  it("finds unlinked relevant alert items through the partial index", async () => {
    const { lines } = await plansOf((db) => getUnlinkedRelevantItems(db), /WHERE outage_event_id IS NULL/);
    expect(fullScans(lines)).toEqual([]);
    expect(lines.join("\n")).toContain("idx_alert_items_unlinked_relevant");
    expect(lines.join("\n")).not.toContain("TEMP B-TREE");
  });

  it("finds research refresh targets among open unplanned events only", async () => {
    const { lines } = await plansOf(
      (db) => getUnplannedEventsDueForResearchRefresh(db, "2026-11-04T16:00:00.000Z", 1),
      /outage_nature = 'unplanned'/
    );
    expect(fullScans(lines)).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("idx_outage_events_open_unplanned");
    expect(text).toContain("idx_outage_events_research_finished");
  });

  it("reads a place page through the place's own rows", async () => {
    for (const bucket of [0, 1]) {
      const sqlite = migratedDatabase();
      const { db, captured } = capturing(sqlite);
      await listPublicItems(db, { placeSlug: "zuerich", limit: 20 });
      const query = captured.filter((entry) => /place_slug = \?/.test(entry.sql))[bucket];
      const lines = plan(sqlite, query);
      expect(fullScans(lines)).toEqual([]);
      expect(lines[0]).toMatch(/^SEARCH pl USING (?:COVERING )?INDEX idx_public_event_places_slug/);
      expect(lines.join("\n")).toMatch(/SEARCH p USING INTEGER PRIMARY KEY/);
    }
  });

  it("aggregates a place through the place's own rows", async () => {
    for (const run of [
      (db: D1Database) => summarizePublicSlice(db, { placeSlug: "zuerich" }),
      (db: D1Database) => getPublicPlace(db, "zuerich")
    ]) {
      const sqlite = migratedDatabase();
      const { db, captured } = capturing(sqlite);
      await run(db);
      for (const query of captured.filter((entry) => /place_slug = \?/.test(entry.sql))) {
        const lines = plan(sqlite, query);
        expect(fullScans(lines)).toEqual([]);
        expect(lines[0]).toMatch(/^SEARCH pl USING (?:COVERING )?INDEX idx_public_event_places_slug/);
      }
    }
  });

  it("loads public detail and projection inputs by primary key", async () => {
    const detail = await plansOf((db) => getPublicFeedItem(db, 42), /decision\.trust AS publication_trust/);
    expect(fullScans(detail.lines)).toEqual([]);
    expect(detail.lines[0]).toMatch(/^SEARCH event USING INTEGER PRIMARY KEY/);

    const projection = await plansOf(
      (db) => refreshPublicProjection({ DB: db }, { eventIds: [41, 42, 43] }),
      /decision\.trust AS publication_trust/
    );
    expect(fullScans(projection.lines)).toEqual([]);
    expect(projection.lines[0]).toMatch(/^SEARCH event USING INTEGER PRIMARY KEY/);
  });
});
