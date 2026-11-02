/** Generate read-only reference vectors from the actual frontend effect functions. */
import { createHash } from 'node:crypto'
import { compileSequence, createSequenceStep, layerUnitWeight, resolveSequenceFrame } from '../src/simulation/sequence'
import { writeFileSync } from 'node:fs'
import { createDefaultEffectPreset, createEffectContext, getEffectCompletion, getVariableParameters, parameterMax, presetForUnit, sampleEffect, type EffectPreset } from '../src/effects'

const ids = [
  'spectrum-cycle',
  'center-out-sine',
  'moving-rings',
  'sequential-center-fill',
  'periodic-leds',
  'random-leds',
  'world-upper-half',
  'reverse-tide',
  'wide-rings',
  'comet-tail',
  'stardust-cloud',
  'color-breathing',
  'sector-smear',
  'twenty-beat',
  'sine-swell',
  'random-fill',
  'full-on',
  'unit-chase',
  'unit-random',
  'roulette-ring',
] as const

const gradient8 = [
  { r: 0, g: 0.1, b: 1 },
  { r: 0.15, g: 0.8, b: 0.3 },
  { r: 1, g: 0.1, b: 0.2 },
  { r: 0.8, g: 0.9, b: 0 },
  { r: 0.25, g: 0.2, b: 0.7 },
  { r: 1, g: 0.6, b: 0.3 },
  { r: 0.4, g: 1, b: 0.8 },
  { r: 0.7, g: 0.1, b: 0.9 },
]

const presets: EffectPreset[] = ids.flatMap((id) => {
  const base = createDefaultEffectPreset(id)
  return [
    base,
    { ...base, color: { mode: 'solid', color: { r: 0.2, g: 0.75, b: 0.1 } } },
    { ...base, color: { mode: 'gradient', axis: 'strip', colors: [
      { r: 1, g: 0.1, b: 0 }, { r: 0, g: 0.2, b: 1 },
    ] } },
    { ...base, color: { mode: 'gradient', axis: 'radius', colors: gradient8 } },
  ]
})

const contexts = [
  { controllerFrame: 0, globalControllerFrame: 0, ledIndex: 0, unitIndex: 0, unitRelativeY: -1, unitPhaseProjection: 0.49 },
  { controllerFrame: 0, globalControllerFrame: 0, ledIndex: 77, unitIndex: 0, unitRelativeY: 0, unitPhaseProjection: 0.51 },
  { controllerFrame: 1, globalControllerFrame: 1, ledIndex: 78, unitIndex: 8, unitRelativeY: 1, unitPhaseProjection: -0.51 },
  { controllerFrame: 3, globalControllerFrame: 3, ledIndex: 155, unitIndex: 0, unitRelativeY: 1, unitPhaseProjection: -1 },
  { controllerFrame: 4, globalControllerFrame: 4, ledIndex: 1, unitIndex: 8, unitRelativeY: -1, unitPhaseProjection: 0 },
  { controllerFrame: 19, globalControllerFrame: 19, ledIndex: 154, unitIndex: 8, unitRelativeY: 0, unitPhaseProjection: 0.5 },
  { controllerFrame: 20, globalControllerFrame: 800, ledIndex: 77, unitIndex: 8, unitRelativeY: 1, unitPhaseProjection: 1 },
  { controllerFrame: 100, globalControllerFrame: 100, ledIndex: 78, unitIndex: 0, unitRelativeY: -1, unitPhaseProjection: -0.49 },
  { controllerFrame: 160, globalControllerFrame: 160, ledIndex: 33, unitIndex: 5, unitRelativeY: 0.01, unitPhaseProjection: 1 },
]

const samples = presets.flatMap((preset, presetIndex) => contexts.map((context) => ({
  presetIndex,
  context,
  expected: sampleEffect(
    preset,
    createEffectContext(
      context.controllerFrame,
      40,
      context.ledIndex,
      156,
      context.unitIndex,
      9,
      context.globalControllerFrame,
      context.unitRelativeY,
      context.unitPhaseProjection,
    ),
  ),
})))

const frames = presets.flatMap((preset, presetIndex) =>
  [0, 3, 4, 19, 20, 100, 800, 1600, 2650].flatMap((globalFrame) =>
    [0, 8].map((unitIndex) => {
      const controllerFrame = globalFrame + unitIndex * 2
      const channels = Array.from({ length: 156 }, (_, ledIndex) => {
        const relativeY = (ledIndex - 77.5) / 77.5
        const color = sampleEffect(
          preset,
          createEffectContext(
            controllerFrame, 40, ledIndex, 156, unitIndex, 9, globalFrame, relativeY,
          ),
        )
        return [color.r, color.g, color.b].map((value) =>
          Math.floor(Math.min(1, Math.max(0, value)) * 255 + 0.5))
      }).flat()
      return {
        presetIndex, globalFrame, controllerFrame, unitIndex,
        sha256: createHash('sha256').update(Buffer.from(channels)).digest('hex'),
      }
    }),
  ),
)
// 各燈台不同數值：每個可變參數 × 三種分布，記下九台實際值與週期。
// Per-unit variation: every variable parameter × distribution, with each unit's value and cycle.
const unitVariations = ids.flatMap((id) => getVariableParameters(id).flatMap((parameter) =>
  (['linear', 'skip', 'random'] as const).map((distribution) => {
    const preset: EffectPreset = {
      ...createDefaultEffectPreset(id),
      unitVariation: { parameter: parameter.key, from: parameterMax(id, parameter.key, 156), to: parameter.min + parameter.step * 0.4, distribution },
    }
    return {
      preset,
      values: Array.from({ length: 9 }, (_, unitIndex) => presetForUnit(preset, unitIndex, 9).parameters[parameter.key]),
      completionFrames: getEffectCompletion(preset, 40, 9)?.frames ?? null,
    }
  })))

// 逐台淡出轉場：整段轉場（含循環接回）每格九台的兩層權重。
// Unit-by-unit fade: both layers' weight per unit for every frame of the transition, including the loop back.
const fadeSteps = [createSequenceStep(1, createDefaultEffectPreset('full-on')), createSequenceStep(2, createDefaultEffectPreset('full-on'))]
fadeSteps[0].playback = { kind: 'time', seconds: 1 }
fadeSteps[0].transition = { kind: 'unit-fade-black', seconds: 1.3 }
fadeSteps[1].playback = { kind: 'time', seconds: 2 }
fadeSteps[1].transition = { kind: 'unit-fade-black', seconds: 0.5 }
const fadeSequence = { schemaVersion: 1 as const, ending: { kind: 'loop' as const }, steps: fadeSteps }
const fadeSchedule = compileSequence(fadeSteps, 40, 9, fadeSequence.ending)
const unitFade = {
  sequence: fadeSequence,
  frames: [...Array.from({ length: 56 }, (_, index) => 38 + index), ...Array.from({ length: 24 }, (_, index) => 118 + index)]
    .map((frame) => ({
      frame,
      weights: resolveSequenceFrame(fadeSchedule, frame)!.layers.map((layer) => (
        Array.from({ length: 9 }, (_, unit) => layerUnitWeight(layer, unit, 9))
      )),
    })),
}

// 中途切換方向：不同效果、方向、交替與否，在切換前、過渡中、切換後取樣。
// Gradient axis change: several effects, axes and repeat modes, sampled before, during and after the switch.
const axisChangePresets: EffectPreset[] = ([
  ['full-on', 'strip', { to: 'unit', atSeconds: 1, blendSeconds: 0.5, repeat: false }],
  ['sine-swell', 'unit', { to: 'radius', atSeconds: 0.5, blendSeconds: 0.3, repeat: true }],
  ['spectrum-cycle', 'radius', { to: 'strip', atSeconds: 1.5, blendSeconds: 1.1, repeat: true }],
  ['color-breathing', 'strip', { to: 'radius', atSeconds: 0.75, blendSeconds: 0, repeat: false }],
  ['twenty-beat', 'radius', { to: 'unit', atSeconds: 0.5, blendSeconds: 0, repeat: true }],
  ['random-fill', 'unit', { to: 'strip', atSeconds: 1, blendSeconds: 1, repeat: false }],
] as const).map(([id, axis, axisChange]) => ({
  ...createDefaultEffectPreset(id),
  color: { mode: 'gradient', axis, axisChange: { ...axisChange }, colors: gradient8.slice(0, 5) },
}))
const axisChanges = axisChangePresets.map((preset) => ({
  preset,
  samples: [0, 19, 20, 30, 39, 40, 52, 60, 61, 79, 100, 123, 400].flatMap((elapsedFrame) =>
    [[0, 0], [40, 3], [77, 8], [155, 5]].map(([ledIndex, unitIndex]) => ({
      elapsedFrame, ledIndex, unitIndex,
      expected: sampleEffect(
        preset,
        createEffectContext(elapsedFrame + unitIndex * 2, 40, ledIndex, 156, unitIndex, 9, elapsedFrame, 0.3),
        elapsedFrame,
      ),
    }))),
}))

// 整台效果：兩輪內每一格、九台（或八台）× 幾顆代表燈點的亮度位元組，整段取 sha256。
// Whole-unit effects: brightness bytes for every frame of two cycles, all units × a few LEDs, hashed once.
const UNIT_EFFECT_LEDS = [0, 1, 2, 38, 77, 78, 117, 153, 154, 155]
const unitEffectCases: [EffectPreset, number][] = [
  [createDefaultEffectPreset('unit-chase'), 9],
  [{ ...createDefaultEffectPreset('unit-chase'), parameters: { stepSeconds: 0.3, fadeSeconds: 0.2, gapSeconds: 0, holdSeconds: 0.3, endDarkSeconds: 0 } }, 8],
  [createDefaultEffectPreset('unit-random'), 9],
  [{ ...createDefaultEffectPreset('unit-random'), parameters: { fadeInSeconds: 0.3, holdSeconds: 0.5, fadeOutSeconds: 0.4, gapSeconds: 0 } }, 9],
  [createDefaultEffectPreset('roulette-ring'), 9],
  [{ ...createDefaultEffectPreset('roulette-ring'), parameters: {
    ...createDefaultEffectPreset('roulette-ring').parameters,
    sweeps: 1, startStepFrames: 1, endStepSeconds: 0.3, dimSeconds: 1, spreadStepSeconds: 0,
    glitchSeconds: 0.5, glitchSpreadSeconds: 0.5, flickerFrames: 3,
  } }, 8],
]
const unitEffects = unitEffectCases.map(([preset, unitCount]) => {
  const totalFrames = 2 * getEffectCompletion(preset, 40, unitCount)!.frames
  const bytes: number[] = []
  for (let frame = 0; frame < totalFrames; frame += 1) {
    for (let unitIndex = 0; unitIndex < unitCount; unitIndex += 1) {
      for (const ledIndex of UNIT_EFFECT_LEDS) {
        const color = sampleEffect(preset, createEffectContext(frame, 40, ledIndex, 156, unitIndex, unitCount, frame))
        bytes.push(...[color.r, color.g, color.b].map((value) => Math.floor(Math.min(1, Math.max(0, value)) * 255 + 0.5)))
      }
    }
  }
  return { preset, unitCount, leds: UNIT_EFFECT_LEDS, totalFrames, sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
})

// 雨天線條：各效果預設值、各 fps，取開頭與較後段的影格、三台、全部 LED 的 RGB 位元組雜湊。
// Rain lines: per effect default and fps, a hash of RGB bytes over early and later frames, three units, every LED.
const RAIN_FRAME_RANGES = [[0, 120], [2000, 2040]] as const
const RAIN_UNITS = [0, 4, 8]
const rainLines = {
  frameRanges: RAIN_FRAME_RANGES,
  units: RAIN_UNITS,
  cases: ids.flatMap((effectId) => [40, 60].map((fps) => {
    const preset = createDefaultEffectPreset(effectId)
    const bytes: number[] = []
    for (const [from, to] of RAIN_FRAME_RANGES) {
      for (let frame = from; frame < to; frame += 1) {
        for (const unitIndex of RAIN_UNITS) {
          for (let ledIndex = 0; ledIndex < 156; ledIndex += 1) {
            const color = sampleEffect(preset, createEffectContext(frame, fps, ledIndex, 156, unitIndex, 9, frame), frame, true)
            bytes.push(...[color.r, color.g, color.b].map((value) => Math.floor(Math.min(1, Math.max(0, value)) * 255 + 0.5)))
          }
        }
      }
    }
    return { effectId, fps, sha256: createHash('sha256').update(Buffer.from(bytes)).digest('hex') }
  })),
}

// LongN：152 顆 × 5 台。同一套效果在不同燈數與台數下，前後端也要逐位元組一致。
// LongN: 152 LEDs x 5 units. The same effects must also match byte for byte at another LED and unit count.
const LONGN_LEDS = 152
const LONGN_UNITS = 5
const toBytes = (color: { r: number; g: number; b: number }) =>
  [color.r, color.g, color.b].map((value) => Math.floor(Math.min(1, Math.max(0, value)) * 255 + 0.5))
const sha256 = (bytes: number[]) => createHash('sha256').update(Buffer.from(bytes)).digest('hex')
// 貼著 152 顆上限的參數。 / Parameters right at the 152-LED limits.
const longnEdgePresets: EffectPreset[] = [
  { ...createDefaultEffectPreset('random-leds'), parameters: { ...createDefaultEffectPreset('random-leds').parameters, litCount: LONGN_LEDS } },
  { ...createDefaultEffectPreset('periodic-leds'), parameters: { litCount: 16, darkGap: 9, periodSeconds: 3 } },
  { ...createDefaultEffectPreset('periodic-leds'), parameters: { litCount: 1, darkGap: LONGN_LEDS - 1, periodSeconds: 0.5 } },
  { ...createDefaultEffectPreset('periodic-leds'), parameters: { litCount: LONGN_LEDS, darkGap: 0, periodSeconds: 2 } },
]
const longnPresets = [...presets, ...longnEdgePresets]
const longnCenter = (LONGN_LEDS - 1) / 2
const longn = {
  ledCount: LONGN_LEDS,
  unitCount: LONGN_UNITS,
  // presetIndex 指向 presets 接上 edgePresets。 / presetIndex points into presets followed by edgePresets.
  edgePresets: longnEdgePresets,
  frames: longnPresets.flatMap((preset, presetIndex) =>
    [0, 3, 19, 100, 800, 2650].flatMap((globalFrame) =>
      [0, LONGN_UNITS - 1].map((unitIndex) => {
        const controllerFrame = globalFrame + unitIndex * 2
        const bytes = Array.from({ length: LONGN_LEDS }, (_, ledIndex) => toBytes(sampleEffect(
          preset,
          createEffectContext(controllerFrame, 40, ledIndex, LONGN_LEDS, unitIndex, LONGN_UNITS, globalFrame,
            (ledIndex - longnCenter) / longnCenter),
        ))).flat()
        return { presetIndex, globalFrame, controllerFrame, unitIndex, sha256: sha256(bytes) }
      }))),
  unitVariations: ids.flatMap((id) => getVariableParameters(id).flatMap((parameter) =>
    (['linear', 'random'] as const).map((distribution) => {
      const preset: EffectPreset = {
        ...createDefaultEffectPreset(id),
        unitVariation: { parameter: parameter.key, from: parameterMax(id, parameter.key, LONGN_LEDS), to: parameter.min, distribution },
      }
      return {
        preset,
        values: Array.from({ length: LONGN_UNITS }, (_, unitIndex) => presetForUnit(preset, unitIndex, LONGN_UNITS).parameters[parameter.key]),
        completionFrames: getEffectCompletion(preset, 40, LONGN_UNITS)?.frames ?? null,
      }
    }))),
  unitEffects: unitEffectCases.map(([preset]) => {
    const totalFrames = 2 * getEffectCompletion(preset, 40, LONGN_UNITS)!.frames
    const leds = [0, 1, 37, 75, 76, 114, 150, 151]
    const bytes: number[] = []
    for (let frame = 0; frame < totalFrames; frame += 1) {
      for (let unitIndex = 0; unitIndex < LONGN_UNITS; unitIndex += 1) {
        for (const ledIndex of leds) {
          bytes.push(...toBytes(sampleEffect(preset, createEffectContext(frame, 40, ledIndex, LONGN_LEDS, unitIndex, LONGN_UNITS, frame))))
        }
      }
    }
    return { preset, leds, totalFrames, sha256: sha256(bytes) }
  }),
  rainLines: {
    frameRanges: [[0, 80], [2000, 2020]] as const,
    units: [0, 2, 4],
    cases: ids.map((effectId) => {
      const preset = createDefaultEffectPreset(effectId)
      const bytes: number[] = []
      for (const [from, to] of [[0, 80], [2000, 2020]]) {
        for (let frame = from; frame < to; frame += 1) {
          for (const unitIndex of [0, 2, 4]) {
            for (let ledIndex = 0; ledIndex < LONGN_LEDS; ledIndex += 1) {
              bytes.push(...toBytes(sampleEffect(preset, createEffectContext(frame, 40, ledIndex, LONGN_LEDS, unitIndex, LONGN_UNITS, frame), frame, true)))
            }
          }
        }
      }
      return { effectId, fps: 40, sha256: sha256(bytes) }
    }),
  },
}

const output = JSON.stringify({
  source: 'frontend/src/effects',
  schemaVersion: 2,
  ledCount: 156,
  controllerFps: 40,
  presets,
  samples,
  frames,
  unitVariations,
  unitFade,
  axisChanges,
  unitEffects,
  rainLines,
  longn,
}, null, 2)

if (process.argv.includes('--write')) {
  writeFileSync(new URL('../../backend/fixtures/effects_v2.json', import.meta.url), `${output}\n`)
} else {
  console.log(output)
}
