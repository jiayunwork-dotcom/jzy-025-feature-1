'use strict';

// HTTP 层：本服务做两件事——
//   单条记录段：提交、取回曲线；
//   物理来源：开来源、分批追加、取回多批联合曲线。
//   POST   /records                 提交一条记录段（成功 201；校验失败 422 且进失败态）
//   GET    /records                 记录摘要列表（点数、τ0、是否识别出白频率段）
//   GET    /records/:id             按记录号取回全文（原始序列、m 列表、曲线、类型、斜率区间）
//   POST   /sources                 开一个物理来源（声明 tau0、kind）
//   GET    /sources                 来源摘要列表
//   POST   /sources/:id/batches     向来源追加一批（422 本批失败；409 同来源并发追加）
//   GET    /sources/:id             来源联合曲线全文（摘要 + 段/缺口 + 逐点）
//   GET    /sources/:id/summary     来源联合曲线摘要
//   GET    /health                  存活检查

const express = require('express');
const { processSubmission } = require('./pipeline');
const { PRESET } = require('./synthetic');
const {
  createSource,
  appendBatch,
  computeJointState,
  jointSummary,
  jointFullView,
} = require('./sourcePipeline');

function parseIdParam(value) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || String(id) !== value) {
    return null;
  }
  return id;
}

function createApp(store) {
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

  app.get('/records/:id', (req, res, next) => {
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

  // ---- 物理来源 ----

  app.post('/sources', (req, res) => {
    const result = createSource(store, req.body);
    if (result.status === 'failed') {
      // 来源没开成，不落任何来源记录。
      res.status(422).json({
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
    });
  });

  app.get('/sources', (req, res) => {
    // 摘要口径与 /records 一致：不带样本、不带逐点曲线。
    // 联合摘要始终由已落盘批次重算，保证与全文接口同一口径。
    const summaries = store.listSourceSummaries().map((row) => {
      const source = store.getSourceById(row.id);
      const joint = computeJointState(source, store.listBatches(row.id));
      return {
        ...jointSummary(row.id, joint),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    });
    res.json({ sources: summaries });
  });

  app.post('/sources/:id/batches', async (req, res, next) => {
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

    try {
      const result = await appendBatch(store, source, req.body);
      if (result.status === 'busy') {
        // 同一时刻只允许一批在追加：明确 409，调用方稍后重试即可，
        // 绝不会把同一批计入两次或把联合状态写乱。
        res.status(409).json({
          status: 'busy',
          code: 'SOURCE_APPEND_IN_PROGRESS',
          failureReason: '该来源已有一批追加正在处理，请稍后重试',
        });
        return;
      }
      if (result.status === 'failed') {
        // 只让这一批失败（已作为失败批次留痕），来源已有批次不受影响。
        res.status(422).json({
          batchId: result.batchId,
          status: 'failed',
          code: result.code,
          failureReason: result.failureReason,
        });
        return;
      }

      res.status(201).json({
        batchId: result.batchId,
        seq: result.seq,
        status: 'ok',
        // 追加成功即返回最新联合摘要，便于调用方确认覆盖长度的动态增长
        summary: jointSummary(id, result.joint),
      });
    } catch (error) {
      next(error);
    }
  });

  function loadSourceOrRespond(req, res) {
    const id = parseIdParam(req.params.id);
    if (id === null) {
      res.status(400).json({ error: '来源号必须是正整数' });
      return null;
    }
    const source = store.getSourceById(id);
    if (!source) {
      res.status(404).json({ error: `来源 ${id} 不存在` });
      return null;
    }
    // 始终从已落盘批次重算，保证取回结果与“整段首尾相连一次性提交”一致；
    // 持久化的 joint_state_json 只是加速/留痕，重启后同样重算得出。
    const joint = computeJointState(source, store.listBatches(id));
    return { source, joint };
  }

  app.get('/sources/:id', (req, res) => {
    const loaded = loadSourceOrRespond(req, res);
    if (!loaded) {
      return;
    }
    res.json(jointFullView(Number.parseInt(req.params.id, 10), loaded.joint));
  });

  app.get('/sources/:id/summary', (req, res) => {
    const loaded = loadSourceOrRespond(req, res);
    if (!loaded) {
      return;
    }
    res.json(jointSummary(Number.parseInt(req.params.id, 10), loaded.joint));
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
