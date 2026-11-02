import type { WeatherPalette } from '../backendApi'

// 與後端 palette.py 規則一致。 / Same rules as backend palette.py.
export const MAX_BANDS = 12
export const MIN_TEMPERATURE = -100
export const MAX_TEMPERATURE = 70

export function paletteError(palette: WeatherPalette): string | null {
  const { bands } = palette
  if (bands.length < 1 || bands.length > MAX_BANDS) return `需要 1–${MAX_BANDS} 段`
  for (let index = 0; index < bands.length - 1; index += 1) {
    const below = bands[index].belowC
    if (below === null || !Number.isFinite(below) || below < MIN_TEMPERATURE || below > MAX_TEMPERATURE) {
      return `第 ${index + 1} 段的分界需在 ${MIN_TEMPERATURE}–${MAX_TEMPERATURE} °C`
    }
    const previous = index > 0 ? bands[index - 1].belowC : null
    if (previous !== null && below <= previous) return `第 ${index + 1} 段的分界必須大於上一段`
  }
  if (bands.some((band) => band.colors.length < 2 || band.colors.length > 8)) return '每段需要 2–8 個色點'
  return null
}

export function bandRange(palette: WeatherPalette, index: number) {
  return {
    low: index > 0 ? palette.bands[index - 1].belowC : null,
    high: palette.bands[index].belowC,
  }
}

export function bandLabel(palette: WeatherPalette, index: number): string {
  const { low, high } = bandRange(palette, index)
  if (low === null && high === null) return '所有氣溫'
  if (low === null) return `< ${high} °C`
  if (high === null) return `≥ ${low} °C`
  return `${low} – ${high} °C`
}

export function bandIndexFor(palette: WeatherPalette, temperature: number): number {
  const index = palette.bands.findIndex((band) => band.belowC === null || temperature < band.belowC)
  return index === -1 ? palette.bands.length - 1 : index
}

// 落在該段內、用於實機預覽的代表氣溫。 / A temperature inside the band, used for the live preview.
export function previewTemperature(palette: WeatherPalette, index: number): number {
  const { low, high } = bandRange(palette, index)
  if (low !== null && high !== null) return (low + high) / 2
  if (low !== null) return Math.min(MAX_TEMPERATURE, low + 2)
  if (high !== null) return Math.max(MIN_TEMPERATURE, high - 2)
  return 20
}

export function canAddBand(palette: WeatherPalette): boolean {
  const lastThreshold = palette.bands.at(-2)?.belowC ?? null
  return palette.bands.length < MAX_BANDS && (lastThreshold === null || lastThreshold + 5 <= MAX_TEMPERATURE)
}

// 新增最暖的一段：原本最後一段改以「上一個分界 + 5 °C」為上限。
// Append a warmest band; the former last band ends at the previous threshold + 5 °C.
export function addBand(palette: WeatherPalette): WeatherPalette {
  const lastThreshold = palette.bands.at(-2)?.belowC ?? null
  const bands = palette.bands.map((band) => ({ ...band, colors: band.colors.map((color) => ({ ...color })) }))
  bands[bands.length - 1].belowC = lastThreshold === null ? 20 : lastThreshold + 5
  bands.push({ belowC: null, colors: bands[bands.length - 1].colors.map((color) => ({ ...color })) })
  return { ...palette, bands }
}

export function removeBand(palette: WeatherPalette, index: number): WeatherPalette {
  const bands = palette.bands.filter((_, current) => current !== index)
  bands[bands.length - 1] = { ...bands[bands.length - 1], belowC: null }
  return { ...palette, bands }
}
