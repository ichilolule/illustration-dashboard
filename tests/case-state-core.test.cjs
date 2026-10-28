const test = require('node:test');
const assert = require('node:assert/strict');
const State = require('../case-state-core.js');

test('migrates legacy payment fields without inventing payment terms', () => {
  const postpaid = State.normalizeCase({ status: 'wait', step: '5', payment: '銀行振込', paid: '後払い', paidDate: '2026-09-01' });
  assert.equal(postpaid.workStatus, null);
  assert.equal(postpaid.paymentMethod, '銀行振込');
  assert.equal(postpaid.paymentTerms, 'postpaid');
  assert.equal(postpaid.paymentStatus, 'unpaid');
  assert.equal(postpaid.paidDate, '2026-09-01');
  assert.match(State.dataWarnings(postpaid)[0], /原データを保持/);
  assert.ok(!('status' in postpaid) && !('payment' in postpaid) && !('paid' in postpaid));

  const paid = State.normalizeCase({ status: 'progress', step: '3', payment: 'Skeb', paid: '入金済み', paidDate: '2026-08-01' });
  assert.equal(paid.paymentTerms, 'unknown');
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.paidDate, '2026-08-01');
});

test('derives one unambiguous overall status from workflow and payment axes', () => {
  assert.equal(State.deriveOverallStatus({ step: '2', workStatus: 'progress', paymentStatus: 'paid' }), 'in_progress');
  assert.equal(State.deriveOverallStatus({ step: '2', workStatus: 'wait', paymentStatus: 'paid' }), 'awaiting_client');
  assert.equal(State.deriveOverallStatus({ step: '5', workStatus: null, paymentStatus: 'unpaid' }), 'delivered_awaiting_payment');
  assert.equal(State.deriveOverallStatus({ step: '5', workStatus: null, paymentStatus: 'paid' }), 'completed');
  assert.equal(State.deriveOverallStatus({ step: '3', workStatus: 'progress', paymentStatus: 'paid' }, true), 'archived_other');
});

test('archives only cases that are both delivered and paid', () => {
  const result = State.reconcileCollections([
    { id: 'finished', step: '5', paymentStatus: 'paid', workStatus: null },
    { id: 'waiting-payment', step: '5', paymentStatus: 'unpaid', paymentTerms: 'postpaid', workStatus: null },
    { id: 'paid-in-progress', step: '3', paymentStatus: 'paid', workStatus: 'progress' }
  ], [{ id: 'manual-archive', step: '2', paymentStatus: 'unpaid', workStatus: 'wait' }]);

  assert.deepEqual(result.cases.map(item => item.id), ['waiting-payment', 'paid-in-progress']);
  assert.deepEqual(result.archive.map(item => item.id), ['manual-archive', 'finished']);
  assert.equal(result.archive[0].step, '2');
  assert.equal(result.archive[1].archiveReason, 'completed');
});

test('normalization and reconciliation are idempotent', () => {
  const first = State.reconcileCollections([
    { id: 'a', status: 'wait', step: '5', payment: '銀行振込', paid: '後払い' }
  ], []);
  const second = State.reconcileCollections(first.cases, first.archive);
  assert.deepEqual(second, first);
});

test('migrates a legacy delivered pair without changing identity, request text, dates or amounts', () => {
  const original = {
    id: 'stable-id', name: '馬車道はげみ　かき氷', step: '5', status: 'delivered',
    payment: '銀行振込', paid: '後払い', paidDate: '', paydue: '2026-09-18',
    detail: '【AI要約】\n氷\n【依頼原文】\n原文を改変しない', price: '12345'
  };
  const finished = { id: 'verrin-id', name: 'Verrin', step: '5', status: 'delivered', paid: '入金済み', paidDate: '2026-08-08' };
  const result = State.reconcileCollections([original], [finished]);
  assert.equal(State.deriveOverallStatus(result.cases[0]), 'delivered_awaiting_payment');
  assert.equal(State.deriveOverallStatus(result.archive[0], true), 'completed');
  for (const field of ['id', 'detail', 'price', 'paydue']) assert.equal(result.cases[0][field], original[field]);
  assert.equal(result.archive[0].paidDate, '2026-08-08');
});
