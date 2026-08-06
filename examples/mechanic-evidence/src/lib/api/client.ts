import type {
  AuthorizedSourceExcerpt,
  BrowserSafeText,
  CampaignProgress,
  CampaignSummary,
  CommitNotice,
  DecisionReceipt,
  FormalizationSummary,
  GraphEdge,
  GraphEvent,
  GraphNodeSummary,
  GraphSnapshot,
  InspectorRecord,
  MechanicGraphClient,
  NodeDetail,
  ProjectionDelta,
  ReviewDecisionInput,
  ReviewItem,
  ReviewKind,
  GlobalGraphSnapshot,
  GraphInvalidation,
  GraphSnapshotQuery,
} from "./types.js";

const API_ROOT = "/api/v1";
const REVIEW_KINDS: Record<ReviewKind, true> = {
  "formalization-exception": true,
  "blocking-decision": true,
  "apply-reconciliation": true,
};
const TEXT_CLASSIFICATIONS: Record<BrowserSafeText["classification"], true> = {
  identifier: true,
  status: true,
  "community-authored": true,
};
const AUTHORITIES: Record<GraphEdge["authority"], true> = {
  discovery: true,
  provisional: true,
  authoritative: true,
  unknown: true,
};

export class MechanicGraphApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Mechanic graph request failed (${status}, ${code})`);
    this.name = "MechanicGraphApiError";
  }
}

export class UnsafeProjectionError extends Error {
  constructor(readonly field: string) {
    super(`Projection rejected: forbidden source field '${field}'`);
    this.name = "UnsafeProjectionError";
  }
}

type JsonObject = Record<string, unknown>;
type FetchLike = typeof fetch;
interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}
type EventSourceFactory = (url: string) => EventSourceLike;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, at: string): JsonObject {
  if (!isObject(value)) throw new TypeError(`Invalid ${at}: expected object`);
  return value;
}

function field(record: JsonObject, camel: string, snake: string = camel): unknown {
  return record[camel] ?? record[snake];
}

function string(value: unknown, at: string): string {
  if (typeof value !== "string") throw new TypeError(`Invalid ${at}: expected string`);
  return value;
}

function nullableString(value: unknown, at: string): string | null {
  if (value === null || value === undefined) return null;
  return string(value, at);
}

function number(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Invalid ${at}: expected finite number`);
  }
  return value;
}

function integer(value: unknown, at: string): number {
  const decoded = number(value, at);
  if (!Number.isInteger(decoded) || decoded < 0) {
    throw new TypeError(`Invalid ${at}: expected non-negative integer`);
  }
  return decoded;
}

function boolean(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`Invalid ${at}: expected boolean`);
  return value;
}

function array(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`Invalid ${at}: expected array`);
  return value;
}

function stringArray(value: unknown, at: string): string[] {
  return array(value, at).map((item, index) => string(item, `${at}[${index}]`));
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "");
}

function isForbiddenSourceKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (
    normalized === "rawtext" ||
    normalized === "sourcetext" ||
    normalized === "sourceexcerpt" ||
    normalized === "sourceclausetext"
  ) {
    return true;
  }
  return (
    (normalized.startsWith("raw") && /(text|prose|excerpt|clause)/.test(normalized)) ||
    (normalized.startsWith("source") && /(text|prose|excerpt|clausetext|clausebody)/.test(normalized))
  );
}

export function assertBrowserSafePayload(value: unknown): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (!isObject(current)) continue;
    for (const [key, child] of Object.entries(current)) {
      if (isForbiddenSourceKey(key)) throw new UnsafeProjectionError(key);
      pending.push(child);
    }
  }
}

function safeText(value: unknown, at: string): BrowserSafeText {
  const record = object(value, at);
  const classification = string(record.classification, `${at}.classification`);
  if (!(classification in TEXT_CLASSIFICATIONS)) {
    throw new TypeError(`Invalid ${at}.classification`);
  }
  return {
    value: string(record.value, `${at}.value`),
    classification: classification as BrowserSafeText["classification"],
  };
}

function stateCounts(value: unknown, at: string): Record<string, number> {
  const record = object(value, at);
  return Object.fromEntries(
    Object.entries(record).map(([state, count]) => [state, integer(count, `${at}.${state}`)]),
  );
}

function assertStateTotal(states: Record<string, number>, total: number, at: string): void {
  const stateTotal = Object.values(states).reduce((sum, count) => sum + count, 0);
  if (stateTotal !== total) {
    throw new UnsafeProjectionError(`${at}: state counts do not match total`);
  }
}


function campaignProgress(value: unknown, at = "campaignProgress"): CampaignProgress {
  const record = object(value, at);
  const taskStates = stateCounts(field(record, "taskStates", "task_states"), `${at}.taskStates`);
  const taskTotal = integer(field(record, "taskTotal", "task_total"), `${at}.taskTotal`);
  assertStateTotal(taskStates, taskTotal, `${at}.tasks`);
  const claimStates = stateCounts(field(record, "claimStates", "claim_states"), `${at}.claimStates`);
  const claimTotal = integer(field(record, "claimTotal", "claim_total"), `${at}.claimTotal`);
  assertStateTotal(claimStates, claimTotal, `${at}.claims`);
  const findingStates = stateCounts(
    field(record, "findingStates", "finding_states"),
    `${at}.findingStates`,
  );
  const findingTotal = integer(field(record, "findingTotal", "finding_total"), `${at}.findingTotal`);
  assertStateTotal(findingStates, findingTotal, `${at}.findings`);
  const checkStates = stateCounts(field(record, "checkStates", "check_states"), `${at}.checkStates`);
  const checkTotal = integer(field(record, "checkTotal", "check_total"), `${at}.checkTotal`);
  assertStateTotal(checkStates, checkTotal, `${at}.checks`);
  return {
    runId: string(field(record, "runId", "run_id"), `${at}.runId`),
    campaignId: string(field(record, "campaignId", "campaign_id"), `${at}.campaignId`),
    state: string(record.state, `${at}.state`),
    kind: nullableString(record.kind, `${at}.kind`),
    target: nullableString(record.target, `${at}.target`),
    started: nullableString(record.started, `${at}.started`),
    finished: nullableString(record.finished, `${at}.finished`),
    taskStates,
    taskTotal,
    claimStates,
    claimTotal,
    findingStates,
    findingTotal,
    checkStates,
    checkTotal,
  };
}

function campaign(value: unknown, at = "campaign"): CampaignSummary {
  const record = object(value, at);
  const outcomes = object(record.outcomes, `${at}.outcomes`);
  const knownTasks = object(field(record, "knownTasks", "known_tasks"), `${at}.knownTasks`);
  const checks = object(
    field(record, "currentVersionChecks", "current_version_checks"),
    `${at}.currentVersionChecks`,
  );
  const rawShapeRound = field(record, "shapeRound", "shape_round");
  let shapeRound: CampaignSummary["shapeRound"] = null;
  if (rawShapeRound !== null && rawShapeRound !== undefined) {
    const shape = object(rawShapeRound, `${at}.shapeRound`);
    shapeRound = {
      current: integer(shape.current, `${at}.shapeRound.current`),
      maximum: integer(shape.maximum, `${at}.shapeRound.maximum`),
    };
  }

  const denominator = string(knownTasks.denominator, `${at}.knownTasks.denominator`);
  if (denominator !== "dynamic") throw new TypeError(`Invalid ${at}.knownTasks.denominator`);

  return {
    campaignId: string(field(record, "campaignId", "campaign_id"), `${at}.campaignId`),
    runId: string(field(record, "runId", "run_id"), `${at}.runId`),
    state: string(record.state, `${at}.state`),
    terminalWorklist: integer(
      field(record, "terminalWorklist", "terminal_worklist"),
      `${at}.terminalWorklist`,
    ),
    worklistSize: integer(field(record, "worklistSize", "worklist_size"), `${at}.worklistSize`),
    outcomes: {
      converged: integer(outcomes.converged, `${at}.outcomes.converged`),
      improved: integer(outcomes.improved, `${at}.outcomes.improved`),
      needsSchema: integer(
        field(outcomes, "needsSchema", "needs_schema"),
        `${at}.outcomes.needsSchema`,
      ),
      abandoned: integer(outcomes.abandoned, `${at}.outcomes.abandoned`),
      inProgress: integer(
        field(outcomes, "inProgress", "in_progress"),
        `${at}.outcomes.inProgress`,
      ),
      pending: integer(outcomes.pending, `${at}.outcomes.pending`),
    },
    knownTasks: {
      completed: integer(knownTasks.completed, `${at}.knownTasks.completed`),
      total: integer(knownTasks.total, `${at}.knownTasks.total`),
      denominator: "dynamic",
    },
    activeTasks: integer(field(record, "activeTasks", "active_tasks"), `${at}.activeTasks`),
    blockingDecisions: integer(
      field(record, "blockingDecisions", "blocking_decisions"),
      `${at}.blockingDecisions`,
    ),
    openFindings: integer(field(record, "openFindings", "open_findings"), `${at}.openFindings`),
    currentVersionChecks: {
      passed: integer(checks.passed, `${at}.currentVersionChecks.passed`),
      total: integer(checks.total, `${at}.currentVersionChecks.total`),
    },
    shapeRound,
    lastSequence: integer(field(record, "lastSequence", "last_sequence"), `${at}.lastSequence`),
    lastEventAt: nullableString(
      field(record, "lastEventAt", "last_event_at"),
      `${at}.lastEventAt`,
    ),
    updatedAt: string(field(record, "updatedAt", "updated_at"), `${at}.updatedAt`),
  };
}

function node(value: unknown, at: string): GraphNodeSummary {
  const record = object(value, at);
  const rawSummary = record.summary;
  return {
    nodeId: string(field(record, "nodeId", "node_id"), `${at}.nodeId`),
    campaignId: string(field(record, "campaignId", "campaign_id"), `${at}.campaignId`),
    kind: string(record.kind, `${at}.kind`),
    label: safeText(record.label, `${at}.label`),
    summary:
      rawSummary === null || rawSummary === undefined ? null : safeText(rawSummary, `${at}.summary`),
    state: nullableString(record.state, `${at}.state`),
    validity: nullableString(record.validity, `${at}.validity`),
  };
}

function edge(value: unknown, at: string): GraphEdge {
  const record = object(value, at);
  const rawAuthority = string(record.authority ?? "unknown", `${at}.authority`);
  return {
    edgeId: string(field(record, "edgeId", "edge_id"), `${at}.edgeId`),
    sourceNodeId: string(
      field(record, "sourceNodeId", "source_node_id"),
      `${at}.sourceNodeId`,
    ),
    targetNodeId: string(
      field(record, "targetNodeId", "target_node_id"),
      `${at}.targetNodeId`,
    ),
    kind: string(record.kind, `${at}.kind`),
    authority: rawAuthority in AUTHORITIES
      ? (rawAuthority as GraphEdge["authority"])
      : "unknown",
    state: nullableString(record.state, `${at}.state`),
  };
}

function inspectorRecord(value: unknown, at: string): InspectorRecord {
  const record = object(value, at);
  return {
    recordId: string(field(record, "recordId", "record_id"), `${at}.recordId`),
    kind: string(record.kind, `${at}.kind`),
    state: nullableString(record.state, `${at}.state`),
    label: safeText(record.label, `${at}.label`),
    fields: array(record.fields, `${at}.fields`).map((entry, index) => {
      const item = object(entry, `${at}.fields[${index}]`);
      return {
        name: string(item.name, `${at}.fields[${index}].name`),
        value: safeText(item.value, `${at}.fields[${index}].value`),
      };
    }),
  };
}

function graphEvent(value: unknown, at: string): GraphEvent {
  const record = object(value, at);
  return {
    sequence: integer(record.sequence, `${at}.sequence`),
    eventId: string(field(record, "eventId", "event_id"), `${at}.eventId`),
    type: string(record.type, `${at}.type`),
    category: string(record.category, `${at}.category`),
    occurredAt: string(field(record, "occurredAt", "occurred_at"), `${at}.occurredAt`),
    affectedNodeIds: stringArray(
      field(record, "affectedNodeIds", "affected_node_ids"),
      `${at}.affectedNodeIds`,
    ),
    summary: safeText(record.summary, `${at}.summary`),
    projectionChecksum: string(
      field(record, "projectionChecksum", "projection_checksum"),
      `${at}.projectionChecksum`,
    ),
  };
}

function reviewItem(value: unknown, at: string): ReviewItem | null {
  const record = object(value, at);
  const kind = string(record.kind, `${at}.kind`);
  if (!(kind in REVIEW_KINDS)) return null;
  const capabilities = object(record.capabilities, `${at}.capabilities`);
  const precondition = object(record.precondition, `${at}.precondition`);
  return {
    reviewId: string(field(record, "reviewId", "review_id"), `${at}.reviewId`),
    kind: kind as ReviewKind,
    state: string(record.state, `${at}.state`),
    title: safeText(record.title, `${at}.title`),
    summary: safeText(record.summary, `${at}.summary`),
    options: array(record.options, `${at}.options`).map((entry, index) => {
      const option = object(entry, `${at}.options[${index}]`);
      return {
        optionId: string(
          field(option, "optionId", "option_id"),
          `${at}.options[${index}].optionId`,
        ),
        label: safeText(option.label, `${at}.options[${index}].label`),
        description: safeText(option.description, `${at}.options[${index}].description`),
      };
    }),
    affectedNodeIds: stringArray(
      field(record, "affectedNodeIds", "affected_node_ids"),
      `${at}.affectedNodeIds`,
    ),
    capabilities: {
      canSubmit: boolean(
        field(capabilities, "canSubmit", "can_submit"),
        `${at}.capabilities.canSubmit`,
      ),
      canLoadSource: boolean(
        field(capabilities, "canLoadSource", "can_load_source"),
        `${at}.capabilities.canLoadSource`,
      ),
    },
    precondition: {
      sequence: integer(precondition.sequence, `${at}.precondition.sequence`),
      projectionChecksum: string(
        field(precondition, "projectionChecksum", "projection_checksum"),
        `${at}.precondition.projectionChecksum`,
      ),
    },
  };
}

function formalization(value: unknown, at: string): FormalizationSummary {
  const record = object(value, at);
  return {
    restriction: integer(record.restriction, `${at}.restriction`),
    timingOrder: integer(field(record, "timingOrder", "timing_order"), `${at}.timingOrder`),
    quantifier: integer(record.quantifier, `${at}.quantifier`),
    binding: integer(record.binding, `${at}.binding`),
    omissionInvention: integer(
      field(record, "omissionInvention", "omission_invention"),
      `${at}.omissionInvention`,
    ),
    sourceExtraction: integer(
      field(record, "sourceExtraction", "source_extraction"),
      `${at}.sourceExtraction`,
    ),
  };
}

export function decodeCampaigns(value: unknown): CampaignSummary[] {
  assertBrowserSafePayload(value);
  return array(value, "campaigns").map((entry, index) => campaign(entry, `campaigns[${index}]`));
}

export function decodeCampaignProgress(value: unknown): CampaignProgress[] {
  assertBrowserSafePayload(value);
  return array(value, "campaignProgress").map((entry, index) =>
    campaignProgress(entry, `campaignProgress[${index}]`),
  );
}

export function decodeSnapshot(value: unknown): GraphSnapshot {
  assertBrowserSafePayload(value);
  const record = object(value, "snapshot");
  const contractVersion = integer(
    field(record, "contractVersion", "contract_version"),
    "snapshot.contractVersion",
  );
  if (contractVersion !== 1) throw new TypeError("Unsupported snapshot contract version");
  return {
    contractVersion: 1,
    campaign: campaign(record.campaign),
    sequence: integer(record.sequence, "snapshot.sequence"),
    projectionChecksum: string(
      field(record, "projectionChecksum", "projection_checksum"),
      "snapshot.projectionChecksum",
    ),
    nodes: array(record.nodes, "snapshot.nodes").map((entry, index) =>
      node(entry, `snapshot.nodes[${index}]`),
    ),
    edges: array(record.edges, "snapshot.edges").map((entry, index) =>
      edge(entry, `snapshot.edges[${index}]`),
    ),
  };
}

export function decodeDelta(value: unknown): ProjectionDelta {
  assertBrowserSafePayload(value);
  const record = object(value, "delta");
  const contractVersion = integer(
    field(record, "contractVersion", "contract_version"),
    "delta.contractVersion",
  );
  if (contractVersion !== 1) throw new TypeError("Unsupported delta contract version");
  const reviews = array(field(record, "reviewQueue", "review_queue"), "delta.reviewQueue")
    .map((entry, index) => reviewItem(entry, `delta.reviewQueue[${index}]`))
    .filter((entry): entry is ReviewItem => entry !== null);
  return {
    contractVersion: 1,
    fromSequence: integer(
      field(record, "fromSequence", "from_sequence"),
      "delta.fromSequence",
    ),
    throughSequence: integer(
      field(record, "throughSequence", "through_sequence"),
      "delta.throughSequence",
    ),
    projectionChecksum: string(
      field(record, "projectionChecksum", "projection_checksum"),
      "delta.projectionChecksum",
    ),
    campaign: campaign(record.campaign),
    upsertNodes: array(field(record, "upsertNodes", "upsert_nodes"), "delta.upsertNodes").map(
      (entry, index) => node(entry, `delta.upsertNodes[${index}]`),
    ),
    removeNodeIds: stringArray(
      field(record, "removeNodeIds", "remove_node_ids"),
      "delta.removeNodeIds",
    ),
    upsertEdges: array(field(record, "upsertEdges", "upsert_edges"), "delta.upsertEdges").map(
      (entry, index) => edge(entry, `delta.upsertEdges[${index}]`),
    ),
    removeEdgeIds: stringArray(
      field(record, "removeEdgeIds", "remove_edge_ids"),
      "delta.removeEdgeIds",
    ),
    events: array(record.events, "delta.events").map((entry, index) =>
      graphEvent(entry, `delta.events[${index}]`),
    ),
    reviewQueue: reviews,
    formalization: formalization(record.formalization, "delta.formalization"),
    status: typeof record.status === "string" ? record.status : undefined,
  };
}

export function decodeNodeDetail(value: unknown): NodeDetail {
  assertBrowserSafePayload(value);
  const record = object(value, "nodeDetail");
  const base = node(record, "nodeDetail");
  const records = (name: string): InspectorRecord[] =>
    array(record[name], `nodeDetail.${name}`).map((entry, index) =>
      inspectorRecord(entry, `nodeDetail.${name}[${index}]`),
    );
  return {
    ...base,
    contentHash: string(field(record, "contentHash", "content_hash"), "nodeDetail.contentHash"),
    lineageHash: string(field(record, "lineageHash", "lineage_hash"), "nodeDetail.lineageHash"),
    versions: array(record.versions, "nodeDetail.versions").map((entry, index) => {
      const version = object(entry, `nodeDetail.versions[${index}]`);
      return {
        name: string(version.name, `nodeDetail.versions[${index}].name`),
        value: safeText(version.value, `nodeDetail.versions[${index}].value`),
      };
    }),
    parentEdges: array(field(record, "parentEdges", "parent_edges"), "nodeDetail.parentEdges").map(
      (entry, index) => edge(entry, `nodeDetail.parentEdges[${index}]`),
    ),
    childEdges: array(field(record, "childEdges", "child_edges"), "nodeDetail.childEdges").map(
      (entry, index) => edge(entry, `nodeDetail.childEdges[${index}]`),
    ),
    leases: records("leases"),
    checkpoints: records("checkpoints"),
    findings: records("findings"),
    checks: records("checks"),
    invalidationReasons: array(
      field(record, "invalidationReasons", "invalidation_reasons"),
      "nodeDetail.invalidationReasons",
    ).map((entry, index) => safeText(entry, `nodeDetail.invalidationReasons[${index}]`)),
  };
}

export function decodeCommitNotice(value: unknown): CommitNotice {
  assertBrowserSafePayload(value);
  const record = object(value, "commitNotice");
  return {
    sequence: integer(record.sequence, "commitNotice.sequence"),
    projectionChecksum: string(
      field(record, "projectionChecksum", "projection_checksum"),
      "commitNotice.projectionChecksum",
    ),
  };
}

function decodeAuthorizedSource(value: unknown): AuthorizedSourceExcerpt {
  const record = object(value, "authorizedSource");
  return {
    reviewId: string(field(record, "reviewId", "review_id"), "authorizedSource.reviewId"),
    clauseId: string(field(record, "clauseId", "clause_id"), "authorizedSource.clauseId"),
    text: string(record.text, "authorizedSource.text"),
    expiresAt: string(field(record, "expiresAt", "expires_at"), "authorizedSource.expiresAt"),
  };
}

function decodeDecisionReceipt(value: unknown): DecisionReceipt {
  assertBrowserSafePayload(value);
  const record = object(value, "decisionReceipt");
  return {
    decisionNodeId: string(
      field(record, "decisionNodeId", "decision_node_id"),
      "decisionReceipt.decisionNodeId",
    ),
    acceptedSequence: integer(
      field(record, "acceptedSequence", "accepted_sequence"),
      "decisionReceipt.acceptedSequence",
    ),
    projectionChecksum: string(
      field(record, "projectionChecksum", "projection_checksum"),
      "decisionReceipt.projectionChecksum",
    ),
  };
}

async function errorFromResponse(response: Response): Promise<MechanicGraphApiError> {
  let code = response.status === 409 ? "stale" : "request-failed";
  try {
    const payload: unknown = await response.json();
    assertBrowserSafePayload(payload);
    if (isObject(payload) && typeof payload.code === "string") code = payload.code;
  } catch (error) {
    if (error instanceof UnsafeProjectionError) code = "unsafe-error-payload";
  }
  return new MechanicGraphApiError(response.status, code);
}

function decodeGlobalGraphSnapshot(value: unknown): GlobalGraphSnapshot {
  assertBrowserSafePayload(value);
  if (!isObject(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new UnsafeProjectionError("graph snapshot must contain node and edge arrays");
  }
  if (value.nodes.length > 400) throw new UnsafeProjectionError("graph snapshot exceeds 400-node cap");
  if (
    typeof value.graph_revision !== "string" ||
    typeof value.root !== "string" ||
    !isObject(value.page) ||
    typeof value.page.truncated !== "boolean" ||
    (value.page.next_cursor !== null && typeof value.page.next_cursor !== "string") ||
    !isObject(value.filters)
  ) {
    throw new UnsafeProjectionError("invalid graph snapshot contract");
  }
  for (const node of value.nodes) {
    if (
      !isObject(node) ||
      typeof node.id !== "string" ||
      typeof node.kind !== "string" ||
      typeof node.label !== "string" ||
      !Array.isArray(node.ability_refs) ||
      !Array.isArray(node.campaign_refs) ||
      !isObject(node.metadata)
    ) {
      throw new UnsafeProjectionError("invalid graph node");
    }
  }
  return value as unknown as GlobalGraphSnapshot;
}

function decodeGraphInvalidation(value: unknown): GraphInvalidation {
  assertBrowserSafePayload(value);
  if (
    !isObject(value) ||
    typeof value.graph_revision !== "string" ||
    !Number.isInteger(value.through) ||
    !Array.isArray(value.affected_ability_ids) ||
    !isObject(value.page)
  ) {
    throw new UnsafeProjectionError("invalid graph invalidation");
  }
  return value as unknown as GraphInvalidation;
}

function graphQuery(query: GraphSnapshotQuery, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({ mode: query.mode });
  for (const [key, value] of Object.entries({ ...query, ...extra })) {
    if (key === "mode" || value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  return params.toString();
}

export function createMechanicGraphClient(
  fetchImpl: FetchLike = fetch,
  eventSourceFactory: EventSourceFactory = (url) => new EventSource(url),
): MechanicGraphClient {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetchImpl(`${API_ROOT}${path}`, {
      ...init,
      headers: { Accept: "application/json", ...init.headers },
    });
    if (!response.ok) throw await errorFromResponse(response);
    return response.json() as Promise<unknown>;
  }

  return {
    async getCampaignProgress(signal) {
      return decodeCampaignProgress(await request("/campaigns", { signal }));
    },
    async getGraphSnapshot(query, signal) {
      return decodeGlobalGraphSnapshot(
        await request(`/graph/snapshot?${graphQuery(query)}`, { signal }),
      );
    },
    async getGraphUpdates(query, since, signal) {
      return decodeGraphInvalidation(
        await request(`/graph/updates?${graphQuery(query, { since })}`, { signal }),
      );
    },
    async getReviewSource(reviewId, signal) {
      return decodeAuthorizedSource(
        await request(`/reviews/${encodeURIComponent(reviewId)}/source`, { signal }),
      );
    },
    async submitDecision(input, signal) {
      const body = JSON.stringify({
        review_id: input.reviewId,
        option_id: input.optionId,
        rationale: input.rationale,
        affected_node_ids: input.affectedNodeIds,
        precondition: {
          sequence: input.precondition.sequence,
          projection_checksum: input.precondition.projectionChecksum,
        },
        client_request_id: input.clientRequestId,
      });
      return decodeDecisionReceipt(
        await request(`/reviews/${encodeURIComponent(input.reviewId)}/decisions`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
    },
    openGraphStream(query, onCommit, onDisconnect) {
      const stream = eventSourceFactory(`${API_ROOT}/graph/stream?${graphQuery(query)}`);
      let closed = false;
      stream.onmessage = (event) => {
        try {
          const value: unknown = JSON.parse(event.data);
          assertBrowserSafePayload(value);
          if (!isObject(value) || typeof value.graph_revision !== "string" || !Array.isArray(value.affected_ability_ids)) {
            throw new UnsafeProjectionError("invalid graph stream notice");
          }
          onCommit({
            graph_revision: value.graph_revision,
            affected_ability_ids: value.affected_ability_ids as Array<{ faction_id: string; ability_id: string }>,
          });
        } catch {
          if (!closed) {
            closed = true;
            stream.close();
            onDisconnect();
          }
        }
      };
      stream.onerror = () => {
        if (closed) return;
        closed = true;
        stream.close();
        onDisconnect();
      };
      return () => {
        closed = true;
        stream.close();
      };
    },
  };
}
