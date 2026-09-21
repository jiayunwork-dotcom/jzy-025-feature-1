'use strict';

// 分批来源的联合稳定度：服务级与估计器级测试。
//
// 核心验收：
//  1. 分批追加后的联合曲线 == 所有批次首尾相连一次性提交（含跨界滑窗）
//  2. 残缺段两侧不制造伪重叠（滑窗不跨缺失段）
//  3. 全零数据分批追加，稳度值仍精确为 0
//  4. 单批追加失败不连累其它批次
//  5. 来源支持的最大平均时间随追加动态增长
//  6. kind / tau0 不一致的追加被拒绝
//  7. 并发追加不错乱、不重复计入
//  8. 落盘后重开能继续追加并保持不变量

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createRecordStore } = require('../src/store');
const { createSourceService } = require('../src/sourcePipeline');
const {
  buildTimeline,
  estimateTimeline,
  frequencyDeviationPooled,
} = require('../src/sourceEstimator');
const { selectMList } = require('../src/tauGrid');
const { processSubmission } = require('../src/pipeline');
const { KINDS } = require('../src/estimator');
const {
  whiteFrequencySamples,
  integrateFrequency,
} = require('../src/synthetic');

function split(array, cutPoints) {
  const chunks = [];
  let start = 0;
  for (const cut of cutPoints) {
    chunks.push(array.slice(start, cut));
    start = cut;
  }
  chunks.push(array.slice(start));
  return chunks;
}

// 独立参考：在“带 NaN 残缺槽”的整段序列上，逐条滑窗、
// 只要窗口触及 NaN 就丢弃该项（不与生产代码共享实现）。
function referenceGappedFrequency(slots, m) {
  const n = slots.length;
  const terms = n - 2 * m + 1;
  let squaredSum = 0;
  let kept = 0;
  for (let j = 0; j < terms; j += 1) {
    let first = 0;
    let second = 0;
    let valid = true;
    for (let i = 0; i < m; i += 1) {
      const a = slots[j + i];
      const b = slots[j + m + i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        valid = false;
        break;
      }
      first += a;
      second += b;
    }
    if (!valid) {
      continue;
    }
    const delta = (second - first) / m;
    squaredSum += delta * delta;
    kept += 1;
  }
  if (kept === 0) {
    return { sigma: null, terms: 0 };
  }
  return { sigma: Math.sqrt(squaredSum / (2 * kept)), terms: kept };
}

test('分批追加联合曲线与整段一次性提交逐项一致（含横跨批次边界的平均时间点）', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const full = whiteFrequencySamples(600, 1, 20260921);
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;

  // 不均等分批，制造多个批次边界
  const batches = split(full, [90, 210, 333, 470]);
  assert.ok(batches.length >= 4);
  for (const chunk of batches) {
    const result = service.doAppend(
      store,
      sourceId,
      { samples: Array.from(chunk) }
    );
    assert.equal(result.status, 'ok');
  }

  const oneShot = processSubmission(store, {
    samples: Array.from(full),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(oneShot.status, 'ok');

  const joint = store.getSourceById(sourceId).jointState;

  // 同一套 decade 网格与 T/3 裁剪
  assert.deepEqual(joint.mList, oneShot.mList);
  assert.equal(joint.mMax, selectMList(full.length).mMax);
  assert.equal(joint.points.length, oneShot.points.length);

  const refByM = new Map(oneShot.points.map((p) => [p.m, p]));
  for (const point of joint.points) {
    const ref = refByM.get(point.m);
    assert.ok(ref, `联合曲线多出 m=${point.m}`);
    // 必须精确一致（同一计算路径），不是“接近”
    assert.ok(
      Object.is(point.sigma, ref.sigma),
      `m=${point.m} 分批 σ=${point.sigma} != 整段 σ=${ref.sigma}`
    );
    assert.equal(point.tau, ref.tau);
    assert.equal(point.noiseCode, ref.noiseCode);
    assert.equal(point.slope, ref.slope);
  }
  assert.equal(joint.hasWhiteFrequency, oneShot.hasWhiteFrequency);
});

test('边界附近：平均时间接近单批时长的跨界点明显依赖跨过边界的滑动块', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  // 两批各 150 点：m=60、70、80 都大于单批可独立成块能力，
  // 若“先各算曲线再拼接”，这些 m 上各批内部可形成的块对数极少；
  // 而整段联合时滑动块横跨两批，必须得到与一次性提交相同的结果。
  const full = whiteFrequencySamples(600, 1, 77);
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, {
    samples: Array.from(full.slice(0, 300)),
  });
  service.doAppend(store, sourceId, {
    samples: Array.from(full.slice(300)),
  });

  const oneShot = processSubmission(store, {
    samples: Array.from(full),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  const joint = store.getSourceById(sourceId).jointState;

  // n=600：decade 网格到 m=200；选跨越单批边界、且单批内项数受限的点
  const boundaryMs = [80, 90, 100, 200];
  for (const m of boundaryMs) {
    const point = joint.points.find((p) => p.m === m);
    const ref = oneShot.points.find((p) => p.m === m);
    assert.ok(point && ref, `m=${m} 应在曲线上`);
    assert.ok(
      Object.is(point.sigma, ref.sigma),
      `跨界点 m=${m}：联合 ${point.sigma} 与整段 ${ref.sigma} 不一致`
    );
  }

  // 直接对照：只提交第一批（300 点）在 m=200 时 K=300-400+1 < 0，
  // 根本无法独立估计；联合 600 点时 K=201，跨界块必须被计入。
  const onlyFirst = processSubmission(store, {
    samples: Array.from(full.slice(0, 300)),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.ok(!onlyFirst.mList.includes(200));
  assert.ok(joint.mList.includes(200));
  // 估计器层面：整段 600 点在 m=200 的项数为 201，其中跨界起点
  // （j=101..200 覆盖两批）占 100 项——先各算再拼接永远拿不到这些。
  const timeline = buildTimeline(
    [
      { status: 'ok', samples: full.slice(0, 300) },
      { status: 'ok', samples: full.slice(300) },
    ],
    KINDS.FREQUENCY
  );
  const pooled = frequencyDeviationPooled([timeline.jointSamples], 200);
  assert.equal(pooled.terms, 201);
});

test('残缺段：滑动窗不跨越缺失段，且结果等于带 NaN 整段序列上丢弃触缺项', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const left = whiteFrequencySamples(100, 1, 11);
  const right = whiteFrequencySamples(100, 1, 22);
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, { samples: Array.from(left) });

  // 中间一批 40 点含非有限数：失败，在时间线上留 40 个残缺槽
  const bad = Array.from(whiteFrequencySamples(40, 1, 33));
  bad[5] = NaN;
  const failed = service.doAppend(store, sourceId, { samples: bad });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'NON_FINITE_SAMPLE');

  service.doAppend(store, sourceId, { samples: Array.from(right) });

  const state = store.getSourceById(sourceId).jointState;
  assert.equal(state.hasGaps, true);
  assert.equal(state.spanSamples, 240);
  assert.equal(state.coveredSamples, 200);
  assert.equal(state.gapSamples, 40);
  assert.deepEqual(state.gaps, [
    {
      fromSlot: 100,
      toSlot: 140,
      sampleCount: 40,
      fromTime: 100,
      toTime: 140,
    },
  ]);

  // 构造带 NaN 的整段参考序列
  const slots = new Float64Array(240);
  slots.set(left, 0);
  for (let i = 100; i < 140; i += 1) {
    slots[i] = NaN;
  }
  slots.set(right, 140);

  const { mList } = selectMList(240);
  for (const m of mList) {
    const ref = referenceGappedFrequency(slots, m);
    const point = state.points.find((p) => p.m === m);
    if (ref.terms === 0) {
      // 没有完整滑窗的平均时间必须整条缺席，绝不能造数
      assert.equal(point, undefined, `m=${m} 跨缺失段却出现在曲线上`);
    } else {
      assert.ok(point, `m=${m} 应有估计但缺失`);
      assert.ok(
        Math.abs(point.sigma - ref.sigma) / ref.sigma < 1e-12,
        `m=${m} 联合 ${point.sigma} 偏离带 NaN 参考 ${ref.sigma}`
      );
    }
  }

  // 关键反伪重叠：m=50 时两段各自 K=100-100+1=1，合计 2 项；
  // 任何跨越缺失槽的块都被排除，且没有把左右直接相接。
  const m50 = state.points.find((p) => p.m === 50);
  assert.ok(m50);
  const pooled = frequencyDeviationPooled(
    [Float64Array.from(left), Float64Array.from(right)],
    50
  );
  assert.equal(pooled.terms, 2);
  assert.ok(Object.is(m50.sigma, pooled.sigma));

  // “悄悄跳过缺失段直接相接”的错误做法会把 100+100 当成连续 200 点：
  // 它在 m=50 的项数是 200-100+1=101，且数值会不同。
  const stitched = Float64Array.from([...left, ...right]);
  const wrong = estimateTimeline(
    buildTimeline(
      [
        { status: 'ok', samples: stitched },
      ],
      KINDS.FREQUENCY
    ),
    [50]
  )[0];
  assert.notEqual(wrong.terms, m50.terms);
  assert.ok(Math.abs(wrong.sigma - m50.sigma) / m50.sigma > 1e-9);
});

test('缺失段长度未知（连 samples 都没有）：成为纪元屏障，两侧绝不相跨', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const left = whiteFrequencySamples(100, 1, 1);
  const right = whiteFrequencySamples(100, 1, 2);
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, { samples: Array.from(left) });
  const failed = service.doAppend(store, sourceId, { tau0: 1 }); // 无 samples
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 'MISSING_SAMPLES');
  service.doAppend(store, sourceId, { samples: Array.from(right) });

  const state = store.getSourceById(sourceId).jointState;
  assert.equal(state.hasGaps, true);
  assert.equal(state.unknownGaps, 1);
  assert.equal(state.spanSamples, 200); // 屏障不占已知槽

  // 两个纪元各 100 点：m 满足 100-2m+1>0 即 m<=50 才有项；
  // m=60（K<0）必须缺席，且 m=50 的项数只可能来自两个纪元各自内部
  // （各 1 项，共 2 项），绝不允许跨越屏障把两侧接成连续 200 点。
  const m50 = state.points.find((p) => p.m === 50);
  assert.ok(m50);
  const pooled50 = frequencyDeviationPooled(
    [Float64Array.from(left), Float64Array.from(right)],
    50
  );
  assert.equal(pooled50.terms, 2);
  assert.ok(Object.is(m50.sigma, pooled50.sigma));
  assert.equal(state.points.find((p) => p.m === 60), undefined);

  // 错误做法（跳过屏障直接相接）在 m=50 上是 200 连续点、101 个项
  const stitched = Float64Array.from([...left, ...right]);
  const wrong = estimateTimeline(
    buildTimeline([{ status: 'ok', samples: stitched }], KINDS.FREQUENCY),
    [50]
  )[0];
  assert.equal(wrong.terms, 101);
  assert.notEqual(wrong.terms, m50.terms);
});

test('全零数据分批追加：合法 τ 上 σ_y 精确为 0（频率与钟差）', () => {
  for (const kind of [KINDS.FREQUENCY, KINDS.PHASE]) {
    const store = createRecordStore(':memory:');
    const service = createSourceService();
    // 钟差要比频率多 1 点才够；这里统一用 301，frequency 仍合法
    const total = kind === KINDS.PHASE ? 301 : 300;
    const sourceId = service.createSource(store, { kind, tau0: 0.5 }).id;
    for (const [a, b] of [
      [0, 60],
      [60, 200],
      [200, total],
    ]) {
      const result = service.doAppend(store, sourceId, {
        samples: new Array(b - a).fill(0),
      });
      assert.equal(result.status, 'ok');
    }

    const state = store.getSourceById(sourceId).jointState;
    const oneShot = processSubmission(store, {
      samples: new Array(total).fill(0),
      kind,
      tau0: 0.5,
    });
    assert.deepEqual(state.mList, oneShot.mList);
    assert.ok(state.points.length > 5);
    for (const point of state.points) {
      assert.ok(
        Object.is(point.sigma, 0),
        `${kind} 全零分批 m=${point.m} σ 非精确零：${point.sigma}`
      );
      // 无法取对数，不硬贴噪声标签
      assert.ok(
        point.noiseCode === null || point.noiseCode === 'unknown'
      );
    }
  }
});

test('单批追加失败不连累来源内已成功的其它批次，且失败后还能继续追加', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const a = whiteFrequencySamples(120, 1, 1);
  const b = whiteFrequencySamples(120, 1, 2);
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, { samples: Array.from(a) });

  const before = store.getSourceById(sourceId).jointState;
  const failed = service.doAppend(store, sourceId, {
    samples: [1, Infinity, 3, 4, 5, 6, 7, 8, 9, 10],
  });
  assert.equal(failed.status, 'failed');

  // 失败批已记录但前一批的覆盖数据不受影响（只是多出一段残缺标记）
  const afterFail = store.getSourceById(sourceId);
  assert.equal(afterFail.batchCount, 2);
  assert.equal(afterFail.okBatchCount, 1);
  assert.equal(afterFail.jointState.coveredSamples, 120);
  assert.equal(afterFail.jointState.coveredSamples, before.coveredSamples);
  assert.equal(afterFail.jointState.gapSamples, 10);

  // 失败批次行确实落盘为 failed
  const batches = store.listBatches(sourceId);
  assert.equal(batches[1].status, 'failed');
  assert.ok(batches[1].failureReason.length > 0);

  // 来源仍可继续追加，成功批照常并入
  const cont = service.doAppend(store, sourceId, { samples: Array.from(b) });
  assert.equal(cont.status, 'ok');
  const finalState = store.getSourceById(sourceId);
  assert.equal(finalState.batchCount, 3);
  assert.equal(finalState.okBatchCount, 2);
  assert.equal(finalState.jointState.coveredSamples, 240);
  assert.ok(finalState.jointState.points.length > 5);
});

test('来源支持的最大平均时间随追加动态增长，而非开来源时定死', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 2,
  }).id;

  const empty = store.getSourceById(sourceId).jointState;
  assert.equal(empty.curveStatus, 'insufficient_data');
  assert.equal(empty.mMax, 0);
  assert.deepEqual(empty.mList, []);

  const expected = [
    { add: 30, n: 30, mMax: 10 },
    { add: 60, n: 90, mMax: 30 },
    { add: 210, n: 300, mMax: 100 },
    { add: 600, n: 900, mMax: 300 },
  ];
  let cumulative = 0;
  for (const { add, n, mMax } of expected) {
    service.doAppend(store, sourceId, {
      samples: Array.from(whiteFrequencySamples(add, 1, cumulative + 1)),
    });
    cumulative = n;
    const state = store.getSourceById(sourceId).jointState;
    assert.equal(state.mMax, mMax, `累计 ${cumulative} 点时 mMax 应=${mMax}`);
    assert.equal(state.totalDuration, cumulative * 2);
    assert.equal(Math.max(...state.mList), mMax);
    assert.ok(state.curveStatus === 'ok');
  }
});

test('开来源校验 tau0 / kind；追加时类型或采样间隔不一致被拒绝且不落批次', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();

  for (const body of [
    {},
    { kind: 'bogus', tau0: 1 },
    { kind: KINDS.FREQUENCY, tau0: 0 },
    { kind: KINDS.FREQUENCY, tau0: NaN },
    { kind: KINDS.FREQUENCY },
    { tau0: 1 },
  ]) {
    const created = service.createSource(store, body);
    assert.equal(created.status, 'rejected', `应拒绝 ${JSON.stringify(body)}`);
  }
  assert.equal(store.listSources().length, 0); // 非法创建不落来源

  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;

  // 不一致的追加：拒绝（rejected），不落批次、联合状态不变
  const goodSamples = Array.from(whiteFrequencySamples(30, 1, 1));
  const mismatchKind = service.doAppend(store, sourceId, {
    samples: goodSamples,
    kind: KINDS.PHASE,
  });
  assert.equal(mismatchKind.status, 'rejected');
  assert.equal(mismatchKind.code, 'KIND_MISMATCH');

  const mismatchTau0 = service.doAppend(store, sourceId, {
    samples: goodSamples,
    tau0: 2,
  });
  assert.equal(mismatchTau0.status, 'rejected');
  assert.equal(mismatchTau0.code, 'TAU0_MISMATCH');

  // 显式给一致的 tau0/kind 必须允许
  const same = service.doAppend(store, sourceId, {
    samples: goodSamples,
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(same.status, 'ok');

  const state = store.getSourceById(sourceId);
  assert.equal(state.batchCount, 1); // 两次矛盾拒绝都没落成批次
  assert.equal(state.okBatchCount, 1);

  // 省略 tau0/kind 时沿用来源设定，不要求重复提供
  const implicit = service.doAppend(store, sourceId, { samples: goodSamples });
  assert.equal(implicit.status, 'ok');
});

test('并发追加：恰好一批进入处理，其余 busy；联合状态不错乱、不重复计入', async () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;

  for (let burst = 0; burst < 8; burst += 1) {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, k) =>
        service.appendBatch(store, sourceId, {
          samples: Array.from(whiteFrequencySamples(40, 1, burst * 100 + k)),
        })
      )
    );
    const accepted = results.filter((r) => r.status === 'ok').length;
    const busy = results.filter((r) => r.status === 'busy').length;
    assert.equal(accepted, 1, `第 ${burst} 批并发应有且仅有 1 批成功`);
    assert.equal(busy, 5);
  }

  const state = store.getSourceById(sourceId);
  assert.equal(state.batchCount, 8);
  assert.equal(state.okBatchCount, 8);
  assert.equal(state.jointState.spanSamples, 320); // 8×40，无重复计入

  // 串行追加在 busy 释放后照常成功
  const sequential1 = await service.appendBatch(store, sourceId, {
    samples: Array.from(whiteFrequencySamples(40, 1, 999)),
  });
  const sequential2 = await service.appendBatch(store, sourceId, {
    samples: Array.from(whiteFrequencySamples(40, 1, 1000)),
  });
  assert.equal(sequential1.status, 'ok');
  assert.equal(sequential2.status, 'ok');
  assert.equal(store.getSourceById(sourceId).batchCount, 10);
});

test('并发追加最终联合曲线与按序接受的批次一次性拼接一致', async () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;

  // 先准备好 6 批；并发提交，只有一批会被接受。被拒批次重试到成功，
  // 最终顺序由服务按接受顺序确定。校验：无论并发怎样交错，最终曲线
  // 等于“按存储顺序拼接后一次性提交”。
  const chunks = Array.from({ length: 6 }, (_, k) =>
    Float64Array.from(whiteFrequencySamples(60, 1, 500 + k))
  );
  const pending = chunks.map((chunk, index) => ({ index, chunk }));
  while (pending.length > 0) {
    const results = await Promise.all(
      pending.map(({ chunk }) =>
        service.appendBatch(store, sourceId, {
          samples: Array.from(chunk),
        })
      )
    );
    // 第一个成功的留下，其余 busy 的下一轮重试
    const acceptedIndex = results.findIndex((r) => r.status === 'ok');
    assert.ok(acceptedIndex >= 0);
    pending.splice(acceptedIndex, 1);
  }

  const ordered = store
    .listBatches(sourceId)
    .filter((b) => b.status === 'ok')
    .map((b) => Float64Array.from(b.samples));
  const concatenated = new Float64Array(ordered.reduce((s, c) => s + c.length, 0));
  let offset = 0;
  for (const chunk of ordered) {
    concatenated.set(chunk, offset);
    offset += chunk.length;
  }

  const oneShot = processSubmission(store, {
    samples: Array.from(concatenated),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  const joint = store.getSourceById(sourceId).jointState;
  assert.deepEqual(joint.mList, oneShot.mList);
  for (const point of joint.points) {
    const ref = oneShot.points.find((p) => p.m === point.m);
    assert.ok(Object.is(point.sigma, ref.sigma), `m=${point.m} 不一致`);
  }
});

test('钟差分批：与对应频率整段提交在同一物理 τ 上一致（跨界二阶差分）', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const frequency = whiteFrequencySamples(400, 1, 31337);
  const phase = integrateFrequency(frequency); // 401 点

  const sourceId = service.createSource(store, {
    kind: KINDS.PHASE,
    tau0: 1,
  }).id;
  for (const chunk of split(phase, [130, 260])) {
    const result = service.doAppend(store, sourceId, {
      samples: Array.from(chunk),
    });
    assert.equal(result.status, 'ok');
  }

  const oneShotPhase = processSubmission(store, {
    samples: Array.from(phase),
    kind: KINDS.PHASE,
    tau0: 1,
  });
  const oneShotFrequency = processSubmission(store, {
    samples: Array.from(frequency),
    kind: KINDS.FREQUENCY,
    tau0: 1,
  });
  const joint = store.getSourceById(sourceId).jointState;

  assert.deepEqual(joint.mList, oneShotPhase.mList);
  assert.deepEqual(joint.mList, oneShotFrequency.mList);
  for (const point of joint.points) {
    const refPhase = oneShotPhase.points.find((p) => p.m === point.m);
    const refFreq = oneShotFrequency.points.find((p) => p.m === point.m);
    assert.ok(Object.is(point.sigma, refPhase.sigma));
    assert.ok(
      Math.abs(point.sigma - refFreq.sigma) / refFreq.sigma < 1e-12
    );
  }
});

test('每批仍走最短长度检查：过短批次只失败该批，不入联合覆盖', () => {
  const store = createRecordStore(':memory:');
  const service = createSourceService();
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, {
    samples: Array.from(whiteFrequencySamples(50, 1, 1)),
  });
  const short = service.doAppend(store, sourceId, {
    samples: [1, 2, 3],
  });
  assert.equal(short.status, 'failed');
  assert.equal(short.code, 'SAMPLE_TOO_SHORT');

  const state = store.getSourceById(sourceId);
  assert.equal(state.okBatchCount, 1);
  assert.equal(state.jointState.coveredSamples, 50);
  assert.equal(state.jointState.gapSamples, 3);
});

test('批次与联合状态落盘：重开存储后可继续追加且不变量保持', () => {
  const path = `/tmp/source-restart-${process.pid}.db`;
  const fs = require('node:fs');
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(path + suffix);
    } catch {
      // ignore
    }
  }

  const full = whiteFrequencySamples(360, 1, 424242);
  let store = createRecordStore(path);
  let service = createSourceService();
  const sourceId = service.createSource(store, {
    kind: KINDS.FREQUENCY,
    tau0: 1,
  }).id;
  service.doAppend(store, sourceId, { samples: Array.from(full.slice(0, 120)) });
  service.doAppend(store, sourceId, { samples: Array.from(full.slice(120, 240)) });
  store.close();

  // 重开：来源、批次、联合状态都还在
  store = createRecordStore(path);
  service = createSourceService();
  const reloaded = store.getSourceById(sourceId);
  assert.ok(reloaded);
  assert.equal(reloaded.kind, KINDS.FREQUENCY);
  assert.equal(reloaded.batchCount, 2);
  assert.equal(reloaded.jointState.spanSamples, 240);
  assert.ok(reloaded.jointState.points.length > 5);

  // 继续追加剩余批次
  const cont = service.doAppend(store, sourceId, {
    samples: Array.from(full.slice(240)),
  });
  assert.equal(cont.status, 'ok');

  const oneShot = processSubmission(store, {
    samples: Array.from(full),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  const joint = store.getSourceById(sourceId).jointState;
  assert.deepEqual(joint.mList, oneShot.mList);
  for (const point of joint.points) {
    const ref = oneShot.points.find((p) => p.m === point.m);
    assert.ok(Object.is(point.sigma, ref.sigma), `重开后 m=${point.m} 不一致`);
  }
  store.close();
});
