'use strict';

// HTTP 层：本服务只做一件事——提交记录段、取回曲线。
//   POST /records       提交一条记录段（成功 201；校验失败 422 且进失败态）
//   GET  /records       记录摘要列表（点数、τ0、是否识别出白频率段）
//   GET  /records/:id   按记录号取回全文（原始序列、m 列表、曲线、类型、斜率区间）
//   GET  /health        存活检查

const express = require('express');
const { processSubmission } = require('./pipeline');
const { PRESET } = require('./synthetic');

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
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || String(id) !== req.params.id) {
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
