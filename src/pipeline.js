'use strict';

// 把入参检查、τ 选择、重叠 Allan 估计、噪声区段识别、记录存取
// 串成一次“记录段”提交流程。估计器每份记录新建，滑窗中间量
// 随调用结束被释放，不会污染下一份记录。

const {
  createOverlappingAllanEstimator,
  KINDS,
} = require('./estimator');
const { selectMList } = require('./tauGrid');
const { classifyNoiseSegments, SLOPE_BANDS } = require('./noise');
const { validateSubmission } = require('./validation');

function persistFailure(store, body, code, reason, { preset = false } = {}) {
  const rawSamples =
    body && typeof body === 'object' && Array.isArray(body.samples)
      ? body.samples
      : [];

  const kind =
    body && typeof body === 'object' &&
    (body.kind === KINDS.PHASE || body.kind === KINDS.FREQUENCY)
      ? body.kind
      : null;

  const tau0 =
    body && typeof body === 'object' &&
    typeof body.tau0 === 'number' && Number.isFinite(body.tau0)
      ? body.tau0
      : null;

  const id = store.insertFailure({
    kind,
    tau0,
    sampleCount: rawSamples.length,
    samples: rawSamples, // 原样保留（NaN/Infinity 会被 JSON 序列化为 null）
    failureReason: reason || code,
    preset,
  });

  return {
    id,
    status: 'failed',
    code,
    failureReason: reason || code,
  };
}

// 已通过入参检查后的处理：τ 选择、估计、识别、落盘。
// 单独导出，便于直接覆盖“候选 τ 全超 T/3”这一在常规最短长度下
// 不会出现的失败分支。
function processValidatedSubmission(
  store,
  { samples, kind, tau0, effectiveCount },
  options = {}
) {
  const { mMax, mList } = selectMList(effectiveCount);

  if (mList.length === 0) {
    const totalDuration = effectiveCount * tau0;
    const id = store.insertFailure({
      kind,
      tau0,
      sampleCount: samples.length,
      samples: Array.from(samples),
      failureReason: `所有候选平均时间 τ 都超过整段时长 T=${totalDuration} 的三分之一（T/3=${
        totalDuration / 3
      }）`,
      preset: options.preset === true,
    });
    return {
      id,
      status: 'failed',
      code: 'ALL_TAU_EXCEED_LIMIT',
      failureReason: '所有候选 τ 均超过 T/3，记录判失败',
    };
  }

  // 每份记录独立的估计器，不携带任何跨记录状态。
  const estimator = createOverlappingAllanEstimator();
  const estimations = estimator.estimate(samples, kind, mList);
  const basePoints = estimations.map(({ m, sigma }) => ({
    m,
    tau: m * tau0,
    sigma,
  }));

  const classifications = classifyNoiseSegments(basePoints);
  const points = basePoints.map((point, index) => ({
    m: point.m,
    tau: point.tau,
    sigma: point.sigma,
    slope: classifications[index] ? classifications[index].slope : null,
    noiseCode: classifications[index] ? classifications[index].code : null,
    noiseLabel: classifications[index] ? classifications[index].label : null,
  }));

  const hasWhiteFrequency = points.some(
    (point) => point.noiseCode === 'white_frequency'
  );

  const id = store.insertSuccess({
    kind,
    tau0,
    sampleCount: samples.length,
    samples: Array.from(samples),
    mList,
    points,
    slopeBands: SLOPE_BANDS,
    hasWhiteFrequency,
    preset: options.preset === true,
  });

  return {
    id,
    status: 'ok',
    kind,
    tau0,
    mMax,
    totalDuration: effectiveCount * tau0,
    mList,
    points,
    slopeBands: SLOPE_BANDS,
    hasWhiteFrequency,
  };
}

function processSubmission(store, body, options = {}) {
  const checked = validateSubmission(body);
  if (!checked.ok) {
    return persistFailure(store, body, checked.code, checked.reason, options);
  }
  return processValidatedSubmission(store, checked, options);
}

module.exports = {
  processSubmission,
  processValidatedSubmission,
  persistFailure,
};
