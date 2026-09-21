# clock-stability-service

钟差 / 分数频率序列的时频稳定度评估服务：提交一条等间隔采样序列，
按 decade 选取平均时间 τ，用**重叠 Allan 方差**（overlapping Allan
variance）计算 σ_y(τ)，并在双对数坐标上读局部斜率、标注噪声区段。
服务只做这一件事，仅经 HTTP 提交记录段、取回曲线。

Node.js 20 + Express，记录段写入进程内 SQLite（better-sqlite3），
`node:20-slim` 单容器启动，无需外部数据库。

## 运行与测试

```bash
npm install
npm test          # node --test，46 个自动化测试
npm start         # 默认 :3000，DB 在 ./data/records.db

# 环境变量
PORT=3000
DB_PATH=/app/data/records.db   # 也可设为 :memory:

# 容器
docker build -t clock-stability .
docker run --rm -p 3000:3000 -v "$PWD/data:/app/data" clock-stability
```

启动时会预置一条 4096 点的确定性合成白频率记录（`GET /health` 可查其
记录号）；中段斜率接近 −1/2，类型栏标“白频率”。重复启动不会重复插入。

## HTTP

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/records` | 提交记录段。成功 `201`；入参不合法或候选 τ 全超 T/3 时 `422`，记录进失败态并写明原因 |
| GET | `/records` | 摘要列表：点数、τ0、是否识别出白频率段（不含序列与曲线） |
| GET | `/records/:id` | 按记录号取回全文 |
| POST | `/sources` | 开“来源”：钉死采样间隔 τ0 与数据类型 kind |
| POST | `/sources/:id/batches` | 向来源追加一批；同一来源串行追加，并发 `409` |
| GET | `/sources` | 来源摘要列表（覆盖长度、批次数、残缺段；不含样本与点位） |
| GET | `/sources/:id/summary` | 单个来源摘要 |
| GET | `/sources/:id` | 来源全文：联合曲线各 τ 点的稳度值与噪声标签 |
| GET | `/health` | 存活检查与预置记录号 |

提交体：

```json
{
  "samples": [ /* 等间隔数值数组：钟差或分数频率 */ ],
  "tau0": 1.0,
  "kind": "frequency"
}
```

- `kind: "frequency"` —— 分数频率 y；重叠估计走**相邻 τ 平均之差**。
- `kind: "phase"` —— 钟差（相位时间）x；重叠估计走**二阶差分**。
  当 `y[k] = x[k+1] - x[k]` 时，两种输入在同一物理 τ 上的 σ_y
  逐项一致（仅浮点舍入差别）。

成功响应 / 全文记录包含：原始序列、`kind`、`tau0`、实际使用的 `mList`、
每个点的 `{m, tau, sigma, slope, noiseCode, noiseLabel}`、本次使用的
`slopeBands`、`hasWhiteFrequency`。失败记录只有 `status: "failed"` 与
`failureReason`，绝不附带假曲线。

## 分批来源（同一物理来源连续采集）

真实设备连续运行、每隔一段时间导出一批，中间可能因维护/断电/换机
断开多次。来源让调用方声明“这些批次属于同一个物理来源、按时间顺序
连续采集”，服务把所有**已成功批次当成一整条不间断序列**重算联合
稳定度曲线，而不是把每批各自的曲线拼接。

开来源时钉死一次 `tau0` / `kind`，之后每批只需提交 `samples`
（显式再给 `tau0` / `kind` 也可以，但必须与来源一致，矛盾的追加
被 `422 rejected` 拒绝、不落批次）。每批仍各自走数据入参检查
（缺项、非有限数、最短长度），tau0 相关检查不在每批重复。

```bash
curl -X POST .../sources -d '{"kind":"frequency","tau0":1}'
# 201 { id, status:"ok", batchCount:0, curveStatus:"insufficient_data", ... }

curl -X POST .../sources/1/batches -d '{"samples":[...第 1 批...]}'
curl -X POST .../sources/1/batches -d '{"samples":[...第 2 批...]}'
curl .../sources/1            # 联合全文（mList / points / 噪声标签）
curl .../sources/1/summary    # 仅摘要
```

### 跨界滑动块

联合估计在“所有成功批次首尾相连”的整段序列上做重叠 Allan 滑动。
只要 τ ≤ 整段 T/3，滑动块就会**横跨批次边界**到两侧取样本——这些
跨界块不会像“先各算曲线再拼接”那样被漏掉。无残缺段时，联合曲线
与把全部批次首尾相连一次性 POST 到 `/records` 的结果**逐项精确
一致**（同一条计算路径），包括同一套 decade τ 网格、T/3 裁剪与
噪声区段识别。来源能支持的最大平均时间（`mMax` /
`tauLimitTOver3`）随每批追加动态增长，开来源时不固定。

### 残缺段不制造伪重叠

某批数据本身有问题（含非有限数等）时，**只让这一批失败**
（`422 failed`，落失败批次），不连累来源内已成功的其它批次；
但它在时间线上留下等长的**残缺区间**（摘要 `gaps` / `hasGaps` /
`gapSamples`），绝不悄悄跳过缺口把前后两段接成连续序列——否则会
在缺口两侧造出并不存在的短平均时间伪重叠。残缺段把时间线切成
若干纪元，任何滑动项只要触及残缺槽就整条丢弃；长到无法在任一纪元
内取齐两块的 τ 直接不出现在曲线上。连 `samples` 数组都缺失的失败
批长度未知，记为纪元屏障（`unknownGaps`），屏障两侧永不相跨。

### 串行追加与持久化

一个来源同一时刻只允许一批追加在处理：并发的第二批得到 `409`
（`APPEND_IN_PROGRESS`），落盘批次与联合状态在同一 SQLite 事务里
更新，不会交错写坏或把同一批计入两次；严格等上一批响应结束再发的
串行追加不受影响。来源、批次与当前联合状态均落盘，服务重启后已
追加的来源可继续追加，且联合曲线不变量保持。全零数据分批追加时，
所有合法 τ 上 σ_y 仍精确为 0。

摘要（列表与 `/summary`）只给覆盖长度、批次数、残缺段、mMax 等，
不含原始 `samples` 与明细 `points`；`GET /sources/:id` 才给全文。

## 方法约定

### 平均时间网格

τ = m · τ0，m 为正整数。按 decade 取 1..9 倍：
`1,2,...,9,10,20,...,90,100,...`。**τ ≤ T/3**（m ≤ floor(n/3)），
超出的候选不进曲线；所有候选都超限时记录判失败。n 为有效分数频率点数
（相位序列长度 L 对应 n = L−1），T = n · τ0。

### 重叠 Allan 偏差

滑动步长固定为 1 个采样（m>1 时严格小于块长 m，块间重叠）：

```
频率: σ²(τ) = 1/(2K) Σ ( mean(y[j+m..j+2m-1]) − mean(y[j..j+m-1]) )²,  K = n−2m+1
钟差: σ²(τ) = 1/(2K m²) Σ ( x[j+2m] − 2x[j+m] + x[j] )²,                K = L−2m
```

全零序列在每个合法 τ 上 σ_y 精确为 0。不是样本标准差 / √τ，也不是
互不重叠块的方差——自动化测试里用一条独立实现的参考重叠公式卡这一点，
并与非重叠块结果对照（短序列、m 取 N/4 附近时二者显著不同）。

### 噪声区段

取相邻点在 log10 τ–log10 σ_y 上的局部斜率，区间（含边界）钉死：

| 类型 | 标签 | 斜率区间 |
| --- | --- | --- |
| 白相位 White PM | `white_phase` / 白相位 | [−1.20, −0.80] |
| 白频率 White FM | `white_frequency` / 白频率 | [−0.70, −0.30] |
| 随机游走 Random Walk FM | `random_walk` / 随机游走 | [+0.30, +0.70] |
| 区间外 / σ=0 无法取对数 | `unknown` / 未知 | — |

区间之间故意留缝，不硬贴标签。第一个点（没有前一个相邻点）类型留空；
合法 τ 不足两个时，整列类型留空。

### 不变量（均有自动化测试覆盖）

- 白频率振幅加倍、长度与 τ0 不变：每个 τ 上 σ_y 变成 2 倍（数值精确），
  斜率区段不变。
- 同一物理过程 τ0 减半（加密采样，粗采样为细采样块平均）：同一物理 τ
  上 σ_y 对得上。
- 钟差二阶差分与分数频率相邻平均之差在同一物理 τ 上一致。
- 每份记录独立估计器；滑窗中间累加随调用结束释放，不污染下一份记录。

## 代码结构

```
src/
  estimator.js        重叠 Allan 估计（频率相邻块均值之差 / 相位二阶差分）
  tauGrid.js          decade τ 网格与 T/3 裁剪
  noise.js            局部斜率与噪声区段识别（钉死的斜率区间）
  validation.js       单条入参检查（缺项、非有限数、τ0、最短长度、kind）
  sourceValidation.js 来源/批次入参检查（tau0·kind 只开来源查一次、矛盾拒绝）
  sourceEstimator.js  批次时间线拼装与跨界感知的联合估计（残缺段切纪元）
  sourcePipeline.js   开来源 / 串行追加（追加锁）/ 联合状态重算落盘
  synthetic.js        确定性合成噪声（白频率 / 随机游走 / 白相位、PRNG）
  pipeline.js         提交 → 校验 → 选 τ → 估计 → 识别 → 落盘
  store.js            进程内 SQLite：records / sources / source_batches
  preset.js           预置合成白频率记录装载
  app.js              HTTP 路由
  server.js           容器入口
test/
  estimator.test.js    数学/单元测试
  http.test.js         单条记录端到端 HTTP 测试
  source.test.js       来源联合曲线（对齐/残缺/全零/并发/重启）服务级测试
  sourceHttp.test.js   来源端到端 HTTP 测试
```

## 入参红线

- `tau0` 缺省、非数字、非有限或 ≤ 0 → 失败态。
- 序列含缺项或非有限数（null/undefined/NaN/Infinity）→ 失败态。
- 有效分数频率点数少于 8（钟差少于 9 点）→ 失败态。
- `kind` 不是 `phase` / `frequency` → 失败态。
- 候选 τ 全超 T/3 → 失败态。
