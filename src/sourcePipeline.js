'use strict';

// 物理“来源”的联合提交流程：
//   开来源（tau0/kind 只声明一次）→ 陆续追加批次（每批照旧做样本检查）
//   → 把所有成功批次按时间顺序当成一整条序列，算联合重叠 Allan 曲线。
//
// 关键：联合曲线绝不是“每批各自算好再拼接”。没有声明缺口的相邻成功批次
// 会先首尾相连拼成同一个连续段，重叠 Allan 的滑动块可以自由跨过批次
// 边界（只要平均时间不超过最长连续段的三分之一）；声明了 gapBefore 的
// 批次另起一个新段，任何滑动块都不允许跨过缺失段，避免在缺口两侧凭空
// 造出短平均时间的伪重叠。
//
// 无缺口的来源只有一个段，估计器的求和项、求和顺序与整段一次性提交完全
// 一致，因此联合曲线与单条提交流程逐位相同。

const {
  createOverlappingAllanEstimator,
} = require('./estimator');
const { candidateMList, selectMList } = require('./tauGrid');
const { classifyNoiseSegments, SLOPE_BANDS } = require('./noise');
const {
  validateSourceCreation,
  validateBatchAppend,
} = require('./validation');

// 进程内的“每来源同时只能有一批在追加”锁。估计与落盘本身是同步的，
// 同一事件循环刻内天然原子；锁在异步边界上把并发追加明确拒绝掉（409），
// 不让后来的批次与正在处理的批次互相踩踏或被计入两次。
const appendLocks = new Set();

function acquireSourceLock(sourceId) {
  if (appendLocks.has(sourceId)) {
    return false;
  }
  appendLocks.add(sourceId);
  return true;
}

function releaseSourceLock(sourceId) {
  appendLocks.delete(sourceId);
}

// 把一次 append 让到 I/O 轮询之后再做：这样 genuinely 同时到达的两个
// 请求都会在任一追加完成前先撞上锁（见 app.js 的并发处理）。
function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createSource(store, body) {
  const checked = validateSourceCreation(body);
  if (!checked.ok) {
    return {
      status: 'failed',
      code: checked.code,
      failureReason: checked.reason,
    };
  }

  const id = store.insertSource({ kind: checked.kind, tau0: checked.tau0 });
  return {
    status: 'ok',
    id,
    kind: checked.kind,
    tau0: checked.tau0,
  };
}

// 由来源名下的全部批次重建“连续段”。
// 成功批次按 seq（即成功顺序）排列；gapBefore 的批次另起一段。
// 失败批次不参与段结构（只在计数里留痕）。
//
// 返回的 segments 同时带内部估计用的 values 与对外元数据；
// 组装摘要/全文时只把元数据往外给。
function buildSegments(batches, kind, tau0) {
  const working = []; // { startSeq, endSeq, values }
  const gaps = [];
  let coveredRawSamples = 0; // 已覆盖原始采样点总数（跨段累加）

  const okBatches = batches
    .filter((batch) => batch.status === 'ok')
    .sort((a, b) => a.seq - b.seq);

  for (const batch of okBatches) {
    const values = Float64Array.from(batch.samples);
    const startsNewSegment =
      working.length === 0 ? false : batch.gapBefore === true;

    if (working.length > 0 && batch.gapBefore === true) {
      const previous = working[working.length - 1];
      gaps.push({
        index: gaps.length,
        afterSeq: previous.endSeq,
        beforeSeq: batch.seq,
        // 缺口前已经覆盖了多少个原始采样槽（缺口两侧不相连的分界位置，
        // 以“分数频率采样槽”为口径）
        precedingCoveredRawSamples: coveredRawSamples,
        precedingSegmentIndex: working.length - 1,
        followingSegmentIndex: working.length,
      });
    }

    if (working.length === 0 || startsNewSegment) {
      working.push({
        startSeq: batch.seq,
        endSeq: batch.seq,
        values,
      });
    } else {
      // 首尾相连：把批次拼到当前段尾，滑动块之后可以跨过这条拼接缝。
      const segment = working[working.length - 1];
      const merged = new Float64Array(segment.values.length + values.length);
      merged.set(segment.values, 0);
      merged.set(values, segment.values.length);
      segment.values = merged;
      segment.endSeq = batch.seq;
    }
    coveredRawSamples += values.length;
  }

  const segments = working.map((segment, index) => {
    const rawSampleCount = segment.values.length;
    // 钟差 L 点对应 n = L-1 个有效分数频率点（与单条提交流程一致）。
    const effectiveCount =
      kind === 'frequency' ? rawSampleCount : rawSampleCount - 1;
    return {
      index,
      startSeq: segment.startSeq,
      endSeq: segment.endSeq,
      rawSampleCount,
      effectiveCount,
      duration: effectiveCount * tau0,
      values: segment.values,
    };
  });

  return { segments, gaps, totalRawSamples: coveredRawSamples };
}

// 由全部批次重新计算联合状态。开来源后尚无成功批次时给出空联合状态。
function computeJointState(source, batches) {
  const okBatchCount = batches.filter((b) => b.status === 'ok').length;
  const failedBatchCount = batches.filter((b) => b.status === 'failed').length;

  if (okBatchCount === 0) {
    return {
      kind: source.kind,
      tau0: source.tau0,
      batchCount: batches.length,
      okBatchCount,
      failedBatchCount,
      hasGaps: false,
      segmentCount: 0,
      segments: [],
      gaps: [],
      totalRawSamples: 0,
      totalEffectiveCount: 0,
      coveredDuration: 0,
      longestSegmentEffectiveCount: 0,
      longestContiguousDuration: 0,
      mMax: 0,
      mList: [],
      points: [],
      slopeBands: SLOPE_BANDS,
      hasWhiteFrequency: false,
    };
  }

  const { segments, gaps, totalRawSamples } = buildSegments(
    batches,
    source.kind,
    source.tau0
  );

  const totalEffectiveCount = segments.reduce(
    (sum, segment) => sum + segment.effectiveCount,
    0
  );
  const coveredDuration = totalEffectiveCount * source.tau0;
  const longestSegment = segments.reduce((best, segment) =>
    segment.effectiveCount > best.effectiveCount ? segment : best
  );
  const longestSegmentEffectiveCount = longestSegment.effectiveCount;
  const longestContiguousDuration =
    longestSegmentEffectiveCount * source.tau0;

  // τ ≤ T/3 的裁剪按最长连续段做：滑动块必须整块落在同一段内。
  // mMax 随成功追加动态增长，而不是开来源时定死。
  const { mMax } = selectMList(longestSegmentEffectiveCount);
  const mList = candidateMList(mMax);

  const estimator = createOverlappingAllanEstimator();
  const estimations = estimator.estimateSegments(
    segments.map((segment) => segment.values),
    source.kind,
    mList
  );

  const basePoints = estimations
    .filter(({ sigma }) => sigma !== null)
    .map(({ m, sigma, terms }) => ({
      m,
      tau: m * source.tau0,
      sigma,
      terms,
    }));

  // 噪声区段识别与单条提交流程完全一致地走一遍。
  const classifications = classifyNoiseSegments(basePoints);
  const points = basePoints.map((point, index) => ({
    m: point.m,
    tau: point.tau,
    sigma: point.sigma,
    terms: point.terms,
    slope: classifications[index] ? classifications[index].slope : null,
    noiseCode: classifications[index] ? classifications[index].code : null,
    noiseLabel: classifications[index] ? classifications[index].label : null,
  }));

  const hasWhiteFrequency = points.some(
    (point) => point.noiseCode === 'white_frequency'
  );

  return {
    kind: source.kind,
    tau0: source.tau0,
    batchCount: batches.length,
    okBatchCount,
    failedBatchCount,
    hasGaps: gaps.length > 0,
    segmentCount: segments.length,
    // 对外段元数据：剥掉内部估计用的 values
    segments: segments.map(({ values, ...meta }) => meta),
    gaps,
    totalRawSamples,
    totalEffectiveCount,
    coveredDuration,
    longestSegmentEffectiveCount,
    longestContiguousDuration,
    mMax,
    mList,
    points,
    slopeBands: SLOPE_BANDS,
    hasWhiteFrequency,
  };
}

// 摘要口径与单条记录的摘要列表一致：只给覆盖长度、批次计数、有没有缺口、
// 最大平均时间等摘要信息，绝不混入原始样本与逐点曲线。
function jointSummary(sourceId, joint) {
  return {
    id: sourceId,
    status: 'ok',
    kind: joint.kind,
    tau0: joint.tau0,
    batchCount: joint.batchCount,
    okBatchCount: joint.okBatchCount,
    failedBatchCount: joint.failedBatchCount,
    hasGaps: joint.hasGaps,
    segmentCount: joint.segmentCount,
    totalRawSamples: joint.totalRawSamples,
    totalEffectiveCount: joint.totalEffectiveCount,
    coveredDuration: joint.coveredDuration,
    longestSegmentEffectiveCount: joint.longestSegmentEffectiveCount,
    longestContiguousDuration: joint.longestContiguousDuration,
    tauLimitTOver3: joint.longestContiguousDuration / 3,
    mMax: joint.mMax,
    hasWhiteFrequency: joint.hasWhiteFrequency,
  };
}

// 全文：摘要字段 + 段/缺口明细 + 各平均时间点的稳度值与噪声标签。
// 仍不含任何批次的原始样本（段明细只给计数与批次序号范围）。
function jointFullView(sourceId, joint) {
  return {
    ...jointSummary(sourceId, joint),
    segments: joint.segments,
    gaps: joint.gaps,
    mList: joint.mList,
    points: joint.points,
    slopeBands: joint.slopeBands,
  };
}

// 追加一批。返回：
//   { status: 'busy' }                    同来源已有一批在追加（调用方回 409）
//   { status: 'failed', code, ... }       本批失败，已留痕，不影响已有批次
//   { status: 'ok', batchId, seq, joint } 成功并更新联合状态
async function appendBatch(store, source, body) {
  if (!acquireSourceLock(source.id)) {
    return { status: 'busy' };
  }
  try {
    // 让真正同时到达的追加请求在锁上相撞，而不是被事件循环悄悄串成两次成功。
    await nextTick();

    const checked = validateBatchAppend(body, source);
    if (!checked.ok) {
      const rawSamples =
        body && typeof body === 'object' && Array.isArray(body.samples)
          ? body.samples
          : [];
      const batchId = store.insertFailedBatch(source.id, {
        samples: rawSamples,
        code: checked.code,
        reason: checked.reason,
      });
      return {
        status: 'failed',
        batchId,
        code: checked.code,
        failureReason: checked.reason,
      };
    }

    // 预演“已有成功批次 + 本批”的联合状态（seq 与事务内分配一致：
    // 现有成功批次数 + 1）。
    const existingBatches = store.listBatches(source.id);
    const existingOkCount = existingBatches.filter(
      (b) => b.status === 'ok'
    ).length;
    const candidateBatch = {
      status: 'ok',
      seq: existingOkCount + 1,
      gapBefore: checked.gapBefore,
      samples: Array.from(checked.samples),
    };
    const joint = computeJointState(source, [
      ...existingBatches,
      candidateBatch,
    ]);

    // 批次与联合状态在同一个事务里落盘：要么都更新，要么都不动。
    const { batchId, seq } = store.appendSuccessfulBatch(source.id, {
      samples: checked.samples,
      gapBefore: checked.gapBefore,
      jointState: joint,
    });

    return { status: 'ok', batchId, seq, joint };
  } finally {
    releaseSourceLock(source.id);
  }
}

module.exports = {
  createSource,
  appendBatch,
  computeJointState,
  buildSegments,
  jointSummary,
  jointFullView,
  acquireSourceLock,
  releaseSourceLock,
};
