'use strict';

// 确定性合成噪声序列：可复现的伪随机数 + Box-Muller 高斯抽样。
// 全部以分数频率 y 为基础生成；需要钟差 x 时对 y 做累加，
// 保证两类提交描述的是同一个物理过程（可直接对拍）。

const { KINDS } = require('./estimator');

// mulberry32：小而确定的可播种 PRNG，避免测试抖动。
function createRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createGaussian(rng) {
  let spare = null;
  return function gaussian() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u === 0) {
      u = rng();
    }
    v = rng();
    const magnitude = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    spare = magnitude * Math.sin(angle);
    return magnitude * Math.cos(angle);
  };
}

// 白频率噪声（White FM）：独立高斯分数频率 y[k]，振幅 = 单采样 σ_y(τ0)。
// 理论 Allan 斜率 -1/2，σ_y(m τ0) ≈ amplitude / √m。
function whiteFrequencySamples(length, amplitude, seed) {
  const gaussian = createGaussian(createRng(seed));
  const samples = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = amplitude * gaussian();
  }
  return samples;
}

// 随机游走频率（Random Walk FM）：y[k] = y[k-1] + step·g，
// 理论 Allan 斜率 +1/2。
function randomWalkFrequencySamples(length, stepAmplitude, seed) {
  const gaussian = createGaussian(createRng(seed));
  const samples = new Float64Array(length);
  let level = 0;
  for (let i = 0; i < length; i += 1) {
    level += stepAmplitude * gaussian();
    samples[i] = level;
  }
  return samples;
}

// 白相位噪声（White PM）：x[k] 独立高斯，返回相位序列。
// 理论 Allan 斜率 -1。
function whitePhaseSamples(length, amplitude, seed) {
  const gaussian = createGaussian(createRng(seed));
  const samples = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    samples[i] = amplitude * gaussian();
  }
  return samples;
}

// 由分数频率 y 累加出钟差 x：x[k+1] = x[k] + y[k]（τ0 已吸收在单位选择里）。
function integrateFrequency(frequencySamples) {
  const phase = new Float64Array(frequencySamples.length + 1);
  let level = 0;
  phase[0] = 0;
  for (let i = 0; i < frequencySamples.length; i += 1) {
    level += frequencySamples[i];
    phase[i + 1] = level;
  }
  return phase;
}

// 服务预置的合成白频率记录（中段斜率应接近 -1/2，类型标“白频率”）。
const PRESET = Object.freeze({
  length: 4096,
  amplitude: 1,
  tau0: 1,
  seed: 20260919,
  kind: KINDS.FREQUENCY,
  build() {
    return whiteFrequencySamples(this.length, this.amplitude, this.seed);
  },
});

module.exports = {
  createRng,
  createGaussian,
  whiteFrequencySamples,
  randomWalkFrequencySamples,
  whitePhaseSamples,
  integrateFrequency,
  PRESET,
};
