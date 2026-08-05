import assert from 'node:assert/strict'
import test from 'node:test'
import { AGGREGATE_EVENTS, AGGREGATE_STATES, TERMINAL_TASKS, TRANSITION_MATRIX, transition } from './reducer.js'

const KEYS = ['classification', 'next_state', 'emitted_events', 'reason']

test('transition matrix is total across every state and event', () => {
  for (const [kind, states] of Object.entries(AGGREGATE_STATES)) {
    for (const state of states) {
      assert.deepEqual(Object.keys(TRANSITION_MATRIX[kind][state]), AGGREGATE_EVENTS[kind])
      for (const event of AGGREGATE_EVENTS[kind]) {
        const value = transition(kind, state, event, {})
        assert.deepEqual(Object.keys(value), KEYS)
        assert.ok(['accepted', 'idempotent', 'stale', 'rejected'].includes(value.classification))
        if (value.classification !== 'accepted') assert.equal(value.next_state, state)
      }
    }
  }
})

test('malformed payloads never throw and reject', () => {
  for (const payload of [null, [], 'bad', new Date()]) assert.equal(transition('run', 'active', 'run-paused', payload).classification, 'rejected')
  assert.equal(transition('unknown', 'x', 'x', {}).classification, 'rejected')
})

test('all terminal task outcomes are terminal and non-reopening', () => {
  for (const terminal of TERMINAL_TASKS) {
    for (const event of AGGREGATE_EVENTS.task) {
      const outcome = transition('task', terminal, event, {})
      assert.notEqual(outcome.classification, 'accepted')
      assert.equal(outcome.next_state, terminal)
    }
  }
})

test('retry requires a new attempt and lease lifecycle', () => {
  assert.equal(transition('attempt', 'running', 'attempt-retryable-failure', {}).next_state, 'retryable-failure')
  assert.equal(transition('attempt', 'retryable-failure', 'attempt-started', {}).classification, 'rejected')
  assert.equal(transition('attempt', 'allocated', 'attempt-started', {}).classification, 'accepted')
  assert.equal(transition('lease', 'allocated', 'lease-activated', {}).next_state, 'active')
})

test('checkpoint enforces sequence and hash chain', () => {
  const hash = 'a'.repeat(64)
  assert.equal(transition('checkpoint', 'none', 'checkpoint-recorded', { sequence: 1, hash }).classification, 'accepted')
  assert.equal(transition('checkpoint', 'recorded', 'checkpoint-recorded', { sequence: 1, hash, previous_sequence: 1, previous_hash: hash }).classification, 'idempotent')
  assert.equal(transition('checkpoint', 'recorded', 'checkpoint-recorded', { sequence: 1, hash: 'b'.repeat(64), previous_sequence: 2 }).classification, 'stale')
})

test('lease expiry and repository reconciliation fail closed', () => {
  assert.equal(transition('lease', 'active', 'lease-expired', { now: '2026-01-01T00:00:00Z', expires_at: '2026-01-02T00:00:00Z' }).classification, 'stale')
  assert.equal(transition('lease', 'active', 'lease-expired', { now: '2026-01-03T00:00:00Z', expires_at: '2026-01-02T00:00:00Z' }).next_state, 'expired')
  const mismatch = transition('run', 'active', 'repository-mismatch', {})
  assert.equal(mismatch.next_state, 'reconciliation-required')
  assert.deepEqual(mismatch.emitted_events, ['certificate-descendants-invalidated'])
})

test('certificate invalidation emits descendant invalidation', () => {
  const outcome = transition('certificate', 'certified', 'certificate-invalidated', {})
  assert.equal(outcome.next_state, 'invalidated')
  assert.deepEqual(outcome.emitted_events, ['certificate-descendants-invalidated'])
})
