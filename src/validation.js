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
});

function failure(code) {
  return { ok: false, reason: FAILURE_REASONS[code], code };
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
};
