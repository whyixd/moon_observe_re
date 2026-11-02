import { EFFECT_SCHEMA_VERSION, type EffectModule } from './contract'

const BLACK = { r: 0, g: 0, b: 0 }
const WHITE = { r: 1, g: 1, b: 1 }
const RANK_CACHE_LIMIT = 64
const rankCache = new Map<string, Uint32Array>()
let lastRanks: { frame: number; unitIndex: number; ledCount: number; ranks: Uint32Array } | undefined

export function randomRanks(frame: number, unitIndex: number, ledCount: number): Uint32Array {
  if (
    lastRanks?.frame === frame &&
    lastRanks.unitIndex === unitIndex &&
    lastRanks.ledCount === ledCount
  ) return lastRanks.ranks
  const key = `${frame}:${unitIndex}:${ledCount}`
  const cached = rankCache.get(key)
  if (cached) {
    lastRanks = { frame, unitIndex, ledCount, ranks: cached }
    return cached
  }

  const shuffled = Array.from({ length: ledCount }, (_, index) => index)
  let state = (
    Math.imul(frame + 1, 0x9e3779b1) ^
    Math.imul(unitIndex + 1, 0x85ebca6b) ^
    ledCount ^ 0x6d2b79f5
  ) >>> 0
  if (state === 0) state = 0x6d2b79f5

  for (let index = ledCount - 1; index > 0; index -= 1) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    const swapIndex = (state >>> 0) % (index + 1)
    const swapped = shuffled[index]
    shuffled[index] = shuffled[swapIndex]
    shuffled[swapIndex] = swapped
  }

  const ranks = new Uint32Array(ledCount)
  shuffled.forEach((ledIndex, rank) => { ranks[ledIndex] = rank })
  rankCache.set(key, ranks)
  lastRanks = { frame, unitIndex, ledCount, ranks }
  if (rankCache.size > RANK_CACHE_LIMIT) {
    rankCache.delete(rankCache.keys().next().value!)
  }
  return ranks
}

export const randomLeds: EffectModule = {
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'random-leds',
    label: '隨機亮點',
    description: '每條半圓定期隨機抽選亮點；可選擇等長點亮，或讓遠離中心的亮點提早熄滅，以縮短外側的視覺暫留軌跡。',
    parameters: [
      {
        key: 'litCount',
        label: '亮點數',
        unit: '顆 / 半圓',
        min: 1,
        max: 156,
        step: 1,
        defaultValue: 12,
      },
      {
        key: 'holdFrames',
        label: '變換間隔',
        unit: '影格',
        min: 1,
        max: 120,
        step: 1,
        defaultValue: 4,
      },
      {
        key: 'durationMode',
        label: '點亮時間模式',
        unit: '',
        min: 0,
        max: 1,
        step: 1,
        defaultValue: 0,
      },
      {
        key: 'minHoldFrames',
        label: '外側最短點亮',
        unit: '影格',
        min: 1,
        max: 120,
        step: 1,
        defaultValue: 1,
      },
    ],
  },

  sample(context, parameters) {
    if (context.ledCount <= 0) return BLACK
    const litCount = Math.max(
      1,
      Math.min(context.ledCount, Math.round(parameters.litCount ?? 12)),
    )
    const holdFrames = Math.max(1, Math.round(parameters.holdFrames ?? 4))
    const changeIndex = Math.floor(context.controllerFrame / holdFrames)
    const selected = randomRanks(
      changeIndex,
      context.unitIndex,
      context.ledCount,
    )[context.ledIndex] < litCount
    if (!selected || parameters.durationMode !== 1) return selected ? WHITE : BLACK

    const minFrames = Math.max(1, Math.min(holdFrames, Math.round(parameters.minHoldFrames ?? 1)))
    const radius = context.normalizedRadius
    // At the outer edge the tangential speed is highest, so shorten its exposure.
    // Quantize upward: every selected LED remains visible for at least one Art-Net frame.
    const durationFrames = Math.ceil(
      holdFrames / (1 + (holdFrames / minFrames - 1) * radius),
    )
    return context.controllerFrame % holdFrames < durationFrames ? WHITE : BLACK
  },
}
