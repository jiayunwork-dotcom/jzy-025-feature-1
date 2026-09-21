'use strict';

// “来源”（同一物理来源、按时间顺序连续采集的若干批次）的入参检查。
//
// 与单条提交（validation.js）的分工：
//   - 开来源时只做一次 kind / tau0 检查；来源把这两个设定钉死。
//   - 之后每批追加不再要求提供 tau0 / kind：省略即沿用来源设定；
//     若调用方显式给了，就必须与来源一致，明显矛盾的追加直接拒绝
//     （连批次记录都不落——这是调用方式错误，不是数据残缺）。
//   - 每批自身仍要走一遍单条提交里的数据检查：缺项、非有限数、
//     最短长度。这类失败会落成该来源名下的失败批次（残缺区间），
//     不影响同来源其它批次，但联合曲线上要标出这一段缺失。

const { KINDS } = require('./estimator');
const { MIN_FREQUENCY_SAMPLES, FAILURE_REASONS } = require('./validation');

const SOURCE_FAILURE_REASONS = Object.freeze({
  MISSING_KIND: FAILURE_REASONS.MISSING_KIND,
  KIND_INVALID: FAILURE_REASONS.KIND_INVALID,
  MISSING_TAU0: FAILURE_REASONS.MISSING_TAU0,
  TAU0_NOT_NUMBER: FAILURE_REASONS.TAU0_NOT_NUMBER,
  TAU0_NOT_POSITIVE: FAILURE_REASONS.TAU0_NOT_POSITIVE,
  BODY_INVALID: '请求体必须是 JSON 对象',
  TAU0_MISMATCH: '本批 tau0 与来源声明的采样间隔不一致，禁止混入不同采样间隔的数据',
  KIND_MISMATCH: '本批 kind 与来源声明的数据类型不一致，禁止混用钟差与分数频率',
});

function rejected(code, reasons = SOURCE_FAILURE_REASONS) {
  return { ok: false, rejected: true, code, reason: reasons[code] };
}

function dataFailure(code, rawSamples) {
  return {
    ok: false,
    rejected: false,
    code,
    reason: FAILURE_REASONS[code],
    rawSamples: Array.isArray(rawSamples) ? rawSamples : [],
  };
}

// 开来源：只要 kind 与 tau0。
// 返回 { ok: true, kind, tau0 } 或 { ok: false, rejected: true, code, reason }。
function validateSourceCreation(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rejected('BODY_INVALID');
  }

  if (!('kind' in body) || body.kind === null) {
    return rejected('MISSING_KIND');
  }
  const kind = body.kind;
  if (kind !== KINDS.PHASE && kind !== KINDS.FREQUENCY) {
    return rejected('KIND_INVALID');
  }

  if (!('tau0' in body) || body.tau0 === null) {
    return rejected('MISSING_TAU0');
  }
  const tau0 = body.tau0;
  if (typeof tau0 !== 'number' || !Number.isFinite(tau0)) {
    return rejected('TAU0_NOT_NUMBER');
  }
  if (tau0 <= 0) {
    return rejected('TAU0_NOT_POSITIVE');
  }

  return { ok: true, kind, tau0 };
}

// 追加一批：tau0 / kind 可省略（沿用来源），显式给出时必须一致。
// 返回：
//   { ok: true, samples: Float64Array }
//   { ok: false, rejected: true, code, reason }      调用方式错误，不落批次
//   { ok: false, rejected: false, code, reason, rawSamples } 数据失败，落失败批次
function validateBatchAppend(body, source) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return dataFailure('MISSING_SAMPLES', []);
  }

  // 元数据矛盾先查：这种拒绝不落任何批次。
  if ('kind' in body && body.kind !== null && body.kind !== undefined) {
    const kind = body.kind;
    if (kind !== KINDS.PHASE && kind !== KINDS.FREQUENCY) {
      return rejected('KIND_INVALID');
    }
    if (kind !== source.kind) {
      return rejected('KIND_MISMATCH');
    }
  }

  if ('tau0' in body && body.tau0 !== null && body.tau0 !== undefined) {
    const tau0 = body.tau0;
    if (typeof tau0 !== 'number' || !Number.isFinite(tau0)) {
      return rejected('TAU0_NOT_NUMBER');
    }
    if (tau0 <= 0) {
      return rejected('TAU0_NOT_POSITIVE');
    }
    if (tau0 !== source.tau0) {
      return rejected('TAU0_MISMATCH');
    }
  }

  if (!('samples' in body)) {
    return dataFailure('MISSING_SAMPLES', []);
  }
  const rawSamples = body.samples;
  if (!Array.isArray(rawSamples)) {
    return dataFailure('SAMPLES_NOT_ARRAY', []);
  }
  if (rawSamples.length === 0) {
    return dataFailure('SAMPLE_TOO_SHORT', rawSamples);
  }

  for (const value of rawSamples) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return dataFailure('NON_FINITE_SAMPLE', rawSamples);
    }
  }

  const samples = Float64Array.from(rawSamples);
  const effectiveCount =
    source.kind === KINDS.FREQUENCY
      ? samples.length
      : samples.length - 1;
  if (effectiveCount < MIN_FREQUENCY_SAMPLES) {
    return dataFailure('SAMPLE_TOO_SHORT', rawSamples);
  }

  return { ok: true, samples };
}

module.exports = {
  SOURCE_FAILURE_REASONS,
  validateSourceCreation,
  validateBatchAppend,
};
