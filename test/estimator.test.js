'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createOverlappingAllanEstimator,
  KINDS,
} = require('../src/estimator');
const { selectMList, candidateMList } = require('../src/tauGrid');
const {
  classifyNoiseSegments,
  classifySlope,
  SLOPE_BANDS,
  NOISE_TYPES,
} = require('../src/noise');
const { createRecordStore } = require('../src/store');
const { processValidatedSubmission } = require('../src/pipeline');
const {
  whiteFrequencySamples,
  randomWalkFrequencySamples,
  whitePhaseSamples,
  integrateFrequency,
} = require('../src/synthetic');

const estimator = createOverlappingAllanEstimator();

function slopePairs(points, mLow, mHigh) {
  const slopes = [];
  for (let i = 1; i < points.length; i += 1) {
    if (points[i - 1].m >= mLow && points[i].m <= mHigh) {
      slopes.push({
        mLow: points[i - 1].m,
        mHigh: points[i].m,
        slope:
          (Math.log10(points[i].sigma) - Math.log10(points[i - 1].sigma)) /
          (Math.log10(points[i].tau) - Math.log10(points[i - 1].tau)),
      });
    }
  }
  return slopes;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function frequencyCurve(samples, mList) {
  return estimator
    .estimate(samples, KINDS.FREQUENCY, mList)
    .map(({ m, sigma }) => ({ m, tau: m, sigma }));
}

// 独立实现的参考重叠 Allan：显式逐块循环，不与 src/estimator 共享代码。
function referenceOverlappingFrequency(samples, m) {
  const n = samples.length;
  const terms = n - 2 * m + 1;
  let squaredSum = 0;
  for (let j = 0; j < terms; j += 1) {
    let first = 0;
    let second = 0;
    for (let i = 0; i < m; i += 1) {
      first += samples[j + i];
      second += samples[j + m + i];
    }
    const delta = (second - first) / m;
    squaredSum += delta * delta;
  }
  return Math.sqrt(squaredSum / (2 * terms));
}

// 互不重叠块的“假 Allan”：仅作为反面参照，用来卡住非重叠冒充。
function referenceNonOverlapping(samples, m) {
  const n = samples.length;
  const blocks = Math.floor(n / m);
  const blockMeans = [];
  for (let b = 0; b < blocks; b += 1) {
    let sum = 0;
    for (let i = 0; i < m; i += 1) {
      sum += samples[b * m + i];
    }
    blockMeans.push(sum / m);
  }
  let squaredSum = 0;
  for (let i = 0; i < blockMeans.length - 1; i += 1) {
    const delta = blockMeans[i + 1] - blockMeans[i];
    squaredSum += delta * delta;
  }
  return Math.sqrt(squaredSum / (2 * (blockMeans.length - 1)));
}

test('白频率合成序列：中段双对数局部斜率接近 -1/2 且类型标“白频率”', () => {
  const samples = whiteFrequencySamples(8192, 1, 17);
  const { mList } = selectMList(samples.length);
  const points = frequencyCurve(samples, mList);
  const classifications = classifyNoiseSegments(points);

  const midSlopes = slopePairs(points, 10, 100);
  assert.ok(midSlopes.length >= 5);
  const midMedian = median(midSlopes.map((s) => s.slope));
  assert.ok(
    Math.abs(midMedian - -0.5) <= 0.1,
    `中段斜率中位数 ${midMedian} 偏离 -1/2`
  );

  // 验收卡斜率：每个中段点的标签都必须落到钉死的白频率区间内
  const midClassifications = classifications.filter(
    (c, i) => i > 0 && points[i - 1].m >= 10 && points[i].m <= 100
  );
  assert.ok(
    midClassifications.every((c) => c.code === 'white_frequency'),
    '中段应全部识别为白频率'
  );

  // 量级也要对：σ(τ) ≈ σ(τ0)/√m
  const byM = new Map(points.map((p) => [p.m, p.sigma]));
  assert.ok(Math.abs(byM.get(1) - 1) < 0.05);
  assert.ok(Math.abs(byM.get(100) - 0.1) < 0.02);
});

test('白频率振幅加倍：整条 σ_y 恰好近似两倍，斜率区段不变', () => {
  const base = whiteFrequencySamples(4096, 1, 2026);
  const doubled = Float64Array.from(base, (v) => 2 * v);
  const { mList } = selectMList(base.length);

  const baseCurve = frequencyCurve(base, mList);
  const doubledCurve = frequencyCurve(doubled, mList);

  for (let i = 0; i < mList.length; i += 1) {
    const ratio = doubledCurve[i].sigma / baseCurve[i].sigma;
    assert.ok(
      Math.abs(ratio - 2) < 1e-12,
      `m=${mList[i]} 处倍数 ${ratio} 不是 2`
    );
  }

  const baseLabels = classifyNoiseSegments(baseCurve).map((c) =>
    c ? c.code : null
  );
  const doubledLabels = classifyNoiseSegments(doubledCurve).map((c) =>
    c ? c.code : null
  );
  assert.deepEqual(doubledLabels, baseLabels);
});

test('全零序列：每个合法 τ 上 σ_y 必须正好是 0（频率与钟差两种）', () => {
  const zeroFrequency = new Float64Array(300);
  const { mList } = selectMList(zeroFrequency.length);
  const frequencyResult = estimator.estimate(
    zeroFrequency,
    KINDS.FREQUENCY,
    mList
  );
  for (const { m, sigma } of frequencyResult) {
    assert.ok(Object.is(sigma, 0), `频率全零 m=${m} σ 非精确零：${sigma}`);
  }

  const zeroPhase = new Float64Array(301);
  const phaseResult = estimator.estimate(zeroPhase, KINDS.PHASE, mList);
  for (const { m, sigma } of phaseResult) {
    assert.ok(Object.is(sigma, 0), `钟差全零 m=${m} σ 非精确零：${sigma}`);
  }

  // 全零曲线类型列：σ=0 无法取对数，不硬贴标签
  const points = frequencyResult.map(({ m, sigma }) => ({
    m,
    tau: m,
    sigma,
  }));
  const classifications = classifyNoiseSegments(points);
  assert.ok(classifications.every((c) => c === null || c.code === 'unknown'));
});

test('τ 不得超过 T/3：超出的候选不进曲线', () => {
  const n = 200;
  const { mMax, mList } = selectMList(n);
  assert.equal(mMax, Math.floor(n / 3));
  assert.ok(mList.every((m) => m <= n / 3));
  assert.ok(mList.includes(1));

  // decade 网格抽样：1..9,10..90,100 起被 T/3=66.7 裁掉
  assert.ok(mList.includes(60));
  assert.ok(!mList.includes(70));
  assert.ok(!mList.includes(100));

  // 实际曲线点数与 m 列表一致，τ 物理值 = m·τ0
  const samples = whiteFrequencySamples(n, 1, 5);
  const result = estimator.estimate(samples, KINDS.FREQUENCY, mList);
  assert.equal(result.length, mList.length);
  assert.ok(result.every(({ m }) => m * 0.5 <= (n * 0.5) / 3));
});

test('候选 τ 全超 T/3 时：记录判失败、落失败原因、不产出曲线', () => {
  const store = createRecordStore(':memory:');
  const result = processValidatedSubmission(
    store,
    {
      samples: new Float64Array(4),
      kind: KINDS.FREQUENCY,
      tau0: 1,
      effectiveCount: 2, // mMax = 0，无合法 τ
    },
    {}
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'ALL_TAU_EXCEED_LIMIT');

  const stored = store.getById(result.id);
  assert.equal(stored.status, 'failed');
  assert.ok(stored.failureReason.includes('T/3'));
  assert.equal(stored.points, undefined);
  assert.equal(stored.mList, undefined);
  store.close();
});

test('钟差（二阶差分）与分数频率（相邻块均值之差）在同一物理 τ 上对得上', () => {
  const frequencySamples = whiteFrequencySamples(500, 1, 7);
  const phaseSamples = integrateFrequency(frequencySamples);
  const mList = [1, 2, 3, 7, 10, 20, 50, 100, 166];

  const fromFrequency = estimator.estimate(
    frequencySamples,
    KINDS.FREQUENCY,
    mList
  );
  const fromPhase = estimator.estimate(phaseSamples, KINDS.PHASE, mList);

  for (let i = 0; i < mList.length; i += 1) {
    const relative =
      Math.abs(fromFrequency[i].sigma - fromPhase[i].sigma) /
      fromFrequency[i].sigma;
    assert.ok(
      relative < 1e-12,
      `m=${mList[i]} 两种输入差 ${relative} 超过数值容差`
    );
  }
});

test('非重叠冒充卡控：服务结果等于独立参考重叠实现，且明显不同于非重叠块', () => {
  // 短序列 + m 取 N/4 附近：非重叠实现只有极少不滑动块，结果系统性偏离。
  const samples = whiteFrequencySamples(200, 1, 6);
  const m = 50;

  const service = estimator.estimate(samples, KINDS.FREQUENCY, [m])[0].sigma;
  const overlapping = referenceOverlappingFrequency(samples, m);
  const nonOverlapping = referenceNonOverlapping(samples, m);

  assert.ok(
    Math.abs(service - overlapping) / overlapping < 1e-12,
    '服务实现与独立参考重叠公式不一致'
  );
  assert.ok(
    Math.abs(service - nonOverlapping) / overlapping > 0.15,
    '与非重叠结果差异过小——疑似用了互不重叠块冒充重叠'
  );

  // 重叠实现的求和项数必须是 N-2m+1（非重叠只有 floor(N/m)-1 = 3 对）
  const expectedTerms = samples.length - 2 * m + 1;
  assert.equal(expectedTerms, 101);
});

test('同一物理过程 τ0 减半（加密采样）：同一物理 τ 上 σ_y 仍对得上', () => {
  const fine = whiteFrequencySamples(4096, 1, 123); // τ0f
  const coarse = new Float64Array(2048); // τ0c = 2 τ0f，成对平均
  for (let i = 0; i < 2048; i += 1) {
    coarse[i] = (fine[2 * i] + fine[2 * i + 1]) / 2;
  }

  const coarseM = [5, 10, 25, 50, 100, 200];
  const coarseCurve = estimator.estimate(coarse, KINDS.FREQUENCY, coarseM);
  const fineCurve = estimator.estimate(
    fine,
    KINDS.FREQUENCY,
    coarseM.map((m) => 2 * m)
  );

  coarseCurve.forEach((point, i) => {
    const physicalTauCoarse = point.m * 2;
    const physicalTauFine = fineCurve[i].m * 1;
    assert.equal(physicalTauCoarse, physicalTauFine);
    const relative =
      Math.abs(point.sigma - fineCurve[i].sigma) / point.sigma;
    assert.ok(
      relative < 0.02,
      `物理 τ=${physicalTauCoarse} 上差异 ${relative}`
    );
  });
});

test('随机游走频率 +1/2、白相位 -1：斜率区间贴标签正确，区间外标“未知”', () => {
  const walk = randomWalkFrequencySamples(8192, 0.05, 99);
  const walkPoints = frequencyCurve(walk, selectMList(walk.length).mList);
  const walkMid = slopePairs(walkPoints, 20, 100);
  assert.ok(Math.abs(median(walkMid.map((s) => s.slope)) - 0.5) < 0.1);
  assert.ok(
    classifyNoiseSegments(walkPoints)
      .filter(Boolean)
      .filter((c, i) => i >= 1)
      .some((c) => c.code === 'random_walk')
  );

  const phase = whitePhaseSamples(8192, 1, 77);
  const phasePoints = estimator
    .estimate(phase, KINDS.PHASE, selectMList(phase.length - 1).mList)
    .map(({ m, sigma }) => ({ m, tau: m, sigma }));
  const phaseMid = slopePairs(phasePoints, 20, 100);
  assert.ok(Math.abs(median(phaseMid.map((s) => s.slope)) - -1) < 0.12);
  assert.ok(
    classifyNoiseSegments(phasePoints)
      .filter(Boolean)
      .some((c) => c.code === 'white_phase')
  );

  // 区间留缝：-0.75 落在白相位与白频率之间，必须标未知
  assert.equal(classifySlope(-0.75).code, 'unknown');
  assert.equal(classifySlope(0).code, 'unknown');
  assert.equal(classifySlope(NaN).code, 'unknown');
  assert.equal(classifySlope(-0.5).code, 'white_frequency');
  assert.equal(classifySlope(0.5).code, 'random_walk');
  assert.equal(classifySlope(-1).code, 'white_phase');

  // 少于两个 τ：整列留空
  const single = classifyNoiseSegments([{ m: 1, tau: 1, sigma: 1 }]);
  assert.deepEqual(single, [null]);
});

test('估计器无跨记录/跨 m 状态：重复估计结果完全一致', () => {
  const a = whiteFrequencySamples(300, 1, 11);
  const b = whiteFrequencySamples(300, 2, 22);
  const { mList } = selectMList(300);

  const firstRun = estimator.estimate(a, KINDS.FREQUENCY, mList);
  estimator.estimate(b, KINDS.FREQUENCY, mList); // 中间夹一份完全不同的记录
  const secondRun = estimator.estimate(a, KINDS.FREQUENCY, mList);

  assert.equal(firstRun.length, secondRun.length);
  for (let i = 0; i < firstRun.length; i += 1) {
    assert.equal(firstRun[i].m, secondRun[i].m);
    assert.ok(Object.is(firstRun[i].sigma, secondRun[i].sigma));
  }

  // 同一份记录内调换 m 的顺序，同一 m 的结果必须一致（无滑窗残留）
  const forward = estimator.estimate(a, KINDS.FREQUENCY, [10, 50]);
  const reversed = estimator.estimate(a, KINDS.FREQUENCY, [50, 10]);
  assert.ok(Object.is(forward[0].sigma, reversed[1].sigma));
  assert.ok(Object.is(forward[1].sigma, reversed[0].sigma));
});

test('斜率区间钉死并随记录保存：区间边界与噪声类型一一对应', () => {
  assert.equal(SLOPE_BANDS.length, 3);
  assert.deepEqual(
    SLOPE_BANDS.map((b) => b.code),
    ['white_phase', 'white_frequency', 'random_walk']
  );
  assert.equal(NOISE_TYPES.WHITE_FREQUENCY.label, '白频率');
});

// 红线反面参照：普通样本标准差除以 √τ。这不是 Allan 统计量——
// 它对随机游走频率给出持续下降的假斜率，整段噪声识别会错掉。
function referenceNaiveStdOverSqrtTau(samples, m) {
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (samples.length - 1);
  return Math.sqrt(variance / m);
}

test('红线：样本标准差/√τ 冒充 Allan 在随机游走数据上整段错掉', () => {
  // 随机游走频率 σ_y(τ) 随 √τ 上升（斜率 +1/2）；
  // 假统计量却随 1/√τ 下降，且量级差数倍。
  const walk = randomWalkFrequencySamples(8192, 0.05, 99);
  const { mList } = selectMList(walk.length);
  const curve = frequencyCurve(walk, mList);

  for (const m of [20, 50]) {
    const allan = curve.find((p) => p.m === m).sigma;
    const naive = referenceNaiveStdOverSqrtTau(walk, m);
    assert.ok(
      naive / allan >= 2,
      `m=${m} 处服务结果与“样本标准差/√τ”假统计量区分不开，疑似冒充`
    );
  }

  // 真 Allan 随 m 增大而上升；假统计量单调下降
  const at25 = curve.find((p) => p.m === 20).sigma;
  const at100 = curve.find((p) => p.m === 100).sigma;
  assert.ok(at100 > at25);
  assert.ok(
    referenceNaiveStdOverSqrtTau(walk, 100) <
      referenceNaiveStdOverSqrtTau(walk, 20)
  );
});

test('candidateMList 边界处理', () => {
  assert.deepEqual(candidateMList(0), []);
  assert.deepEqual(candidateMList(1), [1]);
  assert.deepEqual(candidateMList(9), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(candidateMList(10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});
