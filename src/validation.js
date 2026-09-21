'use strict';

// 提交入参检查。失败原因结构化返回，由记录层落盘进失败态，
// 绝不允许带着非法输入继续算出一条“看起来完整”的曲线。

const { KINDS } = require('./estimator');

// 服务钉死的序列最短长度：分数频率至少这么多点；
// 钟差至少比这多 1 个点（要差分出这么多频率点）。
const MIN_FREQUENCY_SAMPLES = 8;

const FAILURE_REASONS = Object.freeze({
  MISSING_SAMPLES: '缺少序列字段 samples',
  SAMPLES_NOT_ARRAY: 'samples 必须是数组',
  SAMPLE_TOO_SHORT: `有效分数频率点数少于下限 ${MIN_FREQUENCY_SAMPLES}`,
  NON_FINITE_SAMPLE: '序列中存在缺项或非有限数（null/undefined/NaN/Infinity）',
  MISSING_TAU0: '缺少采样间隔 tau0',
  TAU0_NOT_NUMBER: 'tau0 必须是数字',
  TAU0_NOT_POSITIVE: 'tau0 必须为正数',
  MISSING_KIND: '缺少种类声明 kind',
  KIND_INVALID: `kind 必须是 "${KINDS.PHASE}"（钟差）或 "${KINDS.FREQUENCY}"（分数频率）`,
  ALL_TAU_EXCEED_LIMIT: '所有候选平均时间 τ 都超过整段时长 T 的三分之一',
  KIND_MISMATCH:
    '本批数据的 kind 与来源声明不一致：同一来源必须始终是同一种数据类型',
  TAU0_MISMATCH:
    '本批数据的 tau0 与来源声明不一致：同一来源必须始终使用相同采样间隔',
  GAP_BEFORE_NOT_BOOLEAN: 'gapBefore 必须是布尔值',
  BODY_NOT_OBJECT: '请求体必须是 JSON 对象',
});

function failure(code) {
  return { ok: false, reason: FAILURE_REASONS[code], code };
}

function checkBodyIsObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return false;
  }
  return true;
}

function checkKind(kind) {
  if (kind === undefined || kind === null) {
    return failure('MISSING_KIND');
  }
  if (kind !== KINDS.PHASE && kind !== KINDS.FREQUENCY) {
    return failure('KIND_INVALID');
  }
  return { ok: true, kind };
}

function checkTau0(tau0) {
  if (tau0 === undefined || tau0 === null) {
    return failure('MISSING_TAU0');
  }
  if (typeof tau0 !== 'number' || !Number.isFinite(tau0)) {
    return failure('TAU0_NOT_NUMBER');
  }
  if (tau0 <= 0) {
    return failure('TAU0_NOT_POSITIVE');
  }
  return { ok: true, tau0 };
}

function checkSamples(rawSamples, kind) {
  if (!Array.isArray(rawSamples)) {
    return failure('SAMPLES_NOT_ARRAY');
  }
  if (rawSamples.length === 0) {
    return failure('SAMPLE_TOO_SHORT');
  }
  // null/undefined 是缺项；NaN/Infinity 是非有限数，一律拒绝。
  for (const value of rawSamples) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return failure('NON_FINITE_SAMPLE');
    }
  }
  const samples = Float64Array.from(rawSamples);
  const effectiveCount =
    kind === KINDS.FREQUENCY ? samples.length : samples.length - 1;
  if (effectiveCount < MIN_FREQUENCY_SAMPLES) {
    return failure('SAMPLE_TOO_SHORT');
  }
  return { ok: true, samples };
}

// 开来源：tau0 与 kind 在来源上声明一次，之后每批不再重复要求提供。
// 返回 { ok: true, kind, tau0 } 或 { ok: false, code, reason }。
function validateSourceCreation(body) {
  if (!checkBodyIsObject(body)) {
    return failure('BODY_NOT_OBJECT');
  }

  const kindResult = checkKind(body.kind);
  if (!kindResult.ok) {
    return kindResult;
  }

  const tau0Result = checkTau0(body.tau0);
  if (!tau0Result.ok) {
    return tau0Result;
  }

  return { ok: true, kind: kindResult.kind, tau0: tau0Result.tau0 };
}

// 向已存在来源追加一批：每批照旧做样本入参检查（缺项、非有限数、
// 最短长度）；tau0/kind 不要求再次提供，但一旦提供且与来源声明矛盾，
// 必须拒绝，绝不悄悄混算出两种物理设定的曲线。
// 返回 { ok: true, samples, gapBefore } 或 { ok: false, code, reason }。
function validateBatchAppend(body, source) {
  if (!checkBodyIsObject(body)) {
    return failure('BODY_NOT_OBJECT');
  }

  if ('kind' in body && body.kind !== source.kind) {
    // 提供了但取值非法也先按“与来源矛盾”处理；非法值同样不可能一致
    return failure('KIND_MISMATCH');
  }
  if (
    'tau0' in body &&
    body.tau0 !== null &&
    (typeof body.tau0 !== 'number' ||
      !Number.isFinite(body.tau0) ||
      body.tau0 !== source.tau0)
  ) {
    return failure('TAU0_MISMATCH');
  }

  if (!('samples' in body)) {
    return failure('MISSING_SAMPLES');
  }

  // gapBefore：声明“本批与前一批之间存在缺失段”，默认不断开。
  if ('gapBefore' in body && typeof body.gapBefore !== 'boolean') {
    return failure('GAP_BEFORE_NOT_BOOLEAN');
  }

  const samplesResult = checkSamples(body.samples, source.kind);
  if (!samplesResult.ok) {
    return samplesResult;
  }

  return {
    ok: true,
    samples: samplesResult.samples,
    gapBefore: body.gapBefore === true,
  };
}

// 返回 { ok: true, samples, kind, tau0, effectiveCount }
// 或 { ok: false, code, reason }。
function validateSubmission(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return failure('MISSING_SAMPLES');
  }

  if (!('samples' in body)) {
    return failure('MISSING_SAMPLES');
  }
  const rawSamples = body.samples;
  if (!Array.isArray(rawSamples)) {
    return failure('SAMPLES_NOT_ARRAY');
  }
  if (rawSamples.length === 0) {
    return failure('SAMPLE_TOO_SHORT');
  }

  if (!('tau0' in body) || body.tau0 === null) {
    return failure('MISSING_TAU0');
  }
  const tau0 = body.tau0;
  if (typeof tau0 !== 'number' || !Number.isFinite(tau0)) {
    return failure('TAU0_NOT_NUMBER');
  }
  if (tau0 <= 0) {
    return failure('TAU0_NOT_POSITIVE');
  }

  if (!('kind' in body) || body.kind === null) {
    return failure('MISSING_KIND');
  }
  const kind = body.kind;
  if (kind !== KINDS.PHASE && kind !== KINDS.FREQUENCY) {
    return failure('KIND_INVALID');
  }

  // null/undefined 是缺项；NaN/Infinity 是非有限数，一律拒绝。
  for (const value of rawSamples) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return failure('NON_FINITE_SAMPLE');
    }
  }
  const samples = Float64Array.from(rawSamples);

  const effectiveCount =
    kind === KINDS.FREQUENCY ? samples.length : samples.length - 1;
  if (effectiveCount < MIN_FREQUENCY_SAMPLES) {
    return failure('SAMPLE_TOO_SHORT');
  }

  return { ok: true, samples, kind, tau0, effectiveCount };
}

module.exports = {
  MIN_FREQUENCY_SAMPLES,
  FAILURE_REASONS,
  validateSubmission,
  validateSourceCreation,
  validateBatchAppend,
};
