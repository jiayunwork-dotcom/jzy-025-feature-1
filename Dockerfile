# 单容器镜像：node:20-slim，进程内 SQLite（better-sqlite3 走预编译二进制）。
FROM node:20-slim

WORKDIR /app

# 先装依赖，利用构建缓存
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

COPY src ./src

# 数据库落盘目录（DB_PATH 可覆盖为 :memory: 或其他路径）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/records.db

EXPOSE 3000

# 容器内冒烟自检：--test 仅在镜像构建时需要 dev 依赖，故运行态不做；
# 启动入口只负责装预置记录并监听。
CMD ["node", "src/server.js"]
