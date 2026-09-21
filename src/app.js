'use strict';

// HTTP 层：
//   单条记录（既有）
//   POST /records       提交一条记录段（成功 201；校验失败 422 且进失败态）
//   GET  /records       记录摘要列表（点数、τ0、是否识别出白频率段）
//   GET  /records/:id   按记录号取回全文
//
//   分批来源（本次新增）：声明同一物理来源后陆续追加批次，
//   服务按一整条不间断序列（带残缺区间标记）计算联合稳定度曲线
//   POST /sources                 开来源（钉死 kind / tau0）
//   POST /sources/:id/batches     追加一批（同一来源串行，并发 409）
//   GET  /sources                 来源摘要列表（不含原始样本与明细点位）
//   GET  /sources/:id             来源全文（联合曲线点位与噪声标签）
//   GET  /sources/:id/summary     单个来源摘要
//
//   GET  /health                  存活检查

const express = require('express');
const { processSubmission } = require('./pipeline');
const { createSourceService } = require('./sourcePipeline');
const { PRESET } = require('./synthetic');

// 来源摘要字段：覆盖长度、批次数、残缺段、最大平均时间等；
// 绝不包含原始样本（samples）与曲线明细点位（points）。
function sourceSummary(source) {
  const state = source.jointState;
  return {
    id: source.id,
    kind: source.kind,
    tau0: source.tau0,
    batchCount: source.batchCount,
    okBatchCount: source.okBatchCount,
    curveStatus: state.curveStatus,
    spanSamples: state.spanSamples,
    coveredSamples: state.coveredSamples,
    gapSamples: state.gapSamples,
    unknownGaps: state.unknownGaps,
    hasGaps: state.hasGaps,
    gaps: state.gaps,
    effectiveSampleCount: state.effectiveSampleCount,
    totalDuration: state.totalDuration,
    coveredDuration: state.coveredDuration,
    mMax: state.mMax,
    tauLimitTOver3: state.totalDuration / 3,
    hasWhiteFrequency: state.hasWhiteFrequency,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

// 来源全文 = 摘要 + 联合曲线明细。
function sourceFull(source) {
  const state = source.jointState;
  return {
    ...sourceSummary(source),
    mList: state.mList,
    points: state.points,
    slopeBands: state.slopeBands,
  };
}

function parseIdParam(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || String(id) !== value) {
    return null;
  }
  return id;
}

function createApp(store, sourceService = createSourceService()) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      presetId: store.getPresetId(),
      minSamples: 8,
      preset: {
        kind: PRESET.kind,
        tau0: PRESET.tau0,
        length: PRESET.length,
      },
    });
  });

  app.post('/records', (req, res) => {
    const result = processSubmission(store, req.body);
    if (result.status === 'failed') {
      // 已落盘为失败态；明确 4xx，绝不回“完整曲线”。
      res.status(422).json({
        id: result.id,
        status: 'failed',
        code: result.code,
        failureReason: result.failureReason,
      });
      return;
    }

    res.status(201).json({
      id: result.id,
      status: 'ok',
      kind: result.kind,
      tau0: result.tau0,
      totalDuration: result.totalDuration,
      tauLimitTOver3: result.totalDuration / 3,
      mList: result.mList,
      points: result.points,
      slopeBands: result.slopeBands,
      hasWhiteFrequency: result.hasWhiteFrequency,
    });
  });

  app.get('/records', (req, res) => {
    res.json({ records: store.listSummaries() });
  });

  app.get('/records/:id', (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: '记录号必须是正整数' });
      return;
    }
    const record = store.getById(id);
    if (!record) {
      res.status(404).json({ error: `记录 ${id} 不存在` });
      return;
    }
    res.json(record);
  });

  // ---- 分批来源 ----------------------------------------------------------

  app.post('/sources', (req, res) => {
    const result = sourceService.createSource(store, req.body);
    if (result.status !== 'ok') {
      // 来源元数据不合法：不落任何来源。
      res.status(422).json({
        status: 'rejected',
        code: result.code,
        failureReason: result.failureReason,
      });
      return;
    }

    const source = store.getSourceById(result.id);
    res.status(201).json({ status: 'ok', ...sourceSummary(source) });
  });

  // 追加锁归来源服务所有（见 sourcePipeline.js）：同一来源同一时刻只
  // 允许一批追加进入处理，并发的第二批得到 409。这里不做 HTTP 层计时，
  // 由服务在取锁后让出微任务节拍，使真正同刻并发的追加在取锁点确定
  // 地互斥；落盘本体仍是同步事务，保证绝不重复计入。
  app.post('/sources/:id/batches', async (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: '来源号必须是正整数' });
      return;
    }

    let result;
    try {
      result = await sourceService.appendBatch(store, id, req.body);
    } catch (error) {
      res.status(500).json({ error: '服务内部错误' });
      return;
    }

    if (result.status === 'busy') {
      res.status(409).json({
        error: `来源 ${id} 已有一批追加正在处理，请串行追加`,
        code: 'APPEND_IN_PROGRESS',
      });
      return;
    }
    if (result.status === 'not_found') {
      res.status(404).json({ error: `来源 ${id} 不存在` });
      return;
    }
    if (result.status === 'rejected') {
      // 元数据矛盾（类型/采样间隔不一致等）：不落批次、联合状态不变。
      res.status(422).json({
        status: 'rejected',
        code: result.code,
        failureReason: result.failureReason,
      });
      return;
    }

    const source = store.getSourceById(id);
    if (result.status === 'failed') {
      // 本批数据失败：已落为失败批次（残缺区间），其它批次不受影响。
      res.status(422).json({
        status: 'failed',
        batchId: result.batchId,
        seq: result.seq,
        code: result.code,
        failureReason: result.failureReason,
        source: sourceSummary(source),
      });
      return;
    }

    res.status(201).json({
      status: 'ok',
      batchId: result.batchId,
      seq: result.seq,
      ...sourceFull(source),
    });
  });

  app.get('/sources', (req, res) => {
    res.json({ sources: store.listSources().map(sourceSummary) });
  });

  app.get('/sources/:id/summary', (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: '来源号必须是正整数' });
      return;
    }
    const source = store.getSourceById(id);
    if (!source) {
      res.status(404).json({ error: `来源 ${id} 不存在` });
      return;
    }
    res.json(sourceSummary(source));
  });

  app.get('/sources/:id', (req, res) => {
    const id = parseIdParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: '来源号必须是正整数' });
      return;
    }
    const source = store.getSourceById(id);
    if (!source) {
      res.status(404).json({ error: `来源 ${id} 不存在` });
      return;
    }
    res.json(sourceFull(source));
  });

  // 请求体不是合法 JSON 等解析错误：拒绝，不落任何记录。
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: '请求体不是合法 JSON' });
      return;
    }
    res.status(500).json({ error: '服务内部错误' });
  });

  return app;
}

module.exports = { createApp };
