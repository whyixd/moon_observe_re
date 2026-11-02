import { describe, expect, it } from 'vitest'
import type { WeatherPalette } from '../src/backendApi'
import {
  addBand,
  bandIndexFor,
  bandLabel,
  canAddBand,
  MAX_BANDS,
  paletteError,
  previewTemperature,
  removeBand,
} from '../src/palette/paletteModel'

const RED = { r: 1, g: 0, b: 0 }
const BLUE = { r: 0, g: 0, b: 1 }
const palette: WeatherPalette = {
  schemaVersion: 1,
  axis: 'radius',
  bands: [
    { belowC: 18, colors: [RED, BLUE] },
    { belowC: 28, colors: [BLUE, RED] },
    { belowC: null, colors: [RED, RED] },
  ],
}

describe('weather palette model', () => {
  it('labels bands, finds the active band and picks preview temperatures inside each band', () => {
    expect([0, 1, 2].map((index) => bandLabel(palette, index))).toEqual(['< 18 °C', '18 – 28 °C', '≥ 28 °C'])
    expect([17.9, 18, 27.9, 28].map((value) => bandIndexFor(palette, value))).toEqual([0, 1, 1, 2])
    expect([0, 1, 2].map((index) => bandIndexFor(palette, previewTemperature(palette, index)))).toEqual([0, 1, 2])
  })

  it('validates like the backend', () => {
    expect(paletteError(palette)).toBeNull()
    const decreasing = { ...palette, bands: [{ ...palette.bands[0], belowC: 30 }, ...palette.bands.slice(1)] }
    expect(paletteError(decreasing)).toMatch('大於上一段')
    const tooHot = { ...palette, bands: [{ ...palette.bands[0], belowC: 71 }, palette.bands[2]] }
    expect(paletteError(tooHot)).toMatch('-100–70')
  })

  it('adds a warmest band and keeps the last band open-ended when removing', () => {
    const added = addBand(palette)
    expect(added.bands.map((band) => band.belowC)).toEqual([18, 28, 33, null])
    expect(paletteError(added)).toBeNull()
    expect(removeBand(added, 3).bands.map((band) => band.belowC)).toEqual([18, 28, null])
    expect(removeBand(palette, 0).bands.map((band) => band.belowC)).toEqual([28, null])
    const single = removeBand(removeBand(palette, 0), 0)
    expect(single.bands.map((band) => band.belowC)).toEqual([null])
    expect(addBand(single).bands.map((band) => band.belowC)).toEqual([20, null])
    expect(canAddBand({ ...palette, bands: [{ belowC: 68, colors: [RED, BLUE] }, palette.bands[2]] })).toBe(false)
  })

  it(`allows up to ${MAX_BANDS} bands`, () => {
    let grown = removeBand(removeBand(palette, 0), 0)
    while (canAddBand(grown)) grown = addBand(grown)
    expect(grown.bands).toHaveLength(MAX_BANDS)
    expect(paletteError(grown)).toBeNull()
    expect(paletteError(addBand(grown))).not.toBeNull()
  })
})
