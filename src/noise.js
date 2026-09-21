'use strict';

// 在双对数坐标（log10 τ 对 log10 σ_y）上读相邻点的局部斜率，
// 落进钉死的斜率区间才贴噪声类型标签，对不上标“未知”。
//
//   白相位  white phase     : 斜率 ≈ -1
//   白频率  white frequency : 斜率 ≈ -1/2
//   随机游走 random walk    : 斜率 ≈ +1/2
//
// 区间之间故意留缝，边界值不被硬塞给任何一种噪声。
// 少于两个合法 τ（连一对相邻点都凑不齐）时，类型栏整列留空。

const NOISE_TYPES = Object.freeze({
  WHITE_PHASE: Object.freeze({
    code: 'white_phase',
    label: '白相位',
    center: -1,
    low: -1.2,
    high: -0.8,
  }),
  WHITE_FREQUENCY: Object.freeze({
    code: 'white_frequency',
    label: '白频率',
    center: -0.5,
    low: -0.7,
    high: -0.3,
  }),
  RANDOM_WALK: Object.freeze({
    code: 'random_walk',
    label: '随机游走',
    center: 0.5,
    low: 0.3,
    high: 0.7,
  }),
  UNKNOWN: Object.freeze({
    code: 'unknown',
    label: '未知',
  }),
});

const SLOPE_BANDS = Object.freeze(
  [
    NOISE_TYPES.WHITE_PHASE,
    NOISE_TYPES.WHITE_FREQUENCY,
    NOISE_TYPES.RANDOM_WALK,
  ].map(({ code, label, low, high }) => Object.freeze({ code, label, low, high }))
);

function classifySlope(slope) {
  if (!Number.isFinite(slope)) {
    return NOISE_TYPES.UNKNOWN;
  }
  for (const band of SLOPE_BANDS) {
    if (slope >= band.low && slope <= band.high) {
      return band;
    }
  }
  return NOISE_TYPES.UNKNOWN;
}

// points: [{ m, tau, sigma }]，按 τ 升序，等比例间隔不做要求。
// 返回与 points 等长的分类数组；每个点的类型由“它与前一个点”的
// 局部斜率决定，因此第一个点恒为 null（没有前一个点）。
function classifyNoiseSegments(points) {
  const columns = points.map(() => null);
  if (points.length < 2) {
    return columns;
  }

  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];

    let slope = null;
    if (
      previous.tau > 0 &&
      current.tau > 0 &&
      previous.sigma > 0 &&
      current.sigma > 0
    ) {
      slope =
        (Math.log10(current.sigma) - Math.log10(previous.sigma)) /
        (Math.log10(current.tau) - Math.log10(previous.tau));
    }

    const type = classifySlope(slope);
    columns[i] = {
      slope: Number.isFinite(slope) ? slope : null,
      code: type.code,
      label: type.label,
    };
  }

  return columns;
}

module.exports = {
  NOISE_TYPES,
  SLOPE_BANDS,
  classifySlope,
  classifyNoiseSegments,
};
