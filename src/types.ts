export type FeedLanguage = "de" | "fr" | "it";
export type SourceRegistryType = "json_api" | "rss" | "html" | "google_alert";
export type SourceRegistryCategory =
  | "live_status"
  | "outage_map"
  | "news_feed"
  | "discovery_only"
  | "needs_adapter";
export type SourceTrustLevel = "official" | "credible" | "aggregator" | "unknown";
export type SourceHealthStatus = "unknown" | "healthy" | "degraded" | "failing" | "paused";
export type SourceTransportStatus = "unknown" | "ok" | "error";
export type SourceParserStatus = "unknown" | "ready" | "no_current_outage" | "needs_adapter" | "error";
export type CanonicalObservationStatus =
  | "planned"
  | "unplanned"
  | "historical"
  | "resolved"
  | "irrelevant"
  | "unverified";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI: Ai;
  BROWSER: BrowserRun;
  SNAPSHOTS: R2Bucket;
  EMAIL: SendEmail;
  ALERT_FEED_DE?: string;
  ALERT_FEED_FR?: string;
  ALERT_FEED_IT?: string;
  NOTIFY_EMAIL?: string;
  FROM_EMAIL?: string;
  ADMIN_TOKEN?: string;
  EXA_API_KEY?: string;
  AI_MOCK_MODE?: string;
  EMAIL_MOCK_MODE?: string;
  BROWSER_MOCK_MODE?: string;
  EXA_MOCK_MODE?: string;
  FIRECRAWL_API_KEY?: string;
  FIRECRAWL_WEBHOOK_SECRET?: string;
}

export interface NormalizedRssItem {
  feed_language: FeedLanguage;
  title: string;
  url: string;
  source: string | null;
  snippet: string | null;
  published_at: string | null;
}

export interface StoredAlertItem extends NormalizedRssItem {
  id: number;
  fetched_at: string;
  item_hash: string;
  status: string;
  is_relevant: number;
  confidence: number | null;
  country: "CH" | "other" | "unknown" | null;
  location_text: string | null;
  event_type: string | null;
  summary: string | null;
  reason: string | null;
  ai_raw: string | null;
  email_sent: number;
  email_sent_at: string | null;
  outage_event_id: number | null;
  event_linked_at: string | null;
  source_observation_id?: number | null;
  created_at: string;
  updated_at: string;
}

export interface AiClassification {
  is_relevant: boolean;
  confidence: number;
  country: "CH" | "other" | "unknown";
  location_text: string;
  event_type:
    | "power_outage"
    | "grid_disturbance"
    | "planned_outage"
    | "unclear"
    | "not_relevant";
  summary: string;
  reason: string;
}

export interface AiClassificationResult {
  parsed: AiClassification | null;
  raw: string;
  error?: string;
}

export type IncidentFalsePositiveType =
  | "none"
  | "telecom"
  | "article_context"
  | "crossword"
  | "historic"
  | "other";

export interface IncidentValidity {
  is_actual_outage_incident: boolean;
  false_positive_type: IncidentFalsePositiveType;
  reason: string;
}

export interface WorkflowRunSummary {
  runId: number;
  skipped?: boolean;
  itemsSeen: number;
  itemsNew: number;
  itemsFiltered: number;
  itemsClassified: number;
  emailsSent: number;
  sourcesChecked?: number;
  observationsSeen?: number;
  observationsNew?: number;
  firecrawlCreditsEstimated?: number;
  errors: string[];
}

export type OutageEventStatus = "needs_review" | "corroborated" | "dismissed" | "resolved";
export type OutageNature = "planned" | "unplanned" | "unknown";
export type ResearchStatus = "not_started" | "running" | "completed" | "failed";
export type EvidenceLevel = "weak" | "plausible" | "corroborated" | "official";
export type SourceKind = "official" | "local_media" | "national_media" | "operator" | "aggregator" | "other";
export type PublicStatus = "hidden" | "public_auto" | "public_verified";
export type VerificationLevel = "auto_analyzed" | "official_source" | "admin_verified";
export type EventQualityState = "candidate_only" | "publishable" | "needs_review" | "rejected";
export type PublicTrust = "official" | "corroborated" | "reported";
export type TimeConfidence = "exact" | "reported" | "inferred" | "unknown";
export type GeoPlaceType = "canton" | "district" | "municipality" | "locality" | "postcode" | "street";
export type EventPlaceRole = "affected" | "possibly_affected" | "context" | "operator_area" | "dismissed";
export type LocationGranularity =
  | "address"
  | "street"
  | "municipality"
  | "district"
  | "region"
  | "canton"
  | "country"
  | "unknown";
export type RelevanceRole =
  | "primary_report"
  | "official_notice"
  | "incident_update"
  | "incidental_mention"
  | "background"
  | "foreign_event"
  | "unknown";
export type OutageFactType =
  | "outage_happened"
  | "planned_outage_notice"
  | "location"
  | "start_time"
  | "end_time"
  | "status"
  | "planned_nature"
  | "cause"
  | "affected_area";
export type CauseCategory =
  | "planned_maintenance"
  | "weather"
  | "tree_or_overhead_line"
  | "construction_damage"
  | "cable_damage"
  | "transformer_or_substation"
  | "technical_fault"
  | "fire"
  | "overload"
  | "third_party_damage"
  | "water_or_flooding"
  | "unknown";

export interface OutageEvent {
  id: number;
  title: string;
  status: OutageEventStatus;
  event_type: AiClassification["event_type"];
  location_text: string | null;
  normalized_location: string | null;
  canton: string | null;
  country: "CH" | "other" | "unknown" | null;
  first_seen_at: string;
  last_seen_at: string;
  received_at?: string | null;
  started_at_estimate: string | null;
  resolved_at_estimate: string | null;
  last_confirmed_active_at?: string | null;
  expected_restore_at?: string | null;
  resolution_earliest_at?: string | null;
  resolution_latest_at?: string | null;
  time_confidence?: TimeConfidence | null;
  summary: string | null;
  reason: string | null;
  confidence: number;
  source_count: number;
  primary_source_url: string | null;
  primary_source_title: string | null;
  email_sent: number;
  email_sent_at: string | null;
  update_email_sent_at: string | null;
  merged_into_event_id: number | null;
  admin_note: string | null;
  outage_nature: OutageNature | null;
  cause_category: CauseCategory | null;
  cause_text: string | null;
  research_status: ResearchStatus | null;
  research_started_at: string | null;
  research_finished_at: string | null;
  research_summary_de: string | null;
  fact_confidence: number | null;
  event_score: number | null;
  evidence_level: EvidenceLevel | null;
  fact_sheet_json: string | null;
  fact_sheet_updated_at: string | null;
  auto_research_started_at: string | null;
  mail_decision_reason: string | null;
  public_status: PublicStatus | null;
  verification_level: VerificationLevel | null;
  location_granularity: LocationGranularity | null;
  event_quality_state: EventQualityState | null;
  created_at: string;
  updated_at: string;
}

export interface OutageSource {
  id: number;
  outage_event_id: number;
  alert_item_id: number;
  source_url: string;
  source_title: string;
  source_name: string | null;
  published_at: string | null;
  relation_score: number;
  is_primary: number;
  source_kind: SourceKind | null;
  source_weight: number | null;
  is_official: number | null;
  independence_key: string | null;
  source_registry_id?: number | null;
  source_observation_id?: number | null;
  created_at: string;
}

export interface PublicCanonicalSource {
  publisher: string;
  url: string;
  domain: string;
}

export interface PublicationDecision {
  publishable: boolean;
  trust: PublicTrust | null;
  reasons: string[];
  summary: string | null;
  primary_source: PublicCanonicalSource | null;
}

export interface PublicFeedItem {
  id: number;
  location: string;
  canton: string | null;
  url: string;
  received_at: string;
  started_at: string | null;
  resolved_at: string | null;
  status: "upcoming" | "active" | "resolved" | "stale_unconfirmed" | "historical" | null;
  nature: OutageNature;
  duration_minutes: number | null;
  active_since_at?: string | null;
  active_since_is_minimum?: boolean;
  last_confirmed_active_at?: string | null;
  expected_restore_at?: string | null;
  resolution_earliest_at?: string | null;
  resolution_latest_at?: string | null;
  time_confidence?: TimeConfidence;
  cause: string | null;
  affected_area: string | null;
  updated_at: string;
  summary: string;
  trust: PublicTrust;
  source: PublicCanonicalSource;
  /** Cached geo.admin pin when available (from event_public_locations). */
  latitude?: number | null;
  longitude?: number | null;
  map_precision?: "address" | "locality" | "municipality" | "district" | "region" | null;
  /** Filled by the public projection: the operator profile behind the primary source. */
  operator_slug?: string | null;
  operator_name?: string | null;
  /** Filled by the public projection: affected municipalities/localities (for place pages). */
  places?: Array<{ slug: string; name: string }>;
}

export interface SourceSnapshot {
  id: number;
  alert_item_id: number | null;
  outage_event_id: number | null;
  outage_source_id: number | null;
  url: string;
  final_url: string | null;
  fetch_method: string;
  fetch_status: "success" | "failed";
  http_status: number | null;
  title: string | null;
  markdown_r2_key: string | null;
  markdown_excerpt: string | null;
  content_hash: string | null;
  fetched_at: string;
  error: string | null;
  public_summary_de: string | null;
  public_key_points_json: string | null;
  public_relevance_label: "main" | "supporting" | "context" | "unclear" | null;
  public_facts_json: string | null;
  digest_generated_at: string | null;
  digest_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRegistryEntry {
  id: number;
  source_key: string;
  operator_name: string;
  source_type: SourceRegistryType;
  source_category: SourceRegistryCategory;
  url: string;
  area_text: string;
  trust_level: SourceTrustLevel;
  check_interval_minutes: number;
  priority: number;
  adapter_config_json: string | null;
  firecrawl_enabled: number;
  firecrawl_monitor_id: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  health_status: SourceHealthStatus;
  transport_status?: SourceTransportStatus;
  parser_status?: SourceParserStatus;
  last_observation_at?: string | null;
  consecutive_failures: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SourceObservation {
  id: number;
  source_registry_id: number | null;
  source_key: string;
  source_type: SourceRegistryType;
  operator_name: string | null;
  observation_hash: string;
  canonical_status: CanonicalObservationStatus;
  event_type: AiClassification["event_type"];
  title: string;
  url: string;
  location_text: string | null;
  area_text: string | null;
  started_at: string | null;
  resolved_at: string | null;
  observed_at: string;
  published_at: string | null;
  evidence_excerpt: string;
  raw_payload_json: string | null;
  extractor_version: string;
  confidence: number;
  independence_key: string | null;
  alert_item_id: number | null;
  outage_event_id: number | null;
  created_at: string;
}

export interface SourceObservationInput {
  sourceRegistryId: number | null;
  sourceKey: string;
  sourceType: SourceRegistryType;
  operatorName: string | null;
  observationHash: string;
  canonicalStatus: CanonicalObservationStatus;
  eventType: AiClassification["event_type"];
  title: string;
  url: string;
  locationText: string | null;
  areaText: string | null;
  startedAt: string | null;
  resolvedAt: string | null;
  observedAt: string;
  publishedAt: string | null;
  evidenceExcerpt: string;
  rawPayloadJson: string | null;
  extractorVersion: string;
  confidence: number;
  independenceKey: string | null;
}

export interface OutageCandidate {
  id: number;
  alert_item_id: number;
  snapshot_id: number | null;
  status: "new" | "extracted" | "rejected" | "event_linked" | "needs_admin";
  location_text: string | null;
  location_granularity: LocationGranularity | null;
  is_ch_incident: number;
  event_type: AiClassification["event_type"];
  relevance_role: RelevanceRole | null;
  quality_score: number;
  quality_reasons_json: string | null;
  rejection_reason: string | null;
  outage_event_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface OutageFact {
  id: number;
  candidate_id: number | null;
  outage_event_id: number | null;
  outage_source_id: number | null;
  snapshot_id: number | null;
  fact_type: OutageFactType;
  value_text: string;
  value_json: string | null;
  confidence: number;
  evidence_excerpt: string;
  source_role: string | null;
  verified_by: VerificationLevel | "auto" | null;
  source_observation_id?: number | null;
  /** Legacy provenance resolved through candidate -> alert item. */
  alert_item_id?: number | null;
  observed_at?: string | null;
  extractor_version?: string | null;
  created_at: string;
}

export interface GeoPlace {
  id: number;
  external_id: string;
  country: string;
  canton_key: string | null;
  canton_code: string | null;
  canton_name: string | null;
  district_key: string | null;
  district_name: string | null;
  municipality_key: string | null;
  municipality_name: string | null;
  locality_key: string | null;
  locality_name: string | null;
  postcode: string | null;
  street_name: string | null;
  place_type: GeoPlaceType;
  canonical_name: string;
  normalized_name: string;
  parent_external_id: string | null;
  source: string;
  source_updated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GeoPlaceAlias {
  id: number;
  place_id: number;
  alias: string;
  normalized_alias: string;
  language: string | null;
  source: string;
  created_at: string;
}

export interface GeoAliasCatalogRow extends GeoPlace {
  alias: string;
  normalized_alias: string;
}

export interface SourcePlaceMention {
  id: number;
  outage_source_id: number | null;
  alert_item_id: number | null;
  outage_event_id: number | null;
  raw_text: string;
  matched_text: string | null;
  place_id: number | null;
  place_type: GeoPlaceType | null;
  role: EventPlaceRole;
  confidence: number;
  match_method: string;
  evidence_quote: string | null;
  created_at: string;
}

export interface EventPlace {
  id: number;
  outage_event_id: number;
  place_id: number;
  role: EventPlaceRole;
  confidence: number;
  source_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
  place?: GeoPlace;
}

export interface CandidateFactInput {
  fact_type: OutageFactType;
  value_text: string;
  value_json?: string | null;
  confidence: number;
  evidence_excerpt: string;
  source_role?: string | null;
  verified_by?: VerificationLevel | "auto" | null;
  source_observation_id?: number | null;
  observed_at?: string | null;
  extractor_version?: string | null;
}

export interface CandidateAssessment {
  publishable: boolean;
  needs_admin: boolean;
  is_ch_incident: boolean;
  location_text: string;
  location_granularity: LocationGranularity;
  event_type: AiClassification["event_type"];
  relevance_role: RelevanceRole;
  quality_score: number;
  quality_reasons: string[];
  rejection_reason: string | null;
  outage_nature: OutageNature;
  status: "active" | "resolved" | "unknown";
  summary_de: string;
  facts: CandidateFactInput[];
}

export interface ResearchAssessment {
  outage_nature: OutageNature;
  cause_category: CauseCategory;
  cause_text: string;
  status: "active" | "resolved" | "unknown";
  research_summary_de: string;
  fact_confidence: number;
}

export interface FactSheet {
  location: string;
  time_window: {
    first_seen_at: string;
    last_seen_at: string;
    duration_label: string;
  };
  outage_nature: OutageNature;
  cause_category: CauseCategory;
  cause_text: string;
  status: "active" | "resolved" | "unknown";
  confirmed_facts: string[];
  open_questions: string[];
  summary_de: string;
  source_assessment: string;
  source_count: number;
  independent_source_count: number;
  official_source_count: number;
  generated_at: string;
}

export interface SourcePublicDigest {
  summary_de: string;
  key_points: string[];
  relevance_label: "main" | "supporting" | "context" | "unclear";
  facts: {
    location?: string;
    time?: string;
    cause?: string;
    status?: string;
    affected_area?: string;
  };
}

export interface MergeAssessment {
  same_event: boolean;
  confidence: number;
  reason: string;
  risk: string;
}

export interface EventMergeSuggestion {
  id: number;
  source_event_id: number;
  target_event_id: number;
  heuristic_score: number;
  ai_confidence: number | null;
  same_event: number;
  reason: string | null;
  status: "open" | "accepted" | "dismissed";
  created_at: string;
  updated_at: string;
}

export interface CheckAlertFeedsParams {
  manual?: boolean;
  cron?: string;
  scheduledTime?: number;
  requestedAt?: string;
  revalidatePublicEvents?: boolean;
  apply?: boolean;
  limit?: number;
}
