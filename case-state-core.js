/* Canonical case-state migration and derived status rules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DashboardCaseState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WORK_STATUSES = ['progress', 'wait'];
  const PAYMENT_TERMS = ['prepaid', 'postpaid', 'unknown'];
  const PAYMENT_STATUSES = ['unpaid', 'paid'];
  const STEPS = ['1', '2', '3', '4', '5'];
  const OVERALL_STATUS_LABELS = {
    in_progress: '進行中',
    awaiting_client: '確認待ち',
    delivered_awaiting_payment: '納品済み・入金待ち',
    completed: '完了',
    archived_other: 'アーカイブ済み（未完了）'
  };

  function normalizeCase(source, options = {}) {
    if (!source || typeof source !== 'object') return source;
    const out = { ...source };
    if (!out.id && typeof options.makeId === 'function') out.id = options.makeId();

    const legacyRevision = (parseInt(out.revFree) || 0) + (parseInt(out.revPaid) || 0);
    const revision = out.revisionCount !== undefined ? (parseInt(out.revisionCount) || 0) : legacyRevision;
    out.revisionCount = String(Math.max(0, revision));
    delete out.revFree;
    delete out.revPaid;

    out.step = String(out.step || '1');
    if (!STEPS.includes(out.step)) out.step = '1';

    let workStatus = out.workStatus ?? out.status;
    if (workStatus === 'done') workStatus = 'wait';
    if (!WORK_STATUSES.includes(workStatus)) {
      if (out.overallStatus === 'in_progress') workStatus = 'progress';
      else if (out.overallStatus === 'awaiting_client') workStatus = 'wait';
      else workStatus = 'wait';
    }
    out.workStatus = out.step === '5' ? null : workStatus;

    if (out.paymentMethod === undefined) out.paymentMethod = out.payment || '';
    out.paymentMethod = String(out.paymentMethod || '');

    let paymentTerms = out.paymentTerms;
    if (!PAYMENT_TERMS.includes(paymentTerms)) {
      paymentTerms = out.paid === '後払い' ? 'postpaid' : 'unknown';
    }
    out.paymentTerms = paymentTerms;

    let paymentStatus = out.paymentStatus;
    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      paymentStatus = out.paid === '入金済み' ? 'paid' : 'unpaid';
    }
    out.paymentStatus = paymentStatus;
    out.paidDate = String(out.paidDate || '');

    delete out.status;
    delete out.payment;
    delete out.paid;
    delete out.overallStatus;
    delete out.dataWarnings;
    return out;
  }

  function isDelivered(item) { return String(item?.step || '') === '5'; }
  function isPaid(item) { return item?.paymentStatus === 'paid'; }
  function isPostpaid(item) { return item?.paymentTerms === 'postpaid'; }

  function deriveOverallStatus(item, archived = false) {
    if (archived) return isDelivered(item) && isPaid(item) ? 'completed' : 'archived_other';
    if (isDelivered(item)) return isPaid(item) ? 'completed' : 'delivered_awaiting_payment';
    return item?.workStatus === 'progress' ? 'in_progress' : 'awaiting_client';
  }

  function overallStatusLabel(status) {
    return OVERALL_STATUS_LABELS[status] || OVERALL_STATUS_LABELS.awaiting_client;
  }

  function dataWarnings(item, archived = false) {
    const warnings = [];
    if (archived && deriveOverallStatus(item, true) === 'archived_other') {
      warnings.push('未完了または未入金の状態でアーカイブされています');
    }
    if (isPaid(item) && !item.paidDate) warnings.push('入金済みですが入金日が未設定です');
    if (!isPaid(item) && item.paidDate) warnings.push('未入金ですが入金日が記録されています（原データを保持）');
    return warnings;
  }

  function reconcileCollections(activeCases, archivedCases, options = {}) {
    const cases = (Array.isArray(activeCases) ? activeCases : []).map(item => normalizeCase(item, options));
    const archive = (Array.isArray(archivedCases) ? archivedCases : []).map(item => normalizeCase(item, options));
    const remaining = [];
    const moved = [];
    cases.forEach(item => {
      if (deriveOverallStatus(item, false) === 'completed') {
        moved.push({ ...item, archiveReason: 'completed' });
      } else {
        remaining.push(item);
      }
    });
    return { cases: remaining, archive: [...archive, ...moved], moved };
  }

  return {
    WORK_STATUSES,
    PAYMENT_TERMS,
    PAYMENT_STATUSES,
    OVERALL_STATUS_LABELS,
    normalizeCase,
    isDelivered,
    isPaid,
    isPostpaid,
    deriveOverallStatus,
    overallStatusLabel,
    dataWarnings,
    reconcileCollections
  };
});
