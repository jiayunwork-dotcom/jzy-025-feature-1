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

// 多段（同一物理来源、中间可能夹着缺失段）联合重叠 Allan 估计。
//
// segments 是若干条“各自连续、彼此之间存在缺失间隔”的采样段：
//   - 段内严格按上面的重叠定义取块（滑动步长 1，块可以自由跨过
//     *同一段内* 的批次边界——分批追加的批次只要没声明缺口，
//     就会先首尾相连拼成同一段，跨界滑动块一个都不会漏）；
//   - 任何滑动块都不允许跨过段与段之间的缺失间隔，否则会在缺口两侧
//     凭空造出并不存在的短平均时间“伪重叠”；
//   - 各段的平方和与求和项数分别累加后再合并：
//       σ²(m τ0) = Σ_s Σ_j d[s,j]² / (2 · Σ_s K_s(m))
//     长度不足以容纳两块（K_s ≤ 0）的段在该 m 上贡献 0、不进分母。
//
// 当只有一个段时（来源无缺失段，所有成功批次首尾相连），求和项与求和
// 顺序与 deviationForFrequency/deviationForPhase 完全一致，因此结果与
// “整段一次性提交”逐位相同（全零时同样精确为零）。
function deviationForFrequencySegments(segments, m) {
  let squaredSum = 0;
  let totalTerms = 0;

  for (const segment of segments) {
    const terms = segment.length - 2 * m + 1; // K_s
    if (terms <= 0) {
      continue;
    }
    const means = slidingBlockMeans(segment, m);
    for (let j = 0; j < terms; j += 1) {
      const delta = means[j + m] - means[j];
      squaredSum += delta * delta;
    }
    totalTerms += terms;
  }

  if (totalTerms === 0) {
    return { sigma: null, terms: 0 };
  }
  return {
    sigma: Math.sqrt(squaredSum / (2 * totalTerms)),
    terms: totalTerms,
  };
}

function deviationForPhaseSegments(segments, m) {
  let squaredSum = 0;
  let totalTerms = 0;

  for (const segment of segments) {
    const terms = segment.length - 2 * m; // K_s
    if (terms <= 0) {
      continue;
    }
    for (let j = 0; j < terms; j += 1) {
      const secondDifference =
        segment[j + 2 * m] - 2 * segment[j + m] + segment[j];
      squaredSum += secondDifference * secondDifference;
    }
    totalTerms += terms;
  }

  if (totalTerms === 0) {
    return { sigma: null, terms: 0 };
  }
  const scale = m; // Δx/m 才是 m τ0 上的平均分数频率
  return {
    sigma: Math.sqrt(squaredSum / (2 * totalTerms)) / scale,
    terms: totalTerms,
  };
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

    // 多段联合估计：返回 { m, sigma, terms }；没有任何一段支持该 m 时
    // sigma 为 null（正常调用方已按最长段做过 T/3 裁剪，不会遇到）。
    estimateSegments(segments, kind, mList) {
      const results = [];
      for (const m of mList) {
        const { sigma, terms } =
          kind === KINDS.FREQUENCY
            ? deviationForFrequencySegments(segments, m)
            : deviationForPhaseSegments(segments, m);
        results.push({ m, sigma, terms });
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
  deviationForFrequencySegments,
  deviationForPhaseSegments,
};
