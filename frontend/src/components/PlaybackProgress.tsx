import { useEffect, useState } from 'react'
import type { BackendPlayback } from '../backendApi'
import { getEffectManifest } from '../effects'
import { projectSequence, projectSingle } from '../playbackProgress'

type PlaybackProgressProps = {
  playback: BackendPlayback | null
  receivedAt: number
  error: string | null
  stepCount: number | null
}

const TRANSITION_LABELS = { crossfade: '交叉淡化中', 'fade-black': '淡出再淡入中', 'unit-fade-black': '逐台淡出再淡入中' } as const

function seconds(frames: number, fps: number) {
  return (frames / fps).toFixed(1)
}

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  return <progress className="playback-bar" value={Math.min(value, max)} max={Math.max(1, max)} aria-label={label} />
}

export function PlaybackProgress({ playback, receivedAt, error, stepCount }: PlaybackProgressProps) {
  const [now, setNow] = useState(() => performance.now())
  const active = playback !== null && playback.active
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setNow(performance.now()), 100)
    return () => window.clearInterval(timer)
  }, [active])

  let body
  if (error) {
    body = <p className="backend-error" role="alert">{error}</p>
  } else if (playback === null) {
    body = <p className="control-note">讀取中…</p>
  } else if (!playback.active) {
    body = <p role="status">後端目前沒有輸出 Art-Net（以 --api-only 啟動或尚未開始）。</p>
  } else if (playback.mode === 'single') {
    const progress = projectSingle(playback, Math.max(0, now - receivedAt))
    const label = getEffectManifest(playback.effectId).label
    body = progress.cycle ? (
      <>
        <p role="status">單一效果 · {label} · 第 {progress.cycle.current} 次
          <span>{seconds(progress.cycle.elapsed, playback.fps)} / {seconds(progress.cycle.frames, playback.fps)} 秒</span></p>
        <Bar value={progress.cycle.elapsed} max={progress.cycle.frames} label="效果週期進度" />
      </>
    ) : (
      <p role="status">單一效果 · {label}<span>已播放 {seconds(progress.frame, playback.fps)} 秒</span></p>
    )
  } else {
    const progress = projectSequence(playback, Math.max(0, now - receivedAt))
    const { step, fps } = playback
    const label = getEffectManifest(step.effectId).label
    const status = playback.ended
      ? playback.ending === 'fade-black'
        ? progress.fadeElapsed !== null && playback.endFade && progress.fadeElapsed < playback.endFade.frames ? '播放完成 · 淡出中' : '播放完成 · 已淡出至黑'
        : '播放完成 · 維持最後畫面'
      : '第 ' + (step.index + 1) + (stepCount ? ' / ' + stepCount : '') + ' 段 · ' + label
        + (progress.repeat ? ' · 第 ' + progress.repeat.current + ' / ' + progress.repeat.total + ' 次' : '')
    body = (
      <>
        <p role="status">{status}
          {progress.transitionActive && playback.transition && <em>{TRANSITION_LABELS[playback.transition.kind]}</em>}
          <span>{seconds(progress.stepElapsed, fps)} / {seconds(progress.stepDuration, fps)} 秒</span></p>
        <Bar value={progress.stepElapsed} max={progress.stepDuration} label="段落進度" />
        <p className="playback-total">{playback.ending === 'loop' ? '第 ' + playback.loopIteration + ' 輪' : '整體'}
          <span>{seconds(progress.sequenceFrame, fps)} / {seconds(progress.totalFrames, fps)} 秒</span></p>
        <Bar value={progress.sequenceFrame} max={progress.totalFrames} label="串接整體進度" />
      </>
    )
  }

  return (
    <div className="playback-progress">
      <span className="control-label">後端播放進度</span>
      {body}
    </div>
  )
}
