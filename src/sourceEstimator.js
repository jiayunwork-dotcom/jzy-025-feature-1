'use strict';

// 分批来源的时间线拼装与“跨界感知”的联合重叠 Allan 估计。
//
// 关键：联合曲线不是“每批各自算好曲线再拼接”，而是把所有已成功批次
// 放进同一条时间线、用一整段序列上的滑动窗重新估计。只要平均时间
// 不超过总时长的三分之一，滑动块天然会跨过批次边界去两侧取样本。
//
// 残缺区间（失败批次）不能悄悄跳过、把前后两段直接接成连续序列——
// 那会在缺失段两侧制造出并不存在的短平均时间伪重叠。时间线因此被
// 残缺段切成若干“纪元”（epoch），滑动窗的任一取样点必须整体落在
// 同一个纪元内才计入；横跨残缺段的项直接丢弃。
//
// 无残缺段时，联合估计与“所有批次首尾相连一次性提交”逐字节走同一
// 条计算路径（直接复用 estimator.js 的整段公式），保证两条曲线
// 数值上精确一致，而不仅仅是“接近”。

const {
  createOverlappingAllanEstimator,
  slidingBlockMeans,
  KINDS,
} = require('./estimator');

// 由按序批次构造时间线。
// 成功批次 { status: 'ok', samples } 提供连续样本；
// 失败批次有已知长度时在时间线上占等量残缺槽（gap），长度未知
// （请求体连 samples 数组都没有）则是一道纪元屏障（barrier），
// 屏障两侧永远不允许同一个滑动窗跨越。
//
// 返回 {
//   kind, epochs: [Float64Array...], gaps: [{from,to}], barriers,
//   slotCount, coveredSamples, gapSamples,
//   jointSamples  // 无残缺时才出现：所有批次首尾相连的整段数组
// }
function buildTimeline(batches, kind) {
  const epochs = [];
  const gaps = [];
  let barriers = 0;
  let slotCount = 0;
  let coveredSamples = 0;

  // 当前纪元内待拼接的成功批次；遇到 gap/barrier 就结算一次。
  let pending = [];
  const flush = () => {
    if (pending.length === 0) {
      return;
    }
    let epoch;
    if (pending.length === 1) {
      epoch = pending[0];
    } else {
      const length = pending.reduce((sum, part) => sum + part.length, 0);
      epoch = new Float64Array(length);
      let offset = 0;
      for (const part of pending) {
        epoch.set(part, offset);
        offset += part.length;
      }
    }
    epochs.push(epoch);
    pending = [];
  };

  for (const batch of batches) {
    if (batch.status === 'ok') {
      pending.push(batch.samples);
      slotCount += batch.samples.length;
      coveredSamples += batch.samples.length;
    } else {
      flush();
      const gapLength =
        Number.isInteger(batch.sampleCount) ? batch.sampleCount : 0;
      if (gapLength > 0) {
        gaps.push({ from: slotCount, to: slotCount + gapLength });
        slotCount += gapLength;
      } else {
        barriers += 1;
      }
    }
  }
  flush();

  const timeline = {
    kind,
    epochs,
    gaps,
    barriers,
    slotCount,
    coveredSamples,
    gapSamples: slotCount - coveredSamples,
  };

  // 没有任何残缺段：这就是一条普通整段序列，直接交回给同一公式。
  if (gaps.length === 0 && barriers === 0 && epochs.length === 1) {
    timeline.jointSamples = epochs[0];
  }

  return timeline;
}

// 分数频率：对每个纪元独立算滑动块均值之差，再把平方和与项数汇总。
// 等效于在“带 NaN 槽的整条序列”上跳过任何触及残缺槽的滑动项，
// 但不真正做 NaN 运算，全零数据在每个合法 τ 上仍精确为 0。
function frequencyDeviationPooled(epochs, m) {
  let squaredSum = 0;
  let terms = 0;
  for (const values of epochs) {
    const n = values.length;
    const k = n - 2 * m + 1;
    if (k <= 0) {
      continue;
    }
    const means = slidingBlockMeans(values, m);
    for (let j = 0; j < k; j += 1) {
      const delta = means[j + m] - means[j];
      squaredSum += delta * delta;
    }
    terms += k;
  }
  if (terms === 0) {
    return { sigma: null, terms: 0 };
  }
  return { sigma: Math.sqrt(squaredSum / (2 * terms)), terms };
}

// 钟差：二阶差分，同一纪元内汇总。
function phaseDeviationPooled(epochs, m) {
  let squaredSum = 0;
  let terms = 0;
  for (const values of epochs) {
    const length = values.length;
    const k = length - 2 * m;
    if (k <= 0) {
      continue;
    }
    for (let j = 0; j < k; j += 1) {
      const secondDifference =
        values[j + 2 * m] - 2 * values[j + m] + values[j];
      squaredSum += secondDifference * secondDifference;
    }
    terms += k;
  }
  if (terms === 0) {
    return { sigma: null, terms: 0 };
  }
  return { sigma: Math.sqrt(squaredSum / (2 * terms)) / m, terms };
}

// 在时间线上对给定 mList 做联合估计。
// 返回 [{ m, sigma, terms }]：没有任何完整滑动项可用的 m 会被
// 整条丢掉（sigma 为 null），调用方负责在曲线与噪声识别里跳过。
function estimateTimeline(timeline, mList) {
  // 无残缺：逐字节复用单条整段路径，保证与一次性提交精确一致。
  if (timeline.jointSamples) {
    const estimator = createOverlappingAllanEstimator();
    return estimator
      .estimate(timeline.jointSamples, timeline.kind, mList)
      .map(({ m, sigma }) => {
        const n =
          timeline.kind === KINDS.FREQUENCY
            ? timeline.jointSamples.length
            : timeline.jointSamples.length - 1;
        return { m, sigma, terms: n - 2 * m + 1 };
      });
  }

  const pooled =
    timeline.kind === KINDS.FREQUENCY
      ? frequencyDeviationPooled
      : phaseDeviationPooled;

  const results = [];
  for (const m of mList) {
    const { sigma, terms } = pooled(timeline.epochs, m);
    if (sigma !== null) {
      results.push({ m, sigma, terms });
    }
  }
  return results;
}

module.exports = {
  buildTimeline,
  estimateTimeline,
  frequencyDeviationPooled,
  phaseDeviationPooled,
};
