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
npm test          # node --test，23 个自动化测试
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
  estimator.js   重叠 Allan 估计（频率相邻块均值之差 / 相位二阶差分）
  tauGrid.js     decade τ 网格与 T/3 裁剪
  noise.js       局部斜率与噪声区段识别（钉死的斜率区间）
  validation.js  入参检查（缺项、非有限数、τ0、最短长度、kind）
  synthetic.js   确定性合成噪声（白频率 / 随机游走 / 白相位、PRNG）
  pipeline.js    提交 → 校验 → 选 τ → 估计 → 识别 → 落盘
  store.js       进程内 SQLite 记录存取
  preset.js      预置合成白频率记录装载
  app.js         HTTP 路由
  server.js      容器入口
test/
  estimator.test.js  数学/单元测试
  http.test.js       端到端 HTTP 测试
```

## 入参红线

- `tau0` 缺省、非数字、非有限或 ≤ 0 → 失败态。
- 序列含缺项或非有限数（null/undefined/NaN/Infinity）→ 失败态。
- 有效分数频率点数少于 8（钟差少于 9 点）→ 失败态。
- `kind` 不是 `phase` / `frequency` → 失败态。
- 候选 τ 全超 T/3 → 失败态。
