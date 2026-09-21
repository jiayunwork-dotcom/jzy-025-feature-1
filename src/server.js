'use strict';

// 单容器入口：打开进程内 SQLite、装载预置白频率记录、启动 HTTP。

const { createRecordStore, DEFAULT_DB_PATH } = require('./store');
const { createApp } = require('./app');
const { ensurePresetRecord } = require('./preset');

const port = Number.parseInt(process.env.PORT, 10) || 3000;
const dbPath = process.env.DB_PATH || DEFAULT_DB_PATH;

const store = createRecordStore(dbPath);
const presetId = ensurePresetRecord(store);
const app = createApp(store);

const server = app.listen(port, () => {
  console.log(
    JSON.stringify({
      service: 'clock-stability',
      port,
      dbPath,
      presetRecordId: presetId,
    })
  );
});

function shutdown(signal) {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

module.exports = { app, server, store };
