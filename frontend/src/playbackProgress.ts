import type { BackendPlayback, SequencePlayback, SinglePlayback } from './backendApi'

// 兩次輪詢之間依 FPS 推進後端回報的位置；跨段時停在段尾，等下一次輪詢更正。
// Advance the reported position by FPS between polls; hold at the step end until the next poll corrects it.

export type SequenceProgress = {
  stepElapsed: number
  stepDuration: number
  repeat: { current: number; total: number } | null
  sequenceFrame: number
  totalFrames: number
  transitionActive: boolean
  fadeElapsed: number | null
}

export type SingleProgress = {
  frame: number
  cycle: { current: number; elapsed: number; frames: number } | null
}

export function advancedFrames(fps: number, ageMs: number, sinceReceivedMs: number) {
  return Math.max(0, Math.floor(((ageMs + sinceReceivedMs) / 1000) * fps))
}

export function projectSequence(playback: SequencePlayback, sinceReceivedMs: number): SequenceProgress {
  const { step, transition, endFade } = playback
  if (playback.ended) {
    const fadeElapsed = endFade === null
      ? null
      : Math.min(endFade.frames, endFade.elapsed + advancedFrames(playback.fps, playback.ageMs, sinceReceivedMs))
    return {
      stepElapsed: step.duration, stepDuration: step.duration, repeat: step.repeat,
      sequenceFrame: playback.totalFrames, totalFrames: playback.totalFrames,
      transitionActive: false, fadeElapsed,
    }
  }
  const advance = Math.min(advancedFrames(playback.fps, playback.ageMs, sinceReceivedMs), step.duration - 1 - step.elapsed)
  const stepElapsed = step.elapsed + advance
  const cycle = step.repeat ? step.duration / step.repeat.total : null
  return {
    stepElapsed,
    stepDuration: step.duration,
    repeat: step.repeat && cycle
      ? { current: Math.min(step.repeat.total, Math.floor(stepElapsed / cycle) + 1), total: step.repeat.total }
      : null,
    sequenceFrame: playback.sequenceFrame + advance,
    totalFrames: playback.totalFrames,
    transitionActive: transition !== null && transition.elapsed + advance < transition.frames,
    fadeElapsed: null,
  }
}

export function projectSingle(playback: SinglePlayback, sinceReceivedMs: number): SingleProgress {
  const frame = playback.frame + advancedFrames(playback.fps, playback.ageMs, sinceReceivedMs)
  const cycle = playback.cycle
  return {
    frame,
    cycle: cycle ? { current: Math.floor(frame / cycle.frames) + 1, elapsed: frame % cycle.frames, frames: cycle.frames } : null,
  }
}

// 超過這段時間沒有新的輪詢結果，就不再外推後端位置。 / Stop extrapolating when polls have been missing this long.
export const PLAYBACK_STALE_MS = 5_000

/** The backend's playback frame now (fractional), or null when it is not playing or polls went stale. */
export function liveBackendFrame(playback: BackendPlayback | null, sinceReceivedMs: number): number | null {
  if (!playback?.active || sinceReceivedMs > PLAYBACK_STALE_MS) return null
  return playback.frame + ((playback.ageMs + sinceReceivedMs) / 1000) * playback.fps
}
