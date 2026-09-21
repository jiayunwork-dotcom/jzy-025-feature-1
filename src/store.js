'use strict';

// 记录段持久化：进程内 SQLite（better-sqlite3），不依赖外部数据库。
// 成功与失败提交都落盘；失败记录绝不附带曲线数据。
//
// “来源”（source）与名下“批次”（source_batch）同样落盘：
// 来源钉死 kind / tau0，批次保存每批原始样本（成功批次）或失败原因，
// 来源当前的联合状态（joint_state_json）随每次追加重算并落盘，
// 重启后已追加的来源可继续追加、继续对得上不变量。

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

    CREATE TABLE IF NOT EXISTS sources (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      kind            TEXT NOT NULL,
      tau0            REAL NOT NULL,
      batch_count     INTEGER NOT NULL DEFAULT 0,
      ok_batch_count  INTEGER NOT NULL DEFAULT 0,
      joint_state_json TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS source_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id      INTEGER NOT NULL REFERENCES sources(id),
      seq            INTEGER NOT NULL,
      status         TEXT NOT NULL CHECK (status IN ('ok', 'failed')),
      sample_count   INTEGER NOT NULL,
      samples_json   TEXT,
      failure_code   TEXT,
      failure_reason TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(source_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_batches_source ON source_batches(source_id, seq);
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

  // ---- 来源 / 批次 -------------------------------------------------------

  const insertSourceStmt = db.prepare(
    'INSERT INTO sources (kind, tau0, joint_state_json) VALUES (?, ?, ?)'
  );
  const getSourceRowStmt = db.prepare('SELECT * FROM sources WHERE id = ?');
  const listSourcesStmt = db.prepare(
    'SELECT * FROM sources ORDER BY id'
  );
  const nextSeqStmt = db.prepare(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM source_batches WHERE source_id = ?'
  );
  const insertBatchStmt = db.prepare(`
    INSERT INTO source_batches (
      source_id, seq, status, sample_count, samples_json,
      failure_code, failure_reason
    ) VALUES (
      @sourceId, @seq, @status, @sampleCount, @samplesJson,
      @failureCode, @failureReason
    )
  `);
  const updateSourceStateStmt = db.prepare(`
    UPDATE sources
       SET batch_count = @batchCount,
           ok_batch_count = @okBatchCount,
           joint_state_json = @jointStateJson,
           updated_at = datetime('now')
     WHERE id = @sourceId
  `);
  const listBatchesStmt = db.prepare(
    'SELECT * FROM source_batches WHERE source_id = ? ORDER BY seq'
  );

  function rowToSource(row) {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      kind: row.kind,
      tau0: row.tau0,
      batchCount: row.batch_count,
      okBatchCount: row.ok_batch_count,
      jointState: JSON.parse(row.joint_state_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function rowToBatch(row) {
    return {
      id: row.id,
      sourceId: row.source_id,
      seq: row.seq,
      status: row.status,
      sampleCount: row.sample_count,
      samples: row.samples_json === null ? null : JSON.parse(row.samples_json),
      failureCode: row.failure_code,
      failureReason: row.failure_reason,
      createdAt: row.created_at,
    };
  }

  const appendBatchTx = db.transaction((sourceId, batch, state) => {
    const seq = nextSeqStmt.get(sourceId).next_seq;
    const result = insertBatchStmt.run({
      sourceId,
      seq,
      status: batch.status,
      sampleCount: batch.sampleCount,
      samplesJson:
        batch.samples === null || batch.samples === undefined
          ? null
          : JSON.stringify(batch.samples),
      failureCode: batch.failureCode ?? null,
      failureReason: batch.failureReason ?? null,
    });
    updateSourceStateStmt.run({
      sourceId,
      batchCount: state.batchCount,
      okBatchCount: state.okBatchCount,
      jointStateJson: JSON.stringify(state.jointState),
    });
    return { batchId: Number(result.lastInsertRowid), seq };
  });

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

    // 来源
    insertSource({ kind, tau0, jointState }) {
      const result = insertSourceStmt.run(kind, tau0, JSON.stringify(jointState));
      return Number(result.lastInsertRowid);
    },
    getSourceById(id) {
      return rowToSource(getSourceRowStmt.get(id));
    },
    listSources() {
      return listSourcesStmt.all().map(rowToSource);
    },
    listBatches(sourceId) {
      return listBatchesStmt.all(sourceId).map(rowToBatch);
    },
    // 落批次 + 刷新联合状态必须在同一事务里：要么都生效，要么都不生效，
    // 绝不会出现“批次计入了但联合状态没更新”的错乱。
    appendBatch(sourceId, batch, state) {
      return appendBatchTx(sourceId, batch, state);
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
