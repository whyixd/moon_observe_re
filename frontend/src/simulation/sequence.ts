import { getEffectCompletion, type EffectPreset } from '../effects'

/** unit-fade-black: units fade out one after another (1→9), then the next step fades in on all units. */
export type TransitionKind = 'cut' | 'fade-black' | 'crossfade' | 'unit-fade-black'
export type SequenceEnding = { kind: 'hold' | 'loop' } | { kind: 'fade-black'; seconds: number }
export type PlaybackRule =
  | { kind: 'time'; seconds: number }
  | { kind: 'count'; count: number }

export type SequenceStep = {
  id: number
  preset: EffectPreset
  playback: PlaybackRule
  transition: { kind: TransitionKind; seconds: number }
}

export type SequenceDocument = {
  schemaVersion: 1
  ending: SequenceEnding
  steps: SequenceStep[]
}

export type CompiledStep = SequenceStep & {
  index: number
  startFrame: number
  durationFrames: number
  cycleFrames: number | null
  transitionFrames: number
}

export type CompiledSequence = {
  steps: CompiledStep[]
  totalFrames: number
  ending: SequenceEnding
  endFadeFrames: number
  loopTransitionFrames: number
}

export type SequenceLayer = {
  preset: EffectPreset
  stepIndex: number
  localFrame: number
  // Frames since the step started (unwrapped) and the step repeat length, for count-based wrapping.
  elapsedFrame: number
  cycleFrames: number | null
  sourceFrame: number
  weight: number
  /** Outgoing layer of unit-fade-black: frames into the fade-out half and that half's length. */
  unitFade?: { elapsed: number; frames: number }
}

export type SequenceFrame = {
  stepIndex: number
  complete: boolean
  layers: SequenceLayer[]
}

export function defaultPlaybackRule(preset: EffectPreset): PlaybackRule {
  return getEffectCompletion(preset, 40, 9)
    ? { kind: 'count', count: 1 }
    : { kind: 'time', seconds: 8 }
}

export function createSequenceStep(id: number, preset: EffectPreset): SequenceStep {
  return {
    id,
    preset,
    playback: defaultPlaybackRule(preset),
    transition: { kind: 'cut', seconds: 0.5 },
  }
}

export function compileSequence(
  steps: readonly SequenceStep[],
  fps: number,
  unitCount: number,
  ending: SequenceEnding = { kind: 'hold' },
): CompiledSequence {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error('controller FPS must be positive')
  let startFrame = 0
  const compiled = steps.map((step, index): CompiledStep => {
    const completion = getEffectCompletion(step.preset, fps, unitCount)
    if (step.playback.kind === 'count' && !completion) {
      throw new Error('播放次數需要完成邊界')
    }
    const cycleFrames = step.playback.kind === 'count' ? completion!.frames : null
    const durationFrames = step.playback.kind === 'count'
      ? cycleFrames! * Math.max(1, Math.floor(step.playback.count))
      : Math.max(1, Math.round(step.playback.seconds * fps))
    const previous = steps[index - 1]
    const transitionFrames = previous?.transition.kind === 'cut'
      ? 0
      : Math.min(durationFrames, Math.max(0, Math.round((previous?.transition.seconds ?? 0) * fps)))
    const result = {
      ...step,
      index,
      startFrame,
      durationFrames,
      cycleFrames,
      transitionFrames,
    }
    startFrame += durationFrames
    return result
  })
  const last = steps.at(-1)
  const loopTransitionFrames = ending.kind === 'loop' && last?.transition.kind !== 'cut'
    ? Math.min(compiled[0]?.durationFrames ?? 0, Math.max(0, Math.round((last?.transition.seconds ?? 0) * fps)))
    : 0
  const endFadeFrames = ending.kind === 'fade-black'
    ? Math.max(1, Math.round(ending.seconds * fps))
    : 0
  return { steps: compiled, totalFrames: startFrame, ending, endFadeFrames, loopTransitionFrames }
}

function localFrame(step: CompiledStep, frame: number): number {
  return step.cycleFrames === null ? frame : frame % step.cycleFrames
}

export function resolveSequenceFrame(
  sequence: CompiledSequence,
  globalFrame: number,
): SequenceFrame | null {
  if (sequence.steps.length === 0) return null
  const frame = Math.max(0, Math.floor(globalFrame))
  const loop = sequence.ending.kind === 'loop'
  const cycleStart = loop ? Math.floor(frame / sequence.totalFrames) * sequence.totalFrames : 0
  const cycleFrame = loop ? frame - cycleStart : frame
  const complete = !loop && frame >= sequence.totalFrames
  if (complete) {
    const last = sequence.steps.at(-1)!
    const weight = sequence.ending.kind === 'fade-black'
      ? Math.max(0, 1 - (frame - sequence.totalFrames + 1) / sequence.endFadeFrames)
      : 1
    return {
      stepIndex: last.index,
      complete: true,
      layers: [{
        preset: last.preset,
        stepIndex: last.index,
        localFrame: localFrame(last, last.durationFrames - 1),
        elapsedFrame: last.durationFrames - 1,
        cycleFrames: last.cycleFrames,
        sourceFrame: sequence.totalFrames - 1,
        weight,
      }],
    }
  }

  const stepIndex = sequence.steps.findIndex((step) => cycleFrame < step.startFrame + step.durationFrames)
  const step = sequence.steps[stepIndex]
  const elapsed = cycleFrame - step.startFrame
  const current: SequenceLayer = {
    preset: step.preset,
    stepIndex,
    localFrame: localFrame(step, elapsed),
    elapsedFrame: elapsed,
    cycleFrames: step.cycleFrames,
    sourceFrame: cycleStart + step.startFrame + elapsed,
    weight: 1,
  }
  const transitionFrames = stepIndex === 0
    ? cycleStart > 0 ? sequence.loopTransitionFrames : 0
    : step.transitionFrames
  if (elapsed >= transitionFrames) {
    return { stepIndex, complete: false, layers: [current] }
  }

  const previous = sequence.steps[stepIndex === 0 ? sequence.steps.length - 1 : stepIndex - 1]
  const midpoint = Math.floor((transitionFrames - 1) / 2)
  if (previous.transition.kind === 'crossfade') {
    const progress = (elapsed + 1) / (transitionFrames + 1)
    current.weight = progress
  } else {
    current.weight = elapsed > midpoint
      ? (elapsed - midpoint) / (transitionFrames - 1 - midpoint)
      : 0
  }
  const unitFade = previous.transition.kind === 'unit-fade-black'
  const outgoingWeight = previous.transition.kind === 'crossfade'
    ? 1 - current.weight
    : unitFade
      ? elapsed <= midpoint ? 1 : 0
      : elapsed < midpoint
        ? 1 - (elapsed + 1) / (midpoint + 1)
        : 0
  const outgoing: SequenceLayer = {
    preset: previous.preset,
    stepIndex: previous.index,
    localFrame: localFrame(previous, previous.durationFrames - 1),
    elapsedFrame: previous.durationFrames - 1,
    cycleFrames: previous.cycleFrames,
    sourceFrame: cycleStart + previous.startFrame + previous.durationFrames - 1
      - (stepIndex === 0 ? sequence.totalFrames : 0),
    weight: outgoingWeight,
    ...(unitFade ? { unitFade: { elapsed, frames: midpoint + 1 } } : {}),
  }
  return { stepIndex, complete: false, layers: [outgoing, current] }
}

// 逐台淡出：每台淡出一段（前半的 1/3，台數少時較長），開始時間由第 1 台到最後一台平均錯開，最後一台在前半結束時剛好全黑。
// Per-unit fade-out: each unit fades over a third of the first half (longer with fewer units), start times spread
// evenly from the first unit to the last, and the last unit reaches black exactly at the end of the half.
export function unitFadeWeight(fade: { elapsed: number; frames: number }, unitIndex: number, unitCount: number): number {
  const fadeFrames = fade.frames / Math.min(3, Math.max(1, unitCount))
  const start = unitCount <= 1 ? 0 : (fade.frames - fadeFrames) * unitIndex / (unitCount - 1)
  return 1 - Math.min(1, Math.max(0, (fade.elapsed + 1 - start) / fadeFrames))
}

/** A layer's weight for one unit; only unit-fade-black differs per unit. */
export function layerUnitWeight(layer: SequenceLayer, unitIndex: number, unitCount: number): number {
  return layer.unitFade ? layer.weight * unitFadeWeight(layer.unitFade, unitIndex, unitCount) : layer.weight
}

/** Where the simulator jumps when the preview restarts. */
export type SequenceSeek =
  | { kind: 'start' }
  | { kind: 'step'; id: number }
  | { kind: 'transition'; id: number }

// 預覽銜接從切換前這麼多秒開始。 / Transition previews start this many seconds before the switch.
export const TRANSITION_PREVIEW_LEAD_SECONDS = 2

/**
 * Frame to start the preview at: a step's start, or shortly before the switch out of a step
 * (into the next step, back into the first after the last when looping, or into the ending).
 */
export function sequenceSeekFrame(sequence: CompiledSequence, seek: SequenceSeek, fps: number): number {
  if (seek.kind === 'start') return 0
  const step = sequence.steps.find((item) => item.id === seek.id)
  if (!step) return 0
  if (seek.kind === 'step') return step.startFrame
  // 最後一段的切換點是串接結尾：循環時接回第一段（第二輪），否則是結束方式。
  // The last step switches at the sequence end: into the first step's second round when looping, else into the ending.
  const switchFrame = step.startFrame + step.durationFrames
  const lead = Math.min(Math.round(TRANSITION_PREVIEW_LEAD_SECONDS * fps), step.durationFrames)
  return Math.max(0, switchFrame - lead)
}
