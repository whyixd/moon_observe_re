import { describe, expect, it } from 'vitest'
import { createDefaultEffectPreset, getEffectCompletion, sampleEffect, createEffectContext } from '../src/effects'
import {
  compileSequence,
  createSequenceStep,
  layerUnitWeight,
  resolveSequenceFrame,
  sequenceSeekFrame,
} from '../src/simulation/sequence'

describe('effect sequence boundaries', () => {
  it('uses a full nine-unit fill as one completion and restarts each repetition', () => {
    const preset = createDefaultEffectPreset('sequential-center-fill')
    const completion = getEffectCompletion(preset, 40, 9)!
    const step = createSequenceStep(1, preset)
    step.playback = { kind: 'count', count: 2 }
    const schedule = compileSequence([step], 40, 9)

    expect(completion.label).toContain('所有 Unit')
    expect(schedule.totalFrames).toBe(completion.frames * 2)
    expect(resolveSequenceFrame(schedule, completion.frames - 1)!.layers[0].localFrame)
      .toBe(completion.frames - 1)
    expect(resolveSequenceFrame(schedule, completion.frames)!.layers[0].localFrame).toBe(0)
    expect(resolveSequenceFrame(schedule, schedule.totalFrames)!.complete).toBe(true)

    const finalPixel = sampleEffect(
      preset,
      createEffectContext(completion.frames - 1, 40, 155, 156, 8, 9, completion.frames - 1),
    )
    expect(finalPixel).toEqual({ r: 1, g: 1, b: 1 })
  })

  it('classifies complete cycles for repetition and ongoing effects for time', () => {
    expect(getEffectCompletion(createDefaultEffectPreset('spectrum-cycle'), 40, 9)?.frames).toBe(20)
    expect(getEffectCompletion(createDefaultEffectPreset('moving-rings'), 40, 9)?.frames).toBe(160)
    expect(getEffectCompletion(createDefaultEffectPreset('random-leds'), 40, 9)).toBeNull()
    expect(getEffectCompletion(createDefaultEffectPreset('world-upper-half'), 40, 9)).toBeNull()
    expect(createSequenceStep(1, createDefaultEffectPreset('random-leds')).playback)
      .toEqual({ kind: 'time', seconds: 8 })
  })

  it('switches after the full count and blends only at the next step', () => {
    const first = createSequenceStep(1, createDefaultEffectPreset('spectrum-cycle'))
    first.playback = { kind: 'count', count: 2 }
    first.transition = { kind: 'crossfade', seconds: 0.1 }
    const second = createSequenceStep(2, createDefaultEffectPreset('random-leds'))
    second.playback = { kind: 'time', seconds: 1 }
    const schedule = compileSequence([first, second], 40, 9)

    expect(schedule.totalFrames).toBe(80)
    expect(resolveSequenceFrame(schedule, 20)!.layers).toHaveLength(1)
    expect(resolveSequenceFrame(schedule, 39)!.layers).toHaveLength(1)
    const transition = resolveSequenceFrame(schedule, 40)!
    expect(transition.stepIndex).toBe(1)
    expect(transition.layers).toHaveLength(2)
    expect(transition.layers[0]).toMatchObject({
      localFrame: 19, sourceFrame: 39, weight: 0.8,
    })
    expect(transition.layers[1]).toMatchObject({
      localFrame: 0, sourceFrame: 40, weight: 0.2,
    })
    expect(resolveSequenceFrame(schedule, 44)!.layers).toHaveLength(1)
    expect(resolveSequenceFrame(schedule, 80)!.layers[0].sourceFrame).toBe(79)
  })

  it('loops through the final transition and restarts the first effect', () => {
    const first = createSequenceStep(1, createDefaultEffectPreset('spectrum-cycle'))
    first.playback = { kind: 'count', count: 2 }
    const second = createSequenceStep(2, createDefaultEffectPreset('random-leds'))
    second.playback = { kind: 'time', seconds: 0.1 }
    second.transition = { kind: 'crossfade', seconds: 0.05 }
    const schedule = compileSequence([first, second], 40, 9, { kind: 'loop' })

    expect(schedule.totalFrames).toBe(44)
    expect(schedule.loopTransitionFrames).toBe(2)
    expect(resolveSequenceFrame(schedule, 0)!.layers).toHaveLength(1)
    const boundary = resolveSequenceFrame(schedule, 44)!
    expect(boundary.complete).toBe(false)
    expect(boundary.stepIndex).toBe(0)
    expect(boundary.layers[0].sourceFrame).toBe(43)
    expect(boundary.layers[0].weight).toBeCloseTo(2 / 3)
    expect(boundary.layers[1]).toMatchObject({ localFrame: 0, sourceFrame: 44 })
    expect(boundary.layers[1].weight).toBeCloseTo(1 / 3)
    expect(resolveSequenceFrame(schedule, 46)!.layers[0]).toMatchObject({
      localFrame: 2, sourceFrame: 46, weight: 1,
    })
    expect(resolveSequenceFrame(schedule, 88)!.layers[0].sourceFrame).toBe(87)
  })

  it('fades the final frame to black and stays black', () => {
    const step = createSequenceStep(1, createDefaultEffectPreset('spectrum-cycle'))
    const schedule = compileSequence([step], 40, 9, { kind: 'fade-black', seconds: 0.1 })
    expect(schedule.endFadeFrames).toBe(4)
    expect(resolveSequenceFrame(schedule, 20)!.layers[0].weight).toBe(0.75)
    expect(resolveSequenceFrame(schedule, 22)!.layers[0].weight).toBe(0.25)
    expect(resolveSequenceFrame(schedule, 23)!.layers[0].weight).toBe(0)
    expect(resolveSequenceFrame(schedule, 60)!.layers[0].weight).toBe(0)
    expect(resolveSequenceFrame(schedule, 60)!.complete).toBe(true)
  })

  it('fades through black and limits the transition to the incoming duration', () => {
    const first = createSequenceStep(1, createDefaultEffectPreset('random-leds'))
    first.playback = { kind: 'time', seconds: 0.1 }
    first.transition = { kind: 'fade-black', seconds: 2 }
    const second = createSequenceStep(2, createDefaultEffectPreset('spectrum-cycle'))
    second.playback = { kind: 'count', count: 1 }
    const schedule = compileSequence([first, second], 40, 9)

    expect(schedule.steps[1].transitionFrames).toBe(20)
    const middle = resolveSequenceFrame(schedule, 4 + 9)!
    expect(middle.layers[0].weight).toBe(0)
    expect(middle.layers[1].weight).toBe(0)
    const later = resolveSequenceFrame(schedule, 4 + 11)!
    expect(later.layers[0].weight).toBe(0)
    expect(later.layers[1].weight).toBeGreaterThan(0)
  })
})

describe('unit-by-unit fade to black', () => {
  const schedule = () => {
    const first = createSequenceStep(1, createDefaultEffectPreset('full-on'))
    first.playback = { kind: 'time', seconds: 1 }
    first.transition = { kind: 'unit-fade-black', seconds: 2 }
    const second = createSequenceStep(2, createDefaultEffectPreset('full-on'))
    second.playback = { kind: 'time', seconds: 4 }
    return compileSequence([first, second], 40, 9)
  }
  const weights = (frame: number, layer: number) => {
    const resolved = resolveSequenceFrame(schedule(), frame)!
    return Array.from({ length: 9 }, (_, unit) => layerUnitWeight(resolved.layers[layer], unit, 9))
  }

  it('fades unit 1 first and unit 9 last, all black at the midpoint', () => {
    // 80 transition frames: the first 40 fade units out in order, the next 40 fade the new step in.
    const early = weights(40 + 5, 0)
    expect(early[0]).toBeLessThan(1)
    expect(early[8]).toBe(1)
    const middle = weights(40 + 25, 0)
    expect(middle[0]).toBe(0)
    expect(middle[8]).toBeGreaterThan(0)
    for (let unit = 1; unit < 9; unit += 1) expect(middle[unit]).toBeGreaterThanOrEqual(middle[unit - 1])
    expect(weights(40 + 39, 0)).toEqual(Array(9).fill(0))
    expect(weights(40 + 39, 1)).toEqual(Array(9).fill(0))
  })

  it('fades the next step in on all units together after the midpoint', () => {
    const incoming = weights(40 + 60, 1)
    expect(new Set(incoming).size).toBe(1)
    expect(incoming[0]).toBeGreaterThan(0)
    expect(incoming[0]).toBeLessThan(1)
    expect(weights(40 + 60, 0)).toEqual(Array(9).fill(0))
    expect(resolveSequenceFrame(schedule(), 40 + 80)!.layers).toHaveLength(1)
  })

  it('fades a single unit over the whole first half', () => {
    const resolved = resolveSequenceFrame(schedule(), 40 + 19)!
    expect(layerUnitWeight(resolved.layers[0], 0, 1)).toBeCloseTo(0.5)
  })
})

describe('preview seeking', () => {
  const steps = () => {
    const first = createSequenceStep(1, createDefaultEffectPreset('full-on'))
    first.playback = { kind: 'time', seconds: 10 }
    first.transition = { kind: 'crossfade', seconds: 1 }
    const second = createSequenceStep(2, createDefaultEffectPreset('full-on'))
    second.playback = { kind: 'time', seconds: 1 }
    second.transition = { kind: 'unit-fade-black', seconds: 1 }
    return [first, second]
  }

  it('jumps to a step start or two seconds before its switch', () => {
    const schedule = compileSequence(steps(), 40, 9)
    expect(sequenceSeekFrame(schedule, { kind: 'start' }, 40)).toBe(0)
    expect(sequenceSeekFrame(schedule, { kind: 'step', id: 2 }, 40)).toBe(400)
    expect(sequenceSeekFrame(schedule, { kind: 'transition', id: 1 }, 40)).toBe(320)
    expect(sequenceSeekFrame(schedule, { kind: 'step', id: 99 }, 40)).toBe(0)
  })

  it('previews the loop back into the first step and never starts before the step', () => {
    const schedule = compileSequence(steps(), 40, 9, { kind: 'loop' })
    // The last step is one second long, so the preview starts at its own beginning.
    const frame = sequenceSeekFrame(schedule, { kind: 'transition', id: 2 }, 40)
    expect(frame).toBe(400)
    const wrapped = resolveSequenceFrame(schedule, schedule.totalFrames + 10)!
    expect(wrapped.layers).toHaveLength(2)
    expect(wrapped.layers[0].unitFade).toBeDefined()
  })
})

describe('sequence step frames', () => {
  it('exposes unwrapped step frames for count-based wrapping', () => {
    const step = { ...createSequenceStep(1, createDefaultEffectPreset('comet-tail')), playback: { kind: 'count' as const, count: 3 } }
    const schedule = compileSequence([step], 40, 9, { kind: 'hold' })
    expect(resolveSequenceFrame(schedule, 170)!.layers[0]).toMatchObject({ localFrame: 10, elapsedFrame: 170, cycleFrames: 160 })
  })
})
