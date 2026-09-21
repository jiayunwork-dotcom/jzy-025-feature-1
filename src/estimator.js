'use strict';

// 重叠 Allan 偏差（overlapping Allan deviation）估计。
//
// 滑动步长固定为 1 个采样间隔 τ0：相邻块起点只错开一个采样。
// m>1 时步长 1 < 块长 m，各块相互重叠；m=1（τ=τ0）时步长等于块长，
// 是无可滑动的退化情形，公式仍与重叠定义一致。
//
// 分数频率序列 y（长度 n）：相邻两个长度 m 的平均频率之差
//   σ_y²(m τ0) = 1/(2K) Σ_{j=0}^{K-1} ( mean(y, j+m .. j+2m-1)
//                                        - mean(y, j .. j+m-1) )²
//   K = n - 2m + 1
//
// 钟差/相位序列 x（长度 L）：二阶差分（x 以 τ0 为单位归一化，
// 平均频率 = Δx/m）
//   σ_y²(m τ0) = 1/(2K m²) Σ_{j=0}^{K-1} ( x[j+2m] - 2x[j+m] + x[j] )²
//   K = L - 2m
//
// 当 y[j] = x[j] - x[j-1]（τ0 下的分数频率）时，L = n+1，
// 两种写法的求和项数 K = n - 2m + 1 = L - 2m 完全一致、逐项相同。
//
// 注意：这里不是样本标准差除以 √τ，也不是互不重叠块的方差。

const KINDS = Object.freeze({
  PHASE: 'phase', // 钟差（相位时间）
  FREQUENCY: 'frequency', // 分数频率
});

// 长度 m 的滑动块均值；步长为 1（< m，重叠）。
// 每次调用只使用本次调用内新建的缓冲，返回后缓冲即被丢弃，
// 不向后续 m 或后续记录泄露任何中间累加值。
function slidingBlockMeans(values, m) {
  const length = values.length;
  const blockCount = length - m + 1;
  const means = new Float64Array(blockCount);

  let windowSum = 0;
  for (let i = 0; i < m; i += 1) {
    windowSum += values[i];
  }
  means[0] = windowSum / m;

  for (let j = 1; j < blockCount; j += 1) {
    // 窗口向前滑动一个采样：去掉离开的 x[j-1]，加入进入的 x[j+m-1]
    windowSum += values[j + m - 1] - values[j - 1];
    means[j] = windowSum / m;
  }

  return means;
}

function deviationForFrequency(samples, m) {
  const n = samples.length;
  const terms = n - 2 * m + 1; // K
  const means = slidingBlockMeans(samples, m);

  let squaredSum = 0;
  for (let j = 0; j < terms; j += 1) {
    const delta = means[j + m] - means[j];
    squaredSum += delta * delta;
  }

  // 全零序列时 squaredSum 恒为 0，sqrt(0) === 0（精确为零）
  return Math.sqrt(squaredSum / (2 * terms));
}

function deviationForPhase(samples, m) {
  const length = samples.length;
  const terms = length - 2 * m; // K = n - 2m + 1（n = L-1）

  let squaredSum = 0;
  for (let j = 0; j < terms; j += 1) {
    const secondDifference =
      samples[j + 2 * m] - 2 * samples[j + m] + samples[j];
    squaredSum += secondDifference * secondDifference;
  }

  const scale = m; // Δx/m 才是 m τ0 上的平均分数频率
  return Math.sqrt(squaredSum / (2 * terms)) / scale;
}

// 一次性估计器对象：estimate 之间不保留任何滑动窗中间量。
function createOverlappingAllanEstimator() {
  return {
    estimate(samples, kind, mList) {
      const results = [];
      for (const m of mList) {
        const sigma =
          kind === KINDS.FREQUENCY
            ? deviationForFrequency(samples, m)
            : deviationForPhase(samples, m);
        results.push({ m, sigma });
      }
      return results;
    },
  };
}

module.exports = {
  KINDS,
  createOverlappingAllanEstimator,
  slidingBlockMeans,
  deviationForFrequency,
  deviationForPhase,
};
