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
    close() {
      db.close();
    },
  };
}

module.exports = {
  DEFAULT_DB_PATH,
  createRecordStore,
};
