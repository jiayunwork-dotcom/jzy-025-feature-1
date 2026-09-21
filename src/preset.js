'use strict';

// 预置合成白频率记录的装载：每个存储只放一条，重复启动不重复插入。

const { PRESET } = require('./synthetic');
const { processSubmission } = require('./pipeline');

function ensurePresetRecord(store) {
  const existingId = store.getPresetId();
  if (existingId !== null) {
    return existingId;
  }

  const result = processSubmission(
    store,
    {
      kind: PRESET.kind,
      tau0: PRESET.tau0,
      samples: Array.from(PRESET.build()),
    },
    { preset: true }
  );

  if (result.status !== 'ok') {
    throw new Error(`预置白频率记录生成失败：${result.failureReason}`);
  }
  return result.id;
}

module.exports = { ensurePresetRecord };
