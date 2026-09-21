'use strict';

// 来源（分批连续采集）的业务编排：开来源、串行追加批次、
// 把已成功批次拼成一条时间线重算联合稳定度曲线并落盘。
//
// 联合状态在每次追加成功后整体重算（不是增量修补），因此天然
// 等价于“把目前所有成功批次首尾相连走一次单条整段流程”，
// 包括同一套 decade τ 网格、同一条 T/3 裁剪、同一套噪声识别。

const { KINDS } = require('./estimator');
const { selectMList } = require('./tauGrid');
const { classifyNoiseSegments, SLOPE_BANDS } = require('./noise');
const {
  validateSourceCreation,
  validateBatchAppend,
} = require('./sourceValidation');
const { buildTimeline, estimateTimeline } = require('./sourceEstimator');

// 一个来源同一时刻只允许一批追加在处理。锁为进程内互斥量，由
// appendBatch 异步入口获取、finally 释放（见下）。
function createAppendLocks() {
  const locked = new Set();
  return {
    tryAcquire(sourceId) {
      if (locked.has(sourceId)) {
        return false;
      }
      locked.add(sourceId);
      return true;
    },
    release(sourceId) {
      locked.delete(sourceId);
    },
  };
}

function createSourceService() {
  const locks = createAppendLocks();

  // 从存储的批次行重建估计器输入：成功批次还原 Float64Array。
  function batchesForEstimate(source, storedBatches) {
    return storedBatches.map((batch) => {
      if (batch.status === 'ok') {
        return { status: 'ok', samples: Float64Array.from(batch.samples) };
      }
      return {
        status: 'failed',
        sampleCount: batch.sampleCount,
      };
    });
  }

  // 由当前全部批次重算联合状态（曲线 + 摘要）。
  function recomputeJointState(source, storedBatches) {
    const timeline = buildTimeline(
      batchesForEstimate(source, storedBatches),
      source.kind
    );
    const tau0 = source.tau0;

    // 有效分数频率点数：频率=槽数；钟差=槽数−1（与单条流程一致）。
    const effectiveCount =
      source.kind === KINDS.FREQUENCY
        ? timeline.slotCount
        : Math.max(0, timeline.slotCount - 1);

    const { mMax, mList } = selectMList(effectiveCount);
    const estimations = estimateTimeline(timeline, mList);

    const basePoints = estimations.map(({ m, sigma, terms }) => ({
      m,
      tau: m * tau0,
      sigma,
      terms,
    }));
    // 噪声识别只用 τ / σ；残缺导致整条被丢的 m 已不在 basePoints 里。
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

    const spanDuration = effectiveCount * tau0;
    const coveredSamples = timeline.coveredSamples;
    const coveredEffective =
      source.kind === KINDS.FREQUENCY
        ? coveredSamples
        : Math.max(0, coveredSamples - timeline.epochs.length);
    const gaps = timeline.gaps.map((gap) => ({
      fromSlot: gap.from,
      toSlot: gap.to,
      sampleCount: gap.to - gap.from,
      fromTime: gap.from * tau0,
      toTime: gap.to * tau0,
    }));

    return {
      // 摘要口径
      batchCount: storedBatches.length,
      okBatchCount: storedBatches.filter((b) => b.status === 'ok').length,
      spanSamples: timeline.slotCount,
      coveredSamples,
      gapSamples: timeline.gapSamples,
      unknownGaps: timeline.barriers,
      hasGaps: timeline.gaps.length > 0 || timeline.barriers > 0,
      gaps,
      effectiveSampleCount: effectiveCount,
      totalDuration: spanDuration, // 当前已知槽位覆盖到的总时长
      coveredDuration: coveredEffective * tau0,
      mMax,
      // 全文口径
      curveStatus: mList.length === 0 ? 'insufficient_data' : 'ok',
      mList: points.map((p) => p.m),
      points: points.map(({ terms, ...rest }) => rest),
      slopeBands: SLOPE_BANDS,
      hasWhiteFrequency,
    };
  }

  // 空来源的初始联合状态：什么都还没有，曲线不可用。
  function createSource(store, body) {
    const checked = validateSourceCreation(body);
    if (!checked.ok) {
      return {
        status: 'rejected',
        code: checked.code,
        failureReason: checked.reason,
      };
    }

    const sourceMeta = { kind: checked.kind, tau0: checked.tau0 };
    // 先建一个临时对象只为算初始状态；insertSource 后带上真实 id。
    const initial = recomputeJointState(sourceMeta, []);
    const id = store.insertSource({
      kind: checked.kind,
      tau0: checked.tau0,
      jointState: initial,
    });

    return {
      status: 'ok',
      id,
      kind: checked.kind,
      tau0: checked.tau0,
      jointState: initial,
    };
  }

  // 一个来源同一时刻只允许一批追加在处理。追加是异步入口：取到锁后
  // 先让出一个微任务节拍再做同步落盘，于是“同一时刻并发发出”的多个
  // 追加在取锁那一刻就确定地撞在一起（恰好一个进入处理，其余得到
  // busy）。真正写状态的 doAppend 本体是同步 SQLite 事务：即使没有
  // 409 拦截，多个追加也会被事件循环串行化、各自恰好计入一次，绝不
  // 可能交错写坏联合状态或把同一批计入两次。
  function appendBatchAsync(store, sourceId, body) {
    if (!locks.tryAcquire(sourceId)) {
      return Promise.resolve({ status: 'busy' });
    }
    return Promise.resolve()
      .then(() => doAppend(store, sourceId, body))
      .finally(() => locks.release(sourceId));
  }

  function doAppend(store, sourceId, body) {
    const source = store.getSourceById(sourceId);
    if (!source) {
      return { status: 'not_found' };
    }

    const checked = validateBatchAppend(body, source);
    if (!checked.ok && checked.rejected) {
      // 元数据矛盾 / 调用方式错误：拒绝，不落批次、不动联合状态。
      return {
        status: 'rejected',
        code: checked.code,
        failureReason: checked.reason,
      };
    }

    const storedBatches = store.listBatches(sourceId);

    if (!checked.ok) {
      // 本批数据有问题：只让这一批失败，其它批次不受影响。
      // 在时间线上留下与本批等长的残缺区间（长度未知时为屏障）。
      const failedBatch = {
        status: 'failed',
        sampleCount: checked.rawSamples.length,
        samples: checked.rawSamples, // 原样保留（NaN/Infinity 序列化为 null）
        failureCode: checked.code,
        failureReason: checked.reason,
      };
      const nextBatches = storedBatches.concat([
        {
          status: 'failed',
          sampleCount: failedBatch.sampleCount,
        },
      ]);
      const jointState = recomputeJointState(source, nextBatches);
      const { batchId, seq } = store.appendBatch(sourceId, failedBatch, {
        batchCount: jointState.batchCount,
        okBatchCount: jointState.okBatchCount,
        jointState,
      });
      return {
        status: 'failed',
        batchId,
        seq,
        code: checked.code,
        failureReason: checked.reason,
        jointState,
      };
    }

    const samplesArray = Array.from(checked.samples);
    const nextBatches = storedBatches.concat([
      { status: 'ok', samples: checked.samples },
    ]);
    const jointState = recomputeJointState(source, nextBatches);
    const { batchId, seq } = store.appendBatch(
      sourceId,
      {
        status: 'ok',
        sampleCount: samplesArray.length,
        samples: samplesArray,
      },
      {
        batchCount: jointState.batchCount,
        okBatchCount: jointState.okBatchCount,
        jointState,
      }
    );

    return { status: 'ok', batchId, seq, jointState };
  }

  return {
    createSource,
    appendBatch: appendBatchAsync,
    doAppend,
    recomputeJointState,
    tryLock: (sourceId) => locks.tryAcquire(sourceId),
    releaseLock: (sourceId) => locks.release(sourceId),
  };
}

module.exports = {
  createSourceService,
  createAppendLocks,
};
