import {
  clamp01,
  type AxisChange,
  mixRgb,
  type EffectColor,
  type EffectId,
  type EffectPreset,
  type RgbColor,
} from './contract'

const WHITE: RgbColor = { r: 1, g: 1, b: 1 }
export const SPECTRUM: readonly RgbColor[] = [
  { r: 0x47 / 255, g: 0xd7 / 255, b: 1 },
  { r: 0x7a / 255, g: 0x5c / 255, b: 1 },
  { r: 1, g: 0x4f / 255, b: 0xa3 / 255 },
  { r: 1, g: 0xba / 255, b: 0x49 / 255 },
  { r: 0x5d / 255, g: 1, b: 0xb2 / 255 },
]

export function defaultEffectColor(effectId: EffectId): EffectColor {
  if (effectId === 'spectrum-cycle') {
    return { mode: 'gradient', axis: 'strip', colors: SPECTRUM.map((color) => ({ ...color })) }
  }
  if (effectId === 'random-fill') {
    return { mode: 'gradient', axis: 'unit', colors: SPECTRUM.map((color) => ({ ...color })) }
  }
  if (effectId === 'color-breathing' || effectId === 'twenty-beat') {
    return {
      mode: 'gradient', axis: 'radius', colors: [
        { r: 0.15, g: 0.8, b: 1 }, { r: 0.7, g: 0.25, b: 1 }, { r: 1, g: 0.55, b: 0.2 },
      ],
    }
  }
  if (effectId === 'center-out-sine') {
    return {
      mode: 'gradient',
      axis: 'radius',
      colors: [{ r: 0.2, g: 0.92, b: 1 }, { r: 0.66, g: 0.28, b: 1 }],
    }
  }
  return { mode: 'solid', color: { ...WHITE } }
}

export function sampleGradient(
  colors: readonly RgbColor[],
  position: number,
  loop: boolean,
): RgbColor {
  if (colors.length === 0) return WHITE
  if (colors.length === 1) return colors[0]
  const coordinate = loop
    ? (((position % 1) + 1) % 1) * colors.length
    : clamp01(position) * (colors.length - 1)
  const index = Math.floor(coordinate)
  const nextIndex = loop ? (index + 1) % colors.length : Math.min(index + 1, colors.length - 1)
  return mixRgb(colors[index], colors[nextIndex], coordinate - index)
}

export function rgbToHex(color: RgbColor): string {
  const channel = (value: number) => Math.round(clamp01(value) * 255)
    .toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

export function hexToRgb(hex: string): RgbColor {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

// 天氣色盤只換顏色：漸層效果保留自己的方向，純色效果用色盤的方向。
// The weather palette only swaps colors: gradient effects keep their own axis; solid ones use the palette's.
export function withWeatherPalette(preset: EffectPreset, palette: EffectColor): EffectPreset {
  const own = preset.color
  if (palette.mode !== 'gradient' || own.mode !== 'gradient') return { ...preset, color: palette }
  return { ...preset, color: { ...palette, axis: own.axis, ...(own.axisChange ? { axisChange: own.axisChange } : {}) } }
}

// 中途切換方向：回傳「切換後方向」的比重 0..1；elapsedFrame 從效果（或串接段落）開始算，不含各台錯開。
// Weight 0..1 of the axis switched to; elapsedFrame counts from the effect (or step) start, without per-unit offsets.
export function axisChangeWeight(change: AxisChange, elapsedFrame: number, fps: number): number {
  const at = Math.max(0, Math.round(change.atSeconds * fps))
  const blend = Math.max(0, Math.round(change.blendSeconds * fps))
  const once = (frame: number) => blend === 0 ? (frame >= at ? 1 : 0) : clamp01((frame - at) / blend)
  if (!change.repeat) return once(elapsedFrame)
  // 來回交替：每個方向停留 at 影格、過渡 blend 影格。 / Alternate: hold each axis for at frames, blend over blend frames.
  const half = at + blend
  if (half === 0) return 1
  const phase = elapsedFrame % (2 * half)
  return phase < half ? once(phase) : 1 - once(phase - half)
}
