import { EFFECT_SCHEMA_VERSION, type EffectModule } from './contract'
import { RAIN_LINES, rainStreak } from './rain'

const WHITE = { r: 1, g: 1, b: 1 }

export const fullOn: EffectModule = {
  manifest: {
    schemaVersion: EFFECT_SCHEMA_VERSION,
    id: 'full-on',
    label: '全亮',
    description: '所有燈點以色彩設定的顏色持續全亮，沒有動態；預設為白色純色。',
    parameters: [],
  },
  sample: () => WHITE,
  // 雨天：滿版雨絲。 / Rain: streaks across the whole disc.
  rain: (context) => rainStreak(context, RAIN_LINES.sparseDensity),
}
