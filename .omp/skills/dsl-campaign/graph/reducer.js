export const PROJECTION_SCHEMA_VERSION = 2

export function eventAffectsProjection(eventType) {
  return typeof eventType === 'string' && eventType.length > 0
}

const TERMINAL_TASKS = ['succeeded', 'failed-final', 'cancelled', 'superseded', 'stale', 'invalid-output']

export const AGGREGATE_STATES = Object.freeze({
  run: ['planned', 'active', 'paused', 'reconciliation-required', 'completed', 'aborted', 'superseded', 'failed-final'],
  task: ['pending', 'ready', 'running', ...TERMINAL_TASKS],
  attempt: ['allocated', 'running', 'succeeded', 'retryable-failure', 'failed-final', 'stale', 'invalid-output'],
  lease: ['allocated', 'active', 'expired', 'released', 'superseded'],
  checkpoint: ['none', 'recorded'],
  decision: ['open', 'answered', 'superseded'],
  finding: ['open', 'resolved', 'rebutted', 'superseded'],
  certificate: ['provisional', 'certified', 'invalidated', 'refuted'],
  'apply-transaction': ['planned', 'applying', 'applied', 'verified', 'reconciliation-required', 'rolled-back', 'failed-final'],
})

export const AGGREGATE_EVENTS = Object.freeze({
  run: ['run-created', 'run-started', 'run-paused', 'run-resumed', 'run-completed', 'run-aborted', 'run-superseded', 'run-failed', 'repository-mismatch'],
  task: ['task-created', 'task-ready', 'task-started', 'task-succeeded', 'task-failed-final', 'task-cancelled', 'task-superseded', 'task-stale', 'task-invalid-output'],
  attempt: ['attempt-allocated', 'attempt-started', 'attempt-succeeded', 'attempt-retryable-failure', 'attempt-failed-final', 'attempt-stale', 'attempt-invalid-output'],
  lease: ['lease-allocated', 'lease-activated', 'lease-expired', 'lease-released', 'lease-superseded'],
  checkpoint: ['checkpoint-recorded'],
  decision: ['decision-opened', 'decision-answered', 'decision-superseded'],
  finding: ['finding-opened', 'finding-resolved', 'finding-rebutted', 'finding-superseded'],
  certificate: ['certificate-provisional', 'certificate-certified', 'certificate-invalidated', 'certificate-refuted'],
  'apply-transaction': ['apply-planned', 'apply-started', 'apply-recorded', 'apply-verified', 'apply-reconciliation-required', 'apply-rolled-back', 'apply-failed-final'],
})

const RULES = {
  run: {
    'run-created': { from: ['planned'], to: 'planned' }, 'run-started': { from: ['planned', 'paused'], to: 'active' },
    'run-paused': { from: ['planned', 'active'], to: 'paused' }, 'run-resumed': { from: ['paused'], to: 'active' },
    'run-completed': { from: ['active'], to: 'completed' }, 'run-aborted': { from: ['planned', 'active', 'paused'], to: 'aborted' },
    'run-superseded': { from: ['planned', 'active', 'paused', 'reconciliation-required'], to: 'superseded' },
    'run-failed': { from: ['planned', 'active', 'paused', 'reconciliation-required'], to: 'failed-final' },
    'repository-mismatch': { from: ['planned', 'active', 'paused'], to: 'reconciliation-required', emitted: ['certificate-descendants-invalidated'] },
  },
  task: Object.fromEntries([
    ['task-created', ['pending'], 'pending'], ['task-ready', ['pending'], 'ready'], ['task-started', ['ready'], 'running'],
    ['task-succeeded', ['running'], 'succeeded'], ['task-failed-final', ['pending', 'ready', 'running'], 'failed-final'],
    ['task-cancelled', ['pending', 'ready', 'running'], 'cancelled'], ['task-superseded', ['pending', 'ready', 'running'], 'superseded'],
    ['task-stale', ['pending', 'ready', 'running'], 'stale'], ['task-invalid-output', ['running'], 'invalid-output'],
  ].map(([event, from, to]) => [event, { from, to }])),
  attempt: Object.fromEntries([
    ['attempt-allocated', ['allocated'], 'allocated'], ['attempt-started', ['allocated'], 'running'],
    ['attempt-succeeded', ['running'], 'succeeded'], ['attempt-retryable-failure', ['running'], 'retryable-failure'],
    ['attempt-failed-final', ['allocated', 'running', 'retryable-failure'], 'failed-final'],
    ['attempt-stale', ['allocated', 'running', 'retryable-failure'], 'stale'], ['attempt-invalid-output', ['running'], 'invalid-output'],
  ].map(([event, from, to]) => [event, { from, to }])),
  lease: Object.fromEntries([
    ['lease-allocated', ['allocated'], 'allocated'], ['lease-activated', ['allocated'], 'active'],
    ['lease-expired', ['allocated', 'active'], 'expired'], ['lease-released', ['allocated', 'active'], 'released'],
    ['lease-superseded', ['allocated', 'active'], 'superseded'],
  ].map(([event, from, to]) => [event, { from, to }])),
  checkpoint: { 'checkpoint-recorded': { from: ['none', 'recorded'], to: 'recorded', checkpoint: true } },
  decision: {
    'decision-opened': { from: ['open'], to: 'open' }, 'decision-answered': { from: ['open'], to: 'answered' },
    'decision-superseded': { from: ['open', 'answered'], to: 'superseded' },
  },
  finding: {
    'finding-opened': { from: ['open'], to: 'open' }, 'finding-resolved': { from: ['open'], to: 'resolved' },
    'finding-rebutted': { from: ['open'], to: 'rebutted' }, 'finding-superseded': { from: ['open'], to: 'superseded' },
  },
  certificate: {
    'certificate-provisional': { from: ['provisional'], to: 'provisional' }, 'certificate-certified': { from: ['provisional'], to: 'certified' },
    'certificate-invalidated': { from: ['provisional', 'certified'], to: 'invalidated', emitted: ['certificate-descendants-invalidated'] },
    'certificate-refuted': { from: ['provisional', 'certified'], to: 'refuted', emitted: ['certificate-descendants-invalidated'] },
  },
  'apply-transaction': Object.fromEntries([
    ['apply-planned', ['planned'], 'planned'], ['apply-started', ['planned'], 'applying'], ['apply-recorded', ['applying'], 'applied'],
    ['apply-verified', ['applied'], 'verified'], ['apply-reconciliation-required', ['applying', 'applied'], 'reconciliation-required'],
    ['apply-rolled-back', ['applying', 'applied', 'reconciliation-required'], 'rolled-back'],
    ['apply-failed-final', ['planned', 'applying', 'applied', 'reconciliation-required'], 'failed-final'],
  ].map(([event, from, to]) => [event, { from, to }])),
}

export const TRANSITION_MATRIX = Object.freeze(Object.fromEntries(
  Object.entries(AGGREGATE_STATES).map(([kind, states]) => [
    kind,
    Object.fromEntries(states.map(state => [
      state,
      Object.fromEntries(AGGREGATE_EVENTS[kind].map(event => [
        event,
        RULES[kind][event]?.from.includes(state) ? RULES[kind][event].to : null,
      ])),
    ])),
  ]),
))

function result(classification, currentState, nextState, emittedEvents, reason) {
  return { classification, next_state: classification === 'accepted' ? nextState : currentState, emitted_events: emittedEvents, reason }
}

function validPayload(payload) { return payload && Object.getPrototypeOf(payload) === Object.prototype }

export function transition(aggregateKind, currentState, eventType, payload) {
  try {
    if (!AGGREGATE_STATES[aggregateKind]) return result('rejected', currentState, currentState, [], 'unknown aggregate kind')
    if (!AGGREGATE_STATES[aggregateKind].includes(currentState)) return result('rejected', currentState, currentState, [], 'unknown current state')
    if (!AGGREGATE_EVENTS[aggregateKind].includes(eventType)) return result('rejected', currentState, currentState, [], 'unknown event type')
    if (!validPayload(payload)) return result('rejected', currentState, currentState, [], 'malformed payload')
    if (payload.expected_state !== undefined && payload.expected_state !== currentState) return result('stale', currentState, currentState, [], 'expected state mismatch')
    const rule = RULES[aggregateKind][eventType]
    const next = TRANSITION_MATRIX[aggregateKind][currentState][eventType]
    if (next === null) {
      if (rule.to === currentState) return result('idempotent', currentState, currentState, [], 'already applied')
      return result('rejected', currentState, currentState, [], 'transition not allowed')
    }
    if (rule.checkpoint) {
      if (!Number.isInteger(payload.sequence) || payload.sequence < 1 || typeof payload.hash !== 'string' || !/^[a-f0-9]{64}$/.test(payload.hash)) {
        return result('rejected', currentState, currentState, [], 'invalid checkpoint sequence or hash')
      }
      if (currentState === 'recorded') {
        if (payload.previous_sequence === payload.sequence && payload.previous_hash === payload.hash) return result('idempotent', currentState, currentState, [], 'checkpoint already recorded')
        if (Number.isInteger(payload.previous_sequence) && payload.sequence <= payload.previous_sequence) return result('stale', currentState, currentState, [], 'checkpoint is stale')
        if (payload.previous_hash && payload.expected_previous_hash !== payload.previous_hash) return result('rejected', currentState, currentState, [], 'checkpoint hash chain mismatch')
      }
    }
    if (aggregateKind === 'lease' && eventType === 'lease-expired') {
      const now = Date.parse(payload.now)
      const expires = Date.parse(payload.expires_at)
      if (!Number.isFinite(now) || !Number.isFinite(expires)) return result('rejected', currentState, currentState, [], 'invalid lease timestamps')
      if (now < expires) return result('stale', currentState, currentState, [], 'lease is still live')
    }
    if (next === currentState) return result('idempotent', currentState, currentState, [], 'already applied')
    return result('accepted', currentState, next, rule.emitted || [], 'transition accepted')
  } catch {
    return result('rejected', currentState, currentState, [], 'malformed payload')
  }
}

export { TERMINAL_TASKS }
