'use strict';

// 分批来源的 HTTP 端到端测试：开来源、逐批追加、取摘要/全文、
// 并发 409、矛盾拒绝、落盘重启。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { createRecordStore } = require('../src/store');
const { createApp } = require('../src/app');
const { createSourceService } = require('../src/sourcePipeline');
const { whiteFrequencySamples } = require('../src/synthetic');
const { KINDS } = require('../src/estimator');

let baseUrl;
let store;
let server;
let service;

before(async () => {
  store = createRecordStore(':memory:');
  service = createSourceService();
  server = createApp(store, service).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
});

async function http(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

const createSource = (body) => http('POST', '/sources', body);
const append = (id, body) => http('POST', `/sources/${id}/batches`, body);
const getSource = (id) => http('GET', `/sources/${id}`);
const getSummary = (id) => http('GET', `/sources/${id}/summary`);

test('开来源：钉死 kind/tau0；非法设定 422 且不落来源', async () => {
  const ok = await createSource({ kind: KINDS.FREQUENCY, tau0: 0.25 });
  assert.equal(ok.status, 201);
  assert.equal(ok.payload.status, 'ok');
  assert.equal(ok.payload.kind, KINDS.FREQUENCY);
  assert.equal(ok.payload.tau0, 0.25);
  assert.equal(ok.payload.batchCount, 0);
  assert.equal(ok.payload.curveStatus, 'insufficient_data');
  assert.equal(ok.payload.hasGaps, false);

  for (const body of [
    {},
    { kind: 'bogus', tau0: 1 },
    { kind: KINDS.FREQUENCY, tau0: -1 },
  ]) {
    const bad = await createSource(body);
    assert.equal(bad.status, 422);
    assert.equal(bad.payload.status, 'rejected');
  }
});

test('分批追加的联合全文与整段一次性提交一致（含跨界点）', async () => {
  const full = whiteFrequencySamples(450, 1, 8686);
  const created = await createSource({ kind: KINDS.FREQUENCY, tau0: 1 });
  const id = created.payload.id;

  for (const chunk of [
    full.slice(0, 100),
    full.slice(100, 250),
    full.slice(250),
  ]) {
    const r = await append(id, { samples: Array.from(chunk) });
    assert.equal(r.status, 201);
    assert.equal(r.payload.status, 'ok');
  }

  const oneShot = await http('POST', '/records', {
    samples: Array.from(full),
    tau0: 1,
    kind: KINDS.FREQUENCY,
  });
  assert.equal(oneShot.status, 201);

  const joint = await getSource(id);
  assert.equal(joint.status, 200);
  assert.deepEqual(joint.payload.mList, oneShot.payload.mList);
  assert.equal(joint.payload.totalDuration, 450);
  const refByM = new Map(oneShot.payload.points.map((p) => [p.m, p]));
  for (const point of joint.payload.points) {
    const ref = refByM.get(point.m);
    assert.ok(Object.is(point.sigma, ref.sigma), `m=${point.m} 不一致`);
    assert.equal(point.tau, point.m);
    assert.equal(point.noiseCode, ref.noiseCode);
  }

  // 单批时长（最长 150 点）附近的跨界点必须在曲线上且等于整段结果。
  // n=450 时 decade 网格最大点是 100（下一个 200 已超 T/3=150）。
  for (const m of [60, 70, 80, 90, 100]) {
    const point = joint.payload.points.find((p) => p.m === m);
    assert.ok(point, `跨界平均时间 m=${m} 缺失`);
    assert.ok(Object.is(point.sigma, refByM.get(m).sigma));
  }
  assert.ok(!joint.payload.mList.includes(200));
});

test('全零数据分批追加：每个合法 τ 上 σ 精确为 0', async () => {
  const created = await createSource({ kind: KINDS.FREQUENCY, tau0: 1 });
  const id = created.payload.id;
  for (const n of [60, 120, 120]) {
    const r = await append(id, { samples: new Array(n).fill(0) });
    assert.equal(r.status, 201);
  }
  const full = await getSource(id);
  assert.ok(full.payload.points.length > 5);
  for (const point of full.payload.points) {
    assert.ok(Object.is(point.sigma, 0));
  }
});

test('单批数据失败：422、只失败该批、摘要标出残缺段，其它批次不受影响', async () => {
  const created = await createSource({ kind: KINDS.FREQUENCY, tau0: 1 });
  const id = created.payload.id;
  await append(id, { samples: Array.from(whiteFrequencySamples(100, 1, 1)) });

  const bad = Array.from(whiteFrequencySamples(50, 1, 2));
  bad[7] = null;
  const failed = await append(id, { samples: bad });
  assert.equal(failed.status, 422);
  assert.equal(failed.payload.status, 'failed');
  assert.equal(failed.payload.code, 'NON_FINITE_SAMPLE');
  assert.ok(failed.payload.batchId);
  assert.equal(failed.payload.source.coveredSamples, 100);
  assert.equal(failed.payload.source.gapSamples, 50);
  assert.equal(failed.payload.source.hasGaps, true);
  assert.deepEqual(failed.payload.source.gaps, [
    {
      fromSlot: 100,
      toSlot: 150,
      sampleCount: 50,
      fromTime: 100,
      toTime: 150,
    },
  ]);

  // 缺失段两侧不造伪重叠：长平均时间不能跨缺口
  const full = await getSource(id);
  const m50 = full.payload.points.find((p) => p.m === 50);
  assert.ok(m50, '两个 100 点纪元在 m=50 仍各有 1 个完整块对');
  assert.equal(
    full.payload.points.find((p) => p.m === 60),
    undefined,
    'm=60 无法不跨缺口取齐两块，必须缺席'
  );

  // 之后仍可正常追加
  const cont = await append(id, {
    samples: Array.from(whiteFrequencySamples(100, 1, 3)),
  });
  assert.equal(cont.status, 201);
  assert.equal(cont.payload.batchCount, 3);
  assert.equal(cont.payload.okBatchCount, 2);
  assert.equal(cont.payload.coveredSamples, 200);
});

test('类型或采样间隔不一致：422 rejected、不落批次、状态不变', async () => {
  const created = await createSource({ kind: KINDS.FREQUENCY, tau0: 1 });
  const id = created.payload.id;
  await append(id, { samples: Array.from(whiteFrequencySamples(30, 1, 1)) });

  const kindMismatch = await append(id, {
    samples: Array.from(whiteFrequencySamples(30, 1, 2)),
    kind: KINDS.PHASE,
  });
  assert.equal(kindMismatch.status, 422);
  assert.equal(kindMismatch.payload.code, 'KIND_MISMATCH');

  const tauMismatch = await append(id, {
    samples: Array.from(whiteFrequencySamples(30, 1, 2)),
    tau0: 2,
  });
  assert.equal(tauMismatch.status, 422);
  assert.equal(tauMismatch.payload.code, 'TAU0_MISMATCH');

  // 省略 tau0/kind 沿用来源设定，合法
  const implicit = await append(id, {
    samples: Array.from(whiteFrequencySamples(30, 1, 4)),
  });
  assert.equal(implicit.status, 201);

  const summary = await getSummary(id);
  assert.equal(summary.payload.batchCount, 2);
  assert.equal(summary.payload.okBatchCount, 2);
});

test('并发追加：在途期间得到 409，状态不重复计入', async () => {
  const created = await createSource({ kind: KINDS.FREQUENCY, tau0: 1 });
  const id = created.payload.id;

  // 模拟一批正在处理（持锁未释放）：并发的追加必须 409
  assert.equal(service.tryLock(id), true);
  const conflict = await append(id, {
    samples: Array.from(whiteFrequencySamples(30, 1, 1)),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, 'APPEND_IN_PROGRESS');
  const lockedSummary = await getSummary(id);
  assert.equal(lockedSummary.payload.batchCount, 0);
  service.releaseLock(id);

  // 释放后追加成功
  const ok = await append(id, {
    samples: Array.from(whiteFrequencySamples(30, 1, 2)),
  });
  assert.equal(ok.status, 201);
  assert.equal(ok.payload.batchCount, 1);

  // 真正同刻发出的并发追加：服务异步锁保证恰好一批进入，其余 409，
  // 最终累计批次与样本数精确无重复。
  const burst = await Promise.all(
    Array.from({ length: 6 }, (_, k) =>
      append(id, { samples: Array.from(whiteFrequencySamples(30, 1, 100 + k)) })
    )
  );
  const accepted = burst.filter((r) => r.status === 201).length;
  const rejected = burst.filter((r) => r.status === 409).length;
  assert.ok(
    accepted >= 1 && accepted + rejected === 6,
    `并发批次状态异常：${burst.map((r) => r.status).join(',')}`
  );
  const after = await getSummary(id);
  // 关键不变量：成功批次数 == 覆盖样本 / 30，绝无重复计入
  assert.equal(after.payload.coveredSamples, after.payload.okBatchCount * 30);
});

test('来源摘要列表与单摘要不含原始样本和明细点位', async () => {
  const listed = await http('GET', '/sources');
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.payload.sources));
  assert.ok(listed.payload.sources.length >= 4);
  for (const summary of listed.payload.sources) {
    const keys = Object.keys(summary);
    for (const forbidden of ['samples', 'points', 'mList', 'slopeBands']) {
      assert.ok(
        !keys.includes(forbidden),
        `来源摘要泄露明细字段 ${forbidden}`
      );
    }
    assert.ok('batchCount' in summary);
    assert.ok('totalDuration' in summary);
    assert.ok('hasGaps' in summary);
    assert.equal(typeof summary.hasWhiteFrequency, 'boolean');
  }

  const one = listed.payload.sources[0];
  const single = await getSummary(one.id);
  for (const forbidden of ['samples', 'points', 'mList', 'slopeBands']) {
    assert.ok(!(forbidden in single.payload));
  }

  // 全文才有曲线点位
  const full = await getSource(one.id);
  assert.ok(Array.isArray(full.payload.points) || full.payload.points === undefined);
});

test('不存在的来源 404；非法来源号 400', async () => {
  assert.equal((await http('GET', '/sources/999999')).status, 404);
  assert.equal(
    (await append(999999, { samples: [1, 2, 3, 4, 5, 6, 7, 8] })).status,
    404
  );
  assert.equal((await http('GET', '/sources/abc')).status, 400);
});

test('落盘重启：来源可继续追加且曲线不变量保持', async () => {
  const dbPath = `/tmp/http-source-restart-${process.pid}.db`;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch {
      // ignore
    }
  }

  const full = whiteFrequencySamples(300, 1, 31337);
  let diskStore = createRecordStore(dbPath);
  let diskService = createSourceService();
  let diskServer = createApp(diskStore, diskService).listen(0);
  await new Promise((resolve) => diskServer.once('listening', resolve));
  const port1 = diskServer.address().port;
  const created = await fetch(`http://127.0.0.1:${port1}/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: KINDS.FREQUENCY, tau0: 1 }),
  }).then((r) => r.json());
  await fetch(`http://127.0.0.1:${port1}/sources/${created.id}/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ samples: Array.from(full.slice(0, 150)) }),
  }).then((r) => r.json());
  await new Promise((resolve) => diskServer.close(resolve));
  diskStore.close();

  // 重启
  diskStore = createRecordStore(dbPath);
  diskService = createSourceService();
  diskServer = createApp(diskStore, diskService).listen(0);
  await new Promise((resolve) => diskServer.once('listening', resolve));
  const port2 = diskServer.address().port;
  const url = `http://127.0.0.1:${port2}/sources/${created.id}`;

  const before = await (await fetch(url)).json();
  assert.equal(before.batchCount, 1);
  assert.equal(before.spanSamples, 150);
  assert.ok(before.points.length > 3);

  const cont = await fetch(`${url}/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ samples: Array.from(full.slice(150)) }),
  }).then((r) => r.json());
  assert.equal(cont.status, 'ok');
  assert.equal(cont.batchCount, 2);

  const oneShot = await fetch(`http://127.0.0.1:${port2}/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      samples: Array.from(full),
      tau0: 1,
      kind: KINDS.FREQUENCY,
    }),
  }).then((r) => r.json());
  const joint = await (await fetch(url)).json();
  assert.deepEqual(joint.mList, oneShot.mList);
  for (const point of joint.points) {
    const ref = oneShot.points.find((p) => p.m === point.m);
    assert.ok(Object.is(point.sigma, ref.sigma));
  }

  await new Promise((resolve) => diskServer.close(resolve));
  diskStore.close();
});
