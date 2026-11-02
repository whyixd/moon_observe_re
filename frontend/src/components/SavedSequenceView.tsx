import { getEffectManifest } from '../effects'
import { compileSequence, type SequenceDocument, type SequenceStep } from '../simulation/sequence'

const ENDING_LABELS = { hold: '維持最後畫面', loop: '循環播放', 'fade-black': '淡出至黑' } as const
const TRANSITION_LABELS = { cut: '直接切換', crossfade: '交叉淡化', 'fade-black': '淡出再淡入', 'unit-fade-black': '逐台淡出再淡入' } as const

type SavedSequenceViewProps = {
  document: SequenceDocument | null
  fps: number
  unitCount: number
  playingStepId: number | null
  playbackMode: 'sequence' | 'single'
  busy: boolean
  error: string | null
  restartDisabled: boolean
  onReload: () => void
  onRestart: () => void
}

function transitionText(step: SequenceStep) {
  return step.transition.kind === 'cut'
    ? TRANSITION_LABELS.cut
    : TRANSITION_LABELS[step.transition.kind] + ' ' + step.transition.seconds + ' 秒'
}

// 後端控制模式下唯讀顯示後端已儲存的串接。 / Read-only view of the backend's saved sequence in backend control mode.
export function SavedSequenceView({
  document, fps, unitCount, playingStepId, playbackMode, busy, error, restartDisabled, onReload, onRestart,
}: SavedSequenceViewProps) {
  let totalSeconds: number | null = null
  if (document) {
    try {
      totalSeconds = compileSequence(document.steps, fps, unitCount, document.ending).totalFrames / fps
    } catch {
      totalSeconds = null
    }
  }
  const ending = document?.ending

  return (
    <div className="saved-sequence">
      <span className="control-label">後端已儲存的串接</span>
      {error && <p className="backend-error" role="alert">{error}</p>}
      {document === null ? (
        <p className="control-note">{busy ? '讀取中…' : '尚未讀取到後端串接。'}</p>
      ) : (
        <>
          <p className="sequence-status" role="status">
            共 {document.steps.length} 段 · 結束後{ending && ENDING_LABELS[ending.kind]}
            {ending?.kind === 'fade-black' ? ' ' + ending.seconds + ' 秒' : ''}
            <span>{ending?.kind === 'loop' ? '每輪' : '全長'}{totalSeconds === null ? ' —' : ' 約 ' + totalSeconds.toFixed(1) + ' 秒'}</span>
          </p>
          <p className="saved-sequence-mode">
            後端目前播放：{playbackMode === 'sequence' ? '串接' : '單一效果（按「從頭播放串接」切回）'}
          </p>
          <ol className="saved-sequence-list">
            {document.steps.map((step, index) => {
              const playing = step.id === playingStepId
              const last = index === document.steps.length - 1
              return (
                <li key={step.id} className={playing ? 'playing' : undefined} aria-current={playing ? 'step' : undefined}>
                  <span>
                    {index + 1}. {getEffectManifest(step.preset.effectId).label}
                    {playing && <em className="playing-badge">播放中</em>}
                  </span>
                  <small>
                    {step.playback.kind === 'count' ? '播放 ' + step.playback.count + ' 次' : '播放 ' + step.playback.seconds + ' 秒'}
                    {!last || ending?.kind === 'loop' ? ' · ' + (last ? '接回第一段：' : '接下一段：') + transitionText(step) : ''}
                  </small>
                </li>
              )
            })}
          </ol>
        </>
      )}
      <div className="button-row saved-sequence-actions">
        <button type="button" className="secondary" onClick={onReload} disabled={busy}>重新讀取</button>
        <button type="button" onClick={onRestart} disabled={restartDisabled}>從頭播放串接</button>
      </div>
      <p className="control-note">要修改串接，請切到「模擬」模式編輯後按「儲存串接」。</p>
    </div>
  )
}
