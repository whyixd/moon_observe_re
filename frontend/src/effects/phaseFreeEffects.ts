import { EFFECT_SCHEMA_VERSION, clamp01, effectTimeSeconds, type EffectModule } from './contract'
import { RAIN_LINES, rainRing, rainStreak, rainStripe } from './rain'

const TAU = Math.PI * 2
const cycle = (value: number) => value - Math.floor(value)
const smoothstep = (value: number) => {
  const t = clamp01(value)
  return t * t * (3 - 2 * t)
}

// 每段 = 移動（每次 1/(3·speedHz) 秒）＋到底停留，皆取整數影格，讓循環長度剛好是整數。
// A stage is one move (1/(3·speedHz) s) plus the hold, both whole frames so the cycle wraps exactly.
function reverseTideStageFrames(parameters: Record<string, number>, fps: number) {
  const move = Math.max(1, Math.round(fps / (3 * (parameters.speedHz ?? 0.25))))
  return { move, stage: move + Math.round(fps * (parameters.holdSeconds ?? 0.5)) }
}

export const reverseTide: EffectModule = {
  completion: {
    label: '光潮完成填滿、收縮、擴散、收縮一輪',
    frames: (p, fps) => 4 * reverseTideStageFrames(p, fps).stage,
  },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'reverse-tide', label: '逆向聚潮',
    description: '從圓周向圓心填滿，再收縮至圓心消失、從圓心擴散回圓周、再收縮消失，每次到底停留後再反向；全暗後重新從圓周填滿。',
    parameters: [
      { key: 'speedHz', label: '移動頻率', unit: 'Hz', min: 0.05, max: 1, step: 0.05, defaultValue: 0.25 },
      { key: 'holdSeconds', label: '到底停留', unit: '秒', min: 0, max: 3, step: 0.1, defaultValue: 0.5 },
    ] },
  sample(context, parameters) {
    // 一輪四段：填滿、收縮、擴散、收縮；頭尾都是全暗，循環時無接縫。
    // Four stages per cycle (fill, shrink, expand, shrink); it starts and ends dark, so wrapping is seamless.
    const { move, stage: stageFrames } = reverseTideStageFrames(parameters, context.controllerFps)
    const cycleFrames = 4 * stageFrames
    const frame = ((Math.floor(Math.max(0, context.controllerFrame)) % cycleFrames) + cycleFrames) % cycleFrames
    const stage = Math.floor(frame / stageFrames)
    const progress = Math.min(1, (frame - stage * stageFrames) / move)
    const pixel = context.ledCount <= 1 ? 1 : 2 / (context.ledCount - 1)
    // 邊界寬 2 像素；端點外推 1 像素，讓起訖時完全全暗或全亮。
    // The edge spans two pixels; ends overshoot by one so each stage starts and ends cleanly.
    const span = (value: number) => -pixel + value * (1 + pixel * 2)
    const edge = (boundary: number) => smoothstep((context.normalizedRadius - boundary) / (pixel * 2) + 0.5)
    const brightness = stage === 0
      ? edge(1 - span(progress))
      : 1 - edge(span(stage === 2 ? progress : 1 - progress))
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：填滿與收縮不變，亮區只亮同心條紋。 / Rain: same fill and shrink, the lit area shows only stripes.
  rain: (context, _parameters, base) => base() * rainStripe(context),
}

export const wideRings: EffectModule = {
  completion: { label: '寬幅色環完成一次移動', frames: (p, fps) => fps / (p.speedHz ?? 0.2) },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'wide-rings', label: '寬幅同心環',
    description: '數道寬色帶沿半徑緩慢平移，形成大片旋轉光環。',
    parameters: [
      { key: 'speedHz', label: '移動頻率', unit: 'Hz', min: 0.05, max: 1, step: 0.05, defaultValue: 0.2 },
      { key: 'ringCount', label: '色環數', unit: '環', min: 1, max: 6, step: 1, defaultValue: 3 },
      { key: 'width', label: '環寬', unit: '半徑比例', min: 0.1, max: 0.8, step: 0.05, defaultValue: 0.5 },
    ] },
  sample(context, parameters) {
    const count = Math.round(parameters.ringCount ?? 3)
    const phase = cycle(context.normalizedRadius * count - effectTimeSeconds(context) * (parameters.speedHz ?? 0.2))
    const distance = Math.min(phase, 1 - phase)
    const brightness = 1 - smoothstep((distance - (parameters.width ?? 0.5) / 2 + 0.04) / 0.08)
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：每條寬帶只留內外兩條邊線。 / Rain: each band keeps only its inner and outer edge lines.
  rain(context, parameters) {
    const count = Math.round(parameters.ringCount ?? 3)
    const phase = cycle(context.normalizedRadius * count - effectTimeSeconds(context) * (parameters.speedHz ?? 0.2))
    const distance = Math.min(phase, 1 - phase)
    return rainRing((distance - (parameters.width ?? 0.5) / 2) / count, context.ledCount)
  },
}

export const cometTail: EffectModule = {
  completion: { label: '彗尾沿半圓完成一次循環', frames: (p, fps) => fps * (p.periodSeconds ?? 4) },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'comet-tail', label: '漸層彗尾',
    description: '明亮前端帶著漸暗尾巴，沿半圓燈帶循環移動。',
    parameters: [
      { key: 'periodSeconds', label: '移動週期', unit: '秒', min: 0.5, max: 20, step: 0.5, defaultValue: 4 },
      { key: 'tailLength', label: '尾巴長度', unit: '燈帶比例', min: 0.05, max: 0.8, step: 0.05, defaultValue: 0.25 },
    ] },
  sample(context, parameters) {
    const head = cycle(effectTimeSeconds(context) / (parameters.periodSeconds ?? 4))
    const behind = cycle(head - context.normalizedStripPosition)
    const brightness = 1 - smoothstep(behind / (parameters.tailLength ?? 0.25))
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：彗頭是細環，尾巴是越往後越稀疏的雨絲。 / Rain: the head is a thin ring, the tail streaks thin out behind it.
  rain(context, parameters) {
    const head = cycle(effectTimeSeconds(context) / (parameters.periodSeconds ?? 4))
    const behind = cycle(head - context.normalizedStripPosition)
    const ring = rainRing(2 * Math.min(behind, 1 - behind), context.ledCount)
    const density = RAIN_LINES.denseDensity * (1 - smoothstep(behind / (parameters.tailLength ?? 0.25)))
    return Math.max(ring, rainStreak(context, density))
  },
}

function random32(seed: number): number {
  let value = seed >>> 0
  value ^= value << 13
  value ^= value >>> 17
  value ^= value << 5
  return value >>> 0
}

export const stardustCloud: EffectModule = {
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'stardust-cloud', label: '星塵雲',
    description: '數群燈點在不同位置擴散、消退，再形成新光雲。',
    parameters: [
      { key: 'holdSeconds', label: '光雲週期', unit: '秒', min: 0.5, max: 8, step: 0.5, defaultValue: 2 },
      { key: 'cloudCount', label: '光雲數', unit: '群', min: 1, max: 6, step: 1, defaultValue: 3 },
    ] },
  sample(context, parameters) {
    const time = effectTimeSeconds(context) / (parameters.holdSeconds ?? 2)
    const epoch = Math.floor(time)
    const age = cycle(time)
    const width = 0.025 + 0.11 * age
    let brightness = 0
    for (let cluster = 0; cluster < Math.round(parameters.cloudCount ?? 3); cluster += 1) {
      const seed = Math.imul(epoch + 1, 0x9e3779b1) ^ Math.imul(context.unitIndex + 1, 0x85ebca6b) ^ Math.imul(cluster + 1, 0x6d2b79f5)
      const center = random32(seed) / 0x100000000
      const distance = Math.abs(context.normalizedStripPosition - center)
      brightness = Math.max(brightness, (1 - smoothstep(distance / width)) * (1 - smoothstep(age)))
    }
    return { r: brightness, g: brightness, b: brightness }
  },
  // 雨天：光雲由雨絲組成，越亮越密。 / Rain: clouds made of streaks, denser where brighter.
  rain: (context, _parameters, base) => rainStreak(context, RAIN_LINES.denseDensity * base()),
}

export const colorBreathing: EffectModule = {
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'color-breathing', label: '色彩吐納',
    description: '整條燈帶緩慢呼吸，漸層色彩沿燈帶逐漸流轉。',
    parameters: [{ key: 'breatheHz', label: '呼吸頻率', unit: 'Hz', min: 0.05, max: 0.8, step: 0.05, defaultValue: 0.2 }] },
  sample(context, parameters) {
    const brightness = 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(TAU * (parameters.breatheHz ?? 0.2) * effectTimeSeconds(context)))
    return { r: brightness, g: brightness, b: brightness }
  },
  gradientPosition(context, axis) {
    return (axis === 'radius' ? context.normalizedRadius : context.normalizedStripPosition) + effectTimeSeconds(context) * 0.05
  },
  loopGradient: true,
  // 雨天：呼吸與顏色流轉不變，只亮同心條紋。 / Rain: same breathing and colour flow, only the stripes light.
  rain: (context, _parameters, base) => base() * rainStripe(context),
}

const SECTOR_LENGTHS = [0.3, 0.6, 1, 0.45, 0.8, 0.2, 0.65, 1]

export const sectorSmear: EffectModule = {
  completion: { label: '扇區圖案完成一次循環', frames: () => SECTOR_LENGTHS.length },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'sector-smear', label: '扇區疊影',
    description: '逐影格改變徑向亮燈長度，讓轉動與影格保持形成漂移的扇形光跡。', parameters: [] },
  sample(context) {
    const length = SECTOR_LENGTHS[((context.controllerFrame % SECTOR_LENGTHS.length) + SECTOR_LENGTHS.length) % SECTOR_LENGTHS.length]
    const brightness = 1 - smoothstep((context.normalizedRadius - length + 0.02) / 0.04)
    return { r: brightness, g: brightness, b: brightness }
  },
}

export const twentyBeat: EffectModule = {
  completion: { label: '二十拍完成一次循環', frames: () => 20 },
  manifest: { schemaVersion: EFFECT_SCHEMA_VERSION, id: 'twenty-beat', label: '二十拍萬花筒',
    description: '20 個影格依序切換內圈、中圈、外圈、全亮與條紋，形成週期疊影。', parameters: [] },
  sample(context) {
    const beat = Math.floor((((context.controllerFrame % 20) + 20) % 20) / 4)
    const radius = context.normalizedRadius
    const brightness = beat === 0 ? 1 - smoothstep((radius - 0.3) / 0.04)
      : beat === 1 ? smoothstep((radius - 0.24) / 0.04) * (1 - smoothstep((radius - 0.58) / 0.04))
        : beat === 2 ? smoothstep((radius - 0.64) / 0.04)
          : beat === 3 ? 0.7
            : (Math.floor(radius * 10) % 2 === 0 ? 1 : 0.12)
    return { r: brightness, g: brightness, b: brightness }
  },
  gradientPosition(context, axis) {
    return (context.controllerFrame % 20) / 20 + (axis === 'radius' ? context.normalizedRadius : context.normalizedStripPosition) * 0.25
  },
  loopGradient: true,
}
