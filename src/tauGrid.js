'use strict';

// 按 decade（十倍频程）选取平均时间因子 m，τ = m · τ0，m 为正整数。
// 每个十倍频程内取 1..9 共 9 个 m：
//   ..., 10,20,...,90, 100,200,...,900, 1000, ...
// 1 倍 τ0（m=1）始终作为第一个候选。

const DECADE_MULTIPLIERS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9]);

function candidateMList(mMax) {
  if (!Number.isInteger(mMax) || mMax < 1) {
    return [];
  }

  const result = [];
  for (let decade = 1; decade <= mMax; decade *= 10) {
    for (const multiplier of DECADE_MULTIPLIERS) {
      const m = decade * multiplier;
      if (m > mMax) {
        break;
      }
      result.push(m);
    }
  }
  return result;
}

// 有效样本数 n（分数频率点数；相位序列 L 点对应 n = L-1）。
// 整段时长 T = n · τ0；τ ≤ T/3 等价于 m ≤ n/3。
// 合法候选为空时，调用方必须把记录判为失败。
function selectMList(effectiveSampleCount) {
  const mMax = Math.floor(effectiveSampleCount / 3);
  return {
    mMax,
    mList: candidateMList(mMax),
  };
}

module.exports = {
  DECADE_MULTIPLIERS,
  candidateMList,
  selectMList,
};
