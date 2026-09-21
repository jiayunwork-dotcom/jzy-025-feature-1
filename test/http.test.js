'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { createRecordStore } = require('../src/store');
const { createApp } = require('../src/app');
const { ensurePresetRecord } = require('../src/preset');
const {
  whiteFrequencySamples,
  integrateFrequency,
} = require('../src/synthetic');
const { KINDS } = require('../src/estimator');

let baseUrl;
let store;
let server;

// 与 estimator.test.js 中相同的独立参考实现（不共享生产代码路径）。
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

before(async () => {
  store = createRecordStore(':memory:');
  ensurePresetRecord(store);
  server = createApp(store).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

async function submit(body) {
  const response = await fetch(`${baseUrl}/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

test('预置合成白频率记录：中段斜率接近 -1/2，类型栏标“白频率”', async () => {
  const health = await (await fetch(`${baseUrl}/health`)).json();
  assert.ok(Number.isInteger(health.presetId));

  const preset = await (
    await fetch(`${baseUrl}/records/${health.presetId}`)
  ).json();

  assert.equal(preset.status, 'ok');
  assert.equal(preset.kind, KINDS.FREQUENCY);
  assert.ok(preset.samples.length >= 1000);

  const midPoints = preset.points.filter((p) => p.m >= 20 && p.m <= 100);
  assert.ok(midPoints.length >= 5);
  for (const point of midPoints) {
    assert.ok(
      Math.abs(point.slope - -0.5) <= 0.2,
      `m=${point.m} 处斜率 ${point.slope}`
    );
    assert.equal(point.noiseCode, 'white_frequency');
    assert.equal(point.noiseLabel, '白频率');
  }

  // 斜率区间随记录一起存下来
  assert.equal(preset.slopeBands.length, 3);
});

test('提交白频率序列：201 返回曲线，按记录号取回全文', async () => {
  const samples = Array.from(whiteFrequencySamples(400, 1, 321));
  const { status, payload } = await submit({
    samples,
    tau0: 0.1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(status, 201);
  assert.equal(payload.status, 'ok');
  assert.ok(payload.mList.includes(1));
  assert.ok(payload.points.every((p) => p.tau === p.m * 0.1));
  assert.ok(payload.totalDuration > 0);

  const fetched = await (await fetch(`${baseUrl}/records/${payload.id}`)).json();
  assert.equal(fetched.status, 'ok');
  assert.deepEqual(fetched.samples, samples); // 原始序列完整取回
  assert.deepEqual(fetched.mList, payload.mList);
  assert.deepEqual(fetched.points, payload.points);
  assert.equal(fetched.tau0, 0.1);
  assert.ok(Array.isArray(fetched.slopeBands));
});

test('列表接口只给摘要：点数、τ0、是否识别出白频率段', async () => {
  const listed = await (await fetch(`${baseUrl}/records`)).json();
  assert.ok(Array.isArray(listed.records));
  assert.ok(listed.records.length >= 2);

  for (const summary of listed.records) {
    const keys = Object.keys(summary).sort();
    for (const forbidden of ['samples', 'points', 'mList', 'slopeBands']) {
      assert.ok(
        !keys.includes(forbidden),
        `摘要列表泄露了详细字段 ${forbidden}`
      );
    }
    assert.ok('pointCount' in summary);
    assert.ok('tau0' in summary);
    assert.equal(typeof summary.hasWhiteFrequency, 'boolean');
  }

  const presetSummary = listed.records.find((r) => r.preset === true);
  assert.ok(presetSummary);
  assert.equal(presetSummary.hasWhiteFrequency, true);
});

test('全零序列经 HTTP 提交：所有合法 τ 上 σ_y 精确为 0', async () => {
  const samples = new Array(300).fill(0);
  const { status, payload } = await submit({
    samples,
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(status, 201);
  for (const point of payload.points) {
    assert.ok(Object.is(point.sigma, 0));
  }
});

test('τ 超 T/3 被裁掉：曲线里不出现超限 τ，τ0 物理缩放正确', async () => {
  const n = 200;
  const tau0 = 0.25;
  const { status, payload } = await submit({
    samples: Array.from(whiteFrequencySamples(n, 1, 55)),
    tau0,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(status, 201);
  assert.equal(payload.totalDuration, n * tau0);
  assert.equal(payload.tauLimitTOver3, (n * tau0) / 3);
  // decade 网格（1..9 倍每十倍程）上最大的合法 m：60 < T/3=66.7
  assert.equal(Math.max(...payload.mList), 60);
  assert.ok(payload.points.every((p) => p.tau <= payload.tauLimitTOver3));
  assert.ok(!payload.points.some((p) => p.m === 70));
});

test('钟差与分数频率经 HTTP 提交：同一物理 τ 上 σ_y 一致', async () => {
  const frequencySamples = Array.from(whiteFrequencySamples(400, 1, 888));
  let level = 0;
  const phaseSamples = [0, ...frequencySamples.map((y) => (level += y))];

  const freq = await submit({
    samples: frequencySamples,
    tau0: 2,
    kind: KINDS.FREQUENCY,
  });
  const phase = await submit({
    samples: phaseSamples,
    tau0: 2,
    kind: KINDS.PHASE,
  });

  assert.equal(freq.status, 201);
  assert.equal(phase.status, 201);
  assert.deepEqual(freq.payload.mList, phase.payload.mList);

  for (let i = 0; i < freq.payload.points.length; i += 1) {
    const a = freq.payload.points[i];
    const b = phase.payload.points[i];
    assert.equal(a.tau, b.tau);
    assert.ok(
      Math.abs(a.sigma - b.sigma) / a.sigma < 1e-12,
      `m=${a.m} 处钟差/频率不一致`
    );
  }
});

test('用白频率合成序列卡住“非重叠冒充”：服务 σ 与独立重叠参考一致', async () => {
  const samples = Array.from(whiteFrequencySamples(200, 1, 6));
  const { status, payload } = await submit({
    samples,
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(status, 201);

  for (const m of [30, 40, 50, 60]) {
    const point = payload.points.find((p) => p.m === m);
    assert.ok(point, `候选网格里应包含 m=${m}`);
    const reference = referenceOverlappingFrequency(
      Float64Array.from(samples),
      m
    );
    assert.ok(
      Math.abs(point.sigma - reference) / reference < 1e-12,
      `m=${m} 服务结果偏离独立重叠参考`
    );
  }
});

test('τ0 非正：422 失败态、写明原因，取回时没有曲线', async () => {
  const samples = Array.from(whiteFrequencySamples(100, 1, 1));
  for (const tau0 of [0, -1]) {
    const { status, payload } = await submit({
      samples,
      tau0,
      kind: KINDS.FREQUENCY,
    });
    assert.equal(status, 422);
    assert.equal(payload.status, 'failed');
    assert.ok(payload.id);
    assert.ok(/tau0/.test(payload.failureReason));

    const fetched = await (
      await fetch(`${baseUrl}/records/${payload.id}`)
    ).json();
    assert.equal(fetched.status, 'failed');
    assert.ok(fetched.failureReason.length > 0);
    assert.equal(fetched.points, undefined);
  }
});

test('过短序列：422 失败态；缺项/非有限数同样拒绝', async () => {
  const cases = [
    {
      body: { samples: [1, 2, 3], tau0: 1, kind: KINDS.FREQUENCY },
      reason: /下限/,
    },
    { body: { tau0: 1, kind: KINDS.FREQUENCY }, reason: /samples/ },
    {
      body: {
        samples: [1, NaN, 3, 4, 5, 6, 7, 8],
        tau0: 1,
        kind: KINDS.FREQUENCY,
      },
      reason: /非有限数/,
    },
    {
      body: {
        samples: [1, null, 3, 4, 5, 6, 7, 8],
        tau0: 1,
        kind: KINDS.FREQUENCY,
      },
      reason: /非有限数/,
    },
    {
      body: {
        samples: [1, Infinity, 3, 4, 5, 6, 7, 8],
        tau0: 1,
        kind: KINDS.FREQUENCY,
      },
      reason: /非有限数/,
    },
    {
      body: { samples: [1, 2, 3, 4, 5, 6, 7, 8], kind: KINDS.FREQUENCY },
      reason: /tau0/,
    },
    {
      body: { samples: [1, 2, 3, 4, 5, 6, 7, 8], tau0: 1, kind: 'bogus' },
      reason: /kind/,
    },
    {
      // 钟差 9 点才够 8 个差分频率点；8 点必须拒绝
      body: {
        samples: [1, 2, 3, 4, 5, 6, 7, 8],
        tau0: 1,
        kind: KINDS.PHASE,
      },
      reason: /下限/,
    },
  ];

  for (const { body, reason } of cases) {
    const { status, payload } = await submit(body);
    assert.equal(status, 422);
    assert.equal(payload.status, 'failed');
    assert.ok(reason.test(payload.failureReason), payload.failureReason);
  }
});

test('不存在的记录号 404；非法 JSON 400 且不落记录', async () => {
  const beforeList = await (await fetch(`${baseUrl}/records`)).json();

  const notFound = await fetch(`${baseUrl}/records/999999`);
  assert.equal(notFound.status, 404);

  const badJson = await fetch(`${baseUrl}/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  });
  assert.equal(badJson.status, 400);

  const afterList = await (await fetch(`${baseUrl}/records`)).json();
  assert.equal(afterList.records.length, beforeList.records.length);
});

test('失败记录之间互不污染：失败后再提交成功序列结果正常', async () => {
  const failed = await submit({
    samples: [1, 2, 3],
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(failed.status, 422);

  const samples = Array.from(whiteFrequencySamples(300, 1.5, 4242));
  const ok = await submit({
    samples,
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(ok.status, 201);
  assert.ok(ok.payload.points.length > 5);
  for (const point of ok.payload.points) {
    assert.ok(Number.isFinite(point.sigma) && point.sigma > 0);
  }
});
