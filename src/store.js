'use strict';

// 记录段持久化：进程内 SQLite（better-sqlite3），不依赖外部数据库。
// 成功与失败提交都落盘；失败记录绝不附带曲线数据。

const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const DEFAULT_DB_PATH =
  process.env.DB_PATH || path.join(__dirname, '..', 'data', 'records.db');

function openDatabase(dbPath = DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      status         TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      kind           TEXT,
      tau0           REAL,
      sample_count   INTEGER NOT NULL,
      samples_json   TEXT NOT NULL,
      m_list_json    TEXT,
      points_json    TEXT,
      slope_bands_json TEXT,
      has_white_frequency INTEGER NOT NULL DEFAULT 0,
      failure_reason TEXT,
      preset         INTEGER NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_records_preset ON records(preset);

    -- 物理“来源”：声明一次采样间隔 tau0 与数据类型 kind，之后可陆续
    -- 追加批次。来源本身的联合状态（段、缺口、联合曲线）随成功追加更新。
    CREATE TABLE IF NOT EXISTS sources (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      kind             TEXT NOT NULL CHECK (kind IN ('phase', 'frequency')),
      tau0             REAL NOT NULL CHECK (tau0 > 0),
      joint_state_json TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 来源名下的每一次批次追加（成功或失败都落盘）。
    -- 成功批次按成功顺序拿连续 seq；失败批次 seq 恒为 NULL，不占位、
    -- 不影响段结构，只留下失败痕迹。
    CREATE TABLE IF NOT EXISTS source_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id      INTEGER NOT NULL REFERENCES sources(id),
      seq            INTEGER,
      status         TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      gap_before      INTEGER NOT NULL DEFAULT 0,
      sample_count   INTEGER NOT NULL,
      samples_json   TEXT NOT NULL,
      failure_code   TEXT,
      failure_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_source_batches_source
      ON source_batches(source_id, id);
  `);

  return db;
}

function createRecordStore(dbPath = DEFAULT_DB_PATH) {
  const db = openDatabase(dbPath);

  const insertStmt = db.prepare(`
    INSERT INTO records (
      status, kind, tau0, sample_count, samples_json,
      m_list_json, points_json, slope_bands_json,
      has_white_frequency, failure_reason, preset
    ) VALUES (
      @status, @kind, @tau0, @sampleCount, @samplesJson,
      @mListJson, @pointsJson, @slopeBandsJson,
      @hasWhiteFrequency, @failureReason, @preset
    )
  `);

  const getStmt = db.prepare('SELECT * FROM records WHERE id = ?');
  const listStmt = db.prepare(
    'SELECT id, status, kind, tau0, sample_count, has_white_frequency, failure_reason, preset, created_at FROM records ORDER BY id'
  );
  const presetStmt = db.prepare(
    "SELECT id FROM records WHERE preset = 1 ORDER BY id LIMIT 1"
  );

  // ---- 来源 / 批次 ----
  const insertSourceStmt = db.prepare(`
    INSERT INTO sources (kind, tau0, joint_state_json)
    VALUES (@kind, @tau0, NULL)
  `);
  const getSourceStmt = db.prepare('SELECT * FROM sources WHERE id = ?');
  const listSourcesStmt = db.prepare(
    `SELECT s.id, s.kind, s.tau0, s.created_at, s.updated_at,
            (SELECT COUNT(*) FROM source_batches b WHERE b.source_id = s.id) AS batch_count,
            (SELECT COUNT(*) FROM source_batches b WHERE b.source_id = s.id AND b.status = 'ok') AS ok_batch_count,
            (SELECT COUNT(*) FROM source_batches b WHERE b.source_id = s.id AND b.status = 'failed') AS failed_batch_count
     FROM sources s ORDER BY s.id`
  );
  const countOkBatchesStmt = db.prepare(
    "SELECT COUNT(*) AS c FROM source_batches WHERE source_id = ? AND status = 'ok'"
  );
  const insertBatchStmt = db.prepare(`
    INSERT INTO source_batches (
      source_id, seq, status, gap_before, sample_count,
      samples_json, failure_code, failure_reason
    ) VALUES (
      @sourceId, @seq, @status, @gapBefore, @sampleCount,
      @samplesJson, @failureCode, @failureReason
    )
  `);
  const listBatchesStmt = db.prepare(
    'SELECT * FROM source_batches WHERE source_id = ? ORDER BY id'
  );
  const updateJointStateStmt = db.prepare(
    `UPDATE sources SET joint_state_json = @jointStateJson,
                        updated_at = datetime('now') WHERE id = @sourceId`
  );

  function insert({
    status,
    kind = null,
    tau0 = null,
    sampleCount,
    samples,
    mList = null,
    points = null,
    slopeBands = null,
    hasWhiteFrequency = false,
    failureReason = null,
    preset = false,
  }) {
    const result = insertStmt.run({
      status,
      kind,
      tau0,
      sampleCount,
      samplesJson: JSON.stringify(samples),
      mListJson: mList === null ? null : JSON.stringify(mList),
      pointsJson: points === null ? null : JSON.stringify(points),
      slopeBandsJson: slopeBands === null ? null : JSON.stringify(slopeBands),
      hasWhiteFrequency: hasWhiteFrequency ? 1 : 0,
      failureReason,
      preset: preset ? 1 : 0,
    });
    return Number(result.lastInsertRowid);
  }

  function rowToRecord(row) {
    if (!row) {
      return null;
    }
    const record = {
      id: row.id,
      status: row.status,
      kind: row.kind,
      tau0: row.tau0,
      sampleCount: row.sample_count,
      samples: JSON.parse(row.samples_json),
      hasWhiteFrequency: row.has_white_frequency === 1,
      preset: row.preset === 1,
      createdAt: row.created_at,
    };
    if (row.status === 'ok') {
      record.mList = JSON.parse(row.m_list_json);
      record.points = JSON.parse(row.points_json);
      record.slopeBands = JSON.parse(row.slope_bands_json);
    } else {
      record.failureReason = row.failure_reason;
    }
    return record;
  }

  return {
    insertSuccess(data) {
      return insert({ ...data, status: 'ok' });
    },
    insertFailure(data) {
      return insert({ ...data, status: 'failed' });
    },
    getById(id) {
      return rowToRecord(getStmt.get(id));
    },
    listSummaries() {
      return listStmt.all().map((row) => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        tau0: row.tau0,
        pointCount: row.sample_count,
        hasWhiteFrequency: row.has_white_frequency === 1,
        failureReason: row.failure_reason,
        preset: row.preset === 1,
        createdAt: row.created_at,
      }));
    },
    getPresetId() {
      const row = presetStmt.get();
      return row ? Number(row.id) : null;
    },

    // ---- 来源 / 批次 ----
    insertSource({ kind, tau0 }) {
      const result = insertSourceStmt.run({ kind, tau0 });
      return Number(result.lastInsertRowid);
    },

    getSourceById(id) {
      const row = getSourceStmt.get(id);
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        kind: row.kind,
        tau0: row.tau0,
        jointState:
          row.joint_state_json === null ? null : JSON.parse(row.joint_state_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    listSourceSummaries() {
      return listSourcesStmt.all().map((row) => ({
        id: row.id,
        kind: row.kind,
        tau0: row.tau0,
        batchCount: row.batch_count,
        okBatchCount: row.ok_batch_count,
        failedBatchCount: row.failed_batch_count,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    listBatches(sourceId) {
      return listBatchesStmt.all(sourceId).map((row) => {
        const batch = {
          id: row.id,
          sourceId: row.source_id,
          seq: row.seq === null ? null : row.seq,
          status: row.status,
          gapBefore: row.gap_before === 1,
          sampleCount: row.sample_count,
          samples: JSON.parse(row.samples_json),
          createdAt: row.created_at,
        };
        if (row.status === 'failed') {
          batch.failureCode = row.failure_code;
          batch.failureReason = row.failure_reason;
        }
        return batch;
      });
    },

    // 一次成功的批次追加必须整体落盘：要么 seq+批次+联合状态都更新，
    // 要么都不动。并发追加串行化后在单个事务内提交，杜绝重复计入。
    appendSuccessfulBatch(sourceId, { samples, gapBefore, jointState }) {
      const tx = db.transaction(() => {
        const { c } = countOkBatchesStmt.get(sourceId);
        const seq = c + 1;
        const result = insertBatchStmt.run({
          sourceId,
          seq,
          status: 'ok',
          gapBefore: gapBefore ? 1 : 0,
          sampleCount: samples.length,
          samplesJson: JSON.stringify(Array.from(samples)),
          failureCode: null,
          failureReason: null,
        });
        updateJointStateStmt.run({
          sourceId,
          jointStateJson: JSON.stringify(jointState),
        });
        return { batchId: Number(result.lastInsertRowid), seq };
      });
      return tx();
    },

    // 失败批次只留痕：seq 恒为 NULL，绝不触碰联合状态。
    insertFailedBatch(sourceId, { samples, code, reason }) {
      const result = insertBatchStmt.run({
        sourceId,
        seq: null,
        status: 'failed',
        gapBefore: 0,
        sampleCount: Array.isArray(samples) ? samples.length : 0,
        // 原样保留（NaN/Infinity 会被 JSON 序列化为 null），与单条记录一致
        samplesJson: JSON.stringify(Array.isArray(samples) ? samples : []),
        failureCode: code,
        failureReason: reason,
      });
      return Number(result.lastInsertRowid);
    },

    close() {
      db.close();
    },
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  createRecordStore,
};
