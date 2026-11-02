import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyBackendPreset, getBackendPlayback, getBackendSequence, getBackendState, getWeatherState, restartBackendPlayback, saveBackendSequence, setBackendMotor, type BackendPlayback, type BackendState, type WeatherState } from './backendApi'
import { ControlPanel } from './components/ControlPanel'
import {
  createDefaultEffectPreset,
  EFFECT_MANIFEST,
  getEffectManifest,
  type EffectColor,
  type EffectId,
  type EffectPreset,
  type UnitVariation,
} from './effects'
import {
  DEFAULT_SETTINGS,
  degreesPerControllerFrame,
  type SceneMode,
  type SimulationSettings,
} from './simulation/model'
import { liveBackendFrame } from './playbackProgress'
import { compileSequence, createSequenceStep, defaultPlaybackRule, resolveSequenceFrame, sequenceSeekFrame, type SequenceSeek, type PlaybackRule, type SequenceDocument, type SequenceEnding, type SequenceStep, type TransitionKind } from './simulation/sequence'
import { SimulationCanvas } from './simulation/scene/SimulationCanvas'
import type { Diagnostics } from './simulation/scene/LightTrail'

const INITIAL_DIAGNOSTICS: Diagnostics = {
  angleDegrees: 0,
  controllerFrame: 0,
  globalFrame: 0,
  cyclePhase: 0,
  simulationTime: 0,
}

export function App() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS)
  const [effectId, setEffectId] = useState<EffectId>('center-out-sine')
  const [effectPresets, setEffectPresets] = useState(() => Object.fromEntries(
    EFFECT_MANIFEST.map(({ id }) => [id, createDefaultEffectPreset(id)]),
  ) as Record<EffectId, ReturnType<typeof createDefaultEffectPreset>>)
  const [sequenceEnabled, setSequenceEnabled] = useState(false)
  const [sequenceSteps, setSequenceSteps] = useState<SequenceStep[]>(() => [
    createSequenceStep(1, createDefaultEffectPreset('center-out-sine')),
    createSequenceStep(2, createDefaultEffectPreset('sequential-center-fill')),
  ])
  const [selectedStepId, setSelectedStepId] = useState(1)
  const [sequenceEnding, setSequenceEnding] = useState<SequenceEnding>({ kind: 'hold' })
  const [savedSequence, setSavedSequence] = useState<string | null>(null)
  const [sequenceConnected, setSequenceConnected] = useState(false)
  const [sequencePlaybackMode, setSequencePlaybackMode] = useState<'sequence' | 'single'>('sequence')
  const [sequenceBusy, setSequenceBusy] = useState(false)
  const [sequenceRefresh, setSequenceRefresh] = useState(0)
  const [sequenceError, setSequenceError] = useState<string | null>(null)
  const sequenceRequest = useRef(0)
  const sequenceEditRevision = useRef(0)
  const sequenceEdited = useRef(false)
  const nextStepId = useRef(3)
  const [sequenceRevision, setSequenceRevision] = useState(0)
  const [diagnostics, setDiagnostics] = useState(INITIAL_DIAGNOSTICS)
  const [paused, setPaused] = useState(false)
  const [resetToken, setResetToken] = useState(0)
  const [sceneMode, setSceneMode] = useState<SceneMode>('nine')
  const [selectedUnit, setSelectedUnit] = useState(0)
  const [showStructure, setShowStructure] = useState(true)
  const [controlMode, setControlMode] = useState<'simulation' | 'backend'>('simulation')
  const [backendState, setBackendState] = useState<BackendState | null>(null)
  const [backendBusy, setBackendBusy] = useState(false)
  const [backendError, setBackendError] = useState<string | null>(null)
  const [backendRefresh, setBackendRefresh] = useState(0)
  const [weather, setWeather] = useState<WeatherState | null>(null)
  const [playback, setPlayback] = useState<{ state: BackendPlayback | null; receivedAt: number; unsupported: boolean }>(
    { state: null, receivedAt: 0, unsupported: false },
  )
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [playbackPoll, setPlaybackPoll] = useState(0)
  const backendRequest = useRef(0)
  const sequenceDocument: SequenceDocument = { schemaVersion: 1, ending: sequenceEnding, steps: sequenceSteps }
  const sequenceDirty = savedSequence === null || JSON.stringify(sequenceDocument) !== savedSequence
  const markSequenceEdited = () => {
    sequenceEdited.current = true
    sequenceEditRevision.current += 1
  }
  const inSequence = controlMode === 'simulation' && sequenceEnabled
  const savedDocument = useMemo(
    () => savedSequence === null ? null : JSON.parse(savedSequence) as SequenceDocument,
    [savedSequence],
  )
  const backendPlayingStepId = playback.state?.active && playback.state.mode === 'sequence' && !playback.state.ended
    ? playback.state.step.id : null
  // 只在編輯器內容與後端已儲存的串接一致時標示播放段落。 / Mark the playing step only when the editor matches the saved sequence.
  const playingStepId = sequenceEnabled && !sequenceDirty ? backendPlayingStepId : null
  const selectedStep = sequenceSteps.find((step) => step.id === selectedStepId) ?? sequenceSteps[0]
  const effectPreset = inSequence ? selectedStep.preset : effectPresets[effectId]
  const sequenceSchedule = useMemo(
    () => compileSequence(sequenceSteps, settings.controllerFps, sceneMode === 'nine' ? 9 : 1, sequenceEnding),
    [sequenceSteps, settings.controllerFps, sceneMode, sequenceEnding],
  )
  const currentSequenceFrame = resolveSequenceFrame(sequenceSchedule, diagnostics.globalFrame)!

  // 後端控制時 3D 畫面顯示後端實際輸出：播放中的串接或已套用的效果，時間跟隨 /api/playback。
  // In backend mode the 3D view mirrors the live output: the saved sequence or applied preset, timed by /api/playback.
  const inBackend = controlMode === 'backend'
  const liveMode = playback.state?.active ? playback.state.mode : sequencePlaybackMode
  const backendSchedule = useMemo(
    () => savedDocument === null ? null : compileSequence(
      savedDocument.steps, settings.controllerFps, backendState?.output.unitCount ?? 9, savedDocument.ending ?? { kind: 'hold' },
    ),
    [savedDocument, settings.controllerFps, backendState?.output.unitCount],
  )
  const viewSequence = inBackend
    ? liveMode === 'sequence' ? backendSchedule : null
    : inSequence ? sequenceSchedule : null
  const viewPreset = inBackend && backendState ? backendState.preset : effectPreset
  const playbackRef = useRef(playback)
  playbackRef.current = playback
  const backendFrame = useCallback(() => (
    liveBackendFrame(playbackRef.current.state, performance.now() - playbackRef.current.receivedAt)
  ), [])
  const following = inBackend && liveBackendFrame(playback.state, 0) !== null
  const unitTestColors = inBackend && playback.state?.active ? playback.state.unitColors ?? null : null
  const displayedPreset = viewSequence
    ? resolveSequenceFrame(viewSequence, diagnostics.globalFrame)!.layers.at(-1)!.preset
    : viewPreset

  // 後端重新開始播放（別處套用、儲存或天氣變化）時，更新 3D 鏡像用的效果與串接，不動編輯中的內容。
  // When the backend restarts playback (applied or saved elsewhere, weather change), refresh what the 3D view mirrors without touching edits.
  const liveRestart = inBackend && playback.state?.active ? playback.state.restart : null
  useEffect(() => {
    if (liveRestart === null) return
    let active = true
    void Promise.all([getBackendState(), getBackendSequence()]).then(([state, data]) => {
      if (!active) return
      setBackendState(state)
      setSavedSequence(JSON.stringify({ ...data.sequence, ending: data.sequence.ending ?? { kind: 'hold' } }))
      setSequencePlaybackMode(data.playbackMode)
    }).catch(() => {})
    return () => { active = false }
  }, [liveRestart])

  // 重新預覽時跳到的位置：修改哪一段就從那一段（或它的銜接）開始。
  // Where a preview restart jumps to: the edited step (or its transition) instead of the beginning.
  const seekTarget = useRef<SequenceSeek>({ kind: 'start' })
  const resetSequencePreview = useCallback((seek: SequenceSeek = { kind: 'start' }) => {
    seekTarget.current = seek
    setSequenceRevision((current) => current + 1)
    setDiagnostics(INITIAL_DIAGNOSTICS)
  }, [])

  useEffect(() => {
    let active = true
    const refresh = () => {
      void getWeatherState().then((state) => { if (active) setWeather(state) }).catch(() => {})
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let active = true
    let timer = 0
    const poll = () => {
      window.clearTimeout(timer)
      if (document.hidden) return
      void getBackendPlayback().then((state) => {
        if (!active) return
        setPlayback({ state, receivedAt: performance.now(), unsupported: state === null })
        setPlaybackError(null)
      }).catch(() => {
        if (active) setPlaybackError('無法取得後端播放進度')
      }).finally(() => {
        if (active) timer = window.setTimeout(poll, 1_000)
      })
    }
    poll()
    document.addEventListener('visibilitychange', poll)
    return () => {
      active = false
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', poll)
    }
  }, [playbackPoll])

  useEffect(() => {
    if (weather?.generation) resetSequencePreview()
  }, [weather?.generation, resetSequencePreview])

  const updateSelectedStep = useCallback((
    change: (step: SequenceStep) => SequenceStep,
    seek: SequenceSeek = { kind: 'step', id: selectedStepId },
  ) => {
    markSequenceEdited()
    setSequenceSteps((current) => current.map((step) => (
      step.id === selectedStepId ? change(step) : step
    )))
    resetSequencePreview(seek)
  }, [selectedStepId, resetSequencePreview])

  useEffect(() => {
    const request = ++sequenceRequest.current
    setSequenceBusy(true)
    setSequenceError(null)
    void getBackendSequence().then((data) => {
      if (request !== sequenceRequest.current) return
      setSequenceConnected(true)
      setSequencePlaybackMode(data.playbackMode)
      const loadedEnding = data.sequence.ending ?? { kind: 'hold' }
      setSavedSequence(JSON.stringify({ ...data.sequence, ending: loadedEnding }))
      setSettings((current) => ({ ...current, controllerFps: data.output.fps, rpm: data.output.rpm }))
      if (data.output.unitCount === 1 || data.output.unitCount === 9) {
        setSceneMode(data.output.unitCount === 1 ? 'single' : 'nine')
      }
      if (!sequenceEdited.current || (savedSequence !== null && JSON.stringify(sequenceDocument) === savedSequence)) {
        setSequenceEnabled(true)
        setSequenceEnding(loadedEnding)
        setSequenceSteps(data.sequence.steps)
        setSelectedStepId(data.sequence.steps[0].id)
        nextStepId.current = Math.max(...data.sequence.steps.map((step) => step.id)) + 1
        resetSequencePreview()
      }
    }).catch((error: unknown) => {
      if (request === sequenceRequest.current) {
        setSequenceConnected(false)
        setSequenceError(error instanceof Error ? error.message : '無法載入後端串接')
      }
    }).finally(() => {
      if (request === sequenceRequest.current) setSequenceBusy(false)
    })
    return () => { sequenceRequest.current += 1 }
  }, [resetSequencePreview, sequenceRefresh])

  const saveSequence = async () => {
    if (sequenceBusy) return
    const request = sequenceRequest.current
    const editRevision = sequenceEditRevision.current
    const document = sequenceDocument
    setSequenceBusy(true)
    setSequenceError(null)
    try {
      const state = await saveBackendSequence(document)
      if (request !== sequenceRequest.current) return
      setSequenceConnected(true)
      setSequencePlaybackMode(state.playbackMode)
      setSavedSequence(JSON.stringify(state.sequence))
      setPlaybackPoll((current) => current + 1)
      if (editRevision === sequenceEditRevision.current) sequenceEdited.current = false
      resetSequencePreview()
    } catch (error) {
      if (request === sequenceRequest.current) {
        setSequenceError(error instanceof Error ? error.message : '儲存串接失敗')
      }
    } finally {
      if (request === sequenceRequest.current) setSequenceBusy(false)
    }
  }

  useEffect(() => {
    if (controlMode !== 'backend') {
      backendRequest.current += 1
      setBackendBusy(false)
      return
    }
    const request = ++backendRequest.current
    setBackendBusy(true)
    setBackendError(null)
    setBackendState(null)
    void getBackendState().then((state) => {
      if (request !== backendRequest.current) return
      setBackendState(state)
      setEffectPresets((current) => ({ ...current, [state.preset.effectId]: state.preset }))
      setEffectId(state.preset.effectId)
      setSettings((current) => ({ ...current, controllerFps: state.output.fps, rpm: state.output.rpm }))
    }).catch((error: unknown) => {
      if (request === backendRequest.current) {
        setBackendError(error instanceof Error ? error.message : '無法連線後端')
      }
    }).finally(() => {
      if (request === backendRequest.current) setBackendBusy(false)
    })
    return () => { backendRequest.current += 1 }
  }, [controlMode, backendRefresh])

  const applyToBackend = useCallback(async (preset: EffectPreset) => {
    if (controlMode !== 'backend' || backendBusy || backendState === null) return
    const request = backendRequest.current
    setBackendBusy(true)
    setBackendError(null)
    try {
      const state = await applyBackendPreset(preset)
      if (request === backendRequest.current) {
        setBackendState(state)
        setSequencePlaybackMode('single')
        setPlaybackPoll((current) => current + 1)
      }
    } catch (error) {
      if (request === backendRequest.current) {
        setBackendError(error instanceof Error ? error.message : '套用失敗')
      }
    } finally {
      if (request === backendRequest.current) setBackendBusy(false)
    }
  }, [backendBusy, backendState, controlMode])

  const setMotor = useCallback(async (enabled: boolean) => {
    if (controlMode !== 'backend' || backendBusy || backendState === null) return
    const request = backendRequest.current
    setBackendBusy(true)
    setBackendError(null)
    try {
      const state = await setBackendMotor(enabled)
      if (request === backendRequest.current) setBackendState(state)
    } catch (error) {
      if (request === backendRequest.current) {
        setBackendError(error instanceof Error ? error.message : '馬達命令送出失敗')
      }
    } finally {
      if (request === backendRequest.current) setBackendBusy(false)
    }
  }, [backendBusy, backendState, controlMode])

  const restartBackend = useCallback(async (source: 'sequence' | 'single') => {
    if (controlMode !== 'backend' || backendBusy || backendState === null) return
    const request = backendRequest.current
    setBackendBusy(true)
    setBackendError(null)
    try {
      const state = await restartBackendPlayback(source)
      if (request === backendRequest.current) {
        setSequencePlaybackMode(state.playbackMode)
        setPlaybackPoll((current) => current + 1)
      }
    } catch (error) {
      if (request === backendRequest.current) {
        setBackendError(error instanceof Error ? error.message : '重新播放失敗')
      }
    } finally {
      if (request === backendRequest.current) setBackendBusy(false)
    }
  }, [backendBusy, backendState, controlMode])

  const updateSetting = useCallback(
    (name: Exclude<keyof SimulationSettings, 'ledCount'>, value: number) => {
      setSettings((current) => ({ ...current, [name]: value }))
    },
    [],
  )

  const degreesPerFrame = useMemo(
    () => degreesPerControllerFrame(settings.rpm, settings.controllerFps),
    [settings.rpm, settings.controllerFps],
  )
  const exposureArc = (settings.rpm * 6 * settings.exposureMs) / 1000
  const activeEffect = getEffectManifest(displayedPreset.effectId)

  const selectEffect = useCallback((nextEffectId: EffectId) => {
    if (inSequence) {
      updateSelectedStep((step) => {
        const preset = createDefaultEffectPreset(nextEffectId)
        return { ...step, preset, playback: defaultPlaybackRule(preset) }
      })
    } else {
      setEffectId(nextEffectId)
    }
  }, [inSequence, updateSelectedStep])

  const updateEffectParameter = useCallback((key: string, value: number) => {
    const updatePreset = (preset: EffectPreset): EffectPreset => {
      const parameters = { ...preset.parameters, [key]: value }
      if (preset.effectId === 'random-leds' && key === 'holdFrames') {
        parameters.minHoldFrames = Math.min(parameters.minHoldFrames ?? 1, value)
      }
      return { ...preset, parameters }
    }
    if (inSequence) {
      updateSelectedStep((step) => ({ ...step, preset: updatePreset(step.preset) }))
    } else {
      setEffectPresets((current) => ({
        ...current, [effectId]: updatePreset(current[effectId]),
      }))
    }
  }, [effectId, inSequence, updateSelectedStep])

  const updateEffectColor = useCallback((color: EffectColor) => {
    if (inSequence) {
      updateSelectedStep((step) => ({ ...step, preset: { ...step.preset, color } }))
    } else {
      setEffectPresets((current) => ({
        ...current, [effectId]: { ...current[effectId], color },
      }))
    }
  }, [effectId, inSequence, updateSelectedStep])

  const updateUnitVariation = useCallback((unitVariation: UnitVariation | null) => {
    const updatePreset = (preset: EffectPreset): EffectPreset => {
      const { unitVariation: _, ...base } = preset
      return unitVariation ? { ...base, unitVariation } : base
    }
    if (inSequence) {
      updateSelectedStep((step) => ({ ...step, preset: updatePreset(step.preset) }))
    } else {
      setEffectPresets((current) => ({
        ...current, [effectId]: updatePreset(current[effectId]),
      }))
    }
  }, [effectId, inSequence, updateSelectedStep])

  const addStep = () => {
    markSequenceEdited()
    const id = nextStepId.current++
    const step = createSequenceStep(id, structuredClone(selectedStep.preset))
    const index = sequenceSteps.findIndex((item) => item.id === selectedStepId)
    setSequenceSteps([
      ...sequenceSteps.slice(0, index + 1),
      step,
      ...sequenceSteps.slice(index + 1),
    ])
    setSelectedStepId(id)
    resetSequencePreview({ kind: 'step', id })
  }

  const duplicateStep = () => {
    markSequenceEdited()
    const id = nextStepId.current++
    const step = { ...structuredClone(selectedStep), id }
    const index = sequenceSteps.findIndex((item) => item.id === selectedStepId)
    setSequenceSteps([
      ...sequenceSteps.slice(0, index + 1),
      step,
      ...sequenceSteps.slice(index + 1),
    ])
    setSelectedStepId(id)
    resetSequencePreview({ kind: 'step', id })
  }

  const removeStep = () => {
    if (sequenceSteps.length <= 1) return
    markSequenceEdited()
    const index = sequenceSteps.findIndex((item) => item.id === selectedStepId)
    const next = sequenceSteps.filter((item) => item.id !== selectedStepId)
    setSequenceSteps(next)
    const nextSelected = next[Math.min(index, next.length - 1)].id
    setSelectedStepId(nextSelected)
    resetSequencePreview({ kind: 'step', id: nextSelected })
  }

  const moveStep = (direction: -1 | 1) => {
    const index = sequenceSteps.findIndex((item) => item.id === selectedStepId)
    const destination = index + direction
    if (destination < 0 || destination >= sequenceSteps.length) return
    markSequenceEdited()
    const next = [...sequenceSteps]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    setSequenceSteps(next)
    resetSequencePreview({ kind: 'step', id: selectedStepId })
  }

  const updateEnding = (ending: SequenceEnding) => {
    markSequenceEdited()
    setSequenceEnding(ending)
    resetSequencePreview({ kind: 'transition', id: sequenceSteps[sequenceSteps.length - 1].id })
  }

  const updatePlayback = (playback: PlaybackRule) => {
    updateSelectedStep((step) => ({ ...step, playback }))
  }

  const updateTransition = (kind: TransitionKind, seconds: number) => {
    updateSelectedStep((step) => ({ ...step, transition: { kind, seconds } }), { kind: 'transition', id: selectedStepId })
  }

  const changeSceneMode = (mode: SceneMode) => {
    setSceneMode(mode)
    setSelectedUnit(0)
    setDiagnostics(INITIAL_DIAGNOSTICS)
    if (sequenceEnabled) resetSequencePreview()
  }

  return (
    <main className="app-shell simulator-shell">
      <header className="app-header">
        <h1>Moon Observe Simulator</h1>
        <div className="segmented-control mode-switch" aria-label="控制模式">
          <button type="button" className={controlMode === 'simulation' ? 'active' : 'secondary'}
            aria-pressed={controlMode === 'simulation'} onClick={() => setControlMode('simulation')}>模擬</button>
          <button type="button" className={controlMode === 'backend' ? 'active' : 'secondary'}
            aria-pressed={controlMode === 'backend'} onClick={() => setControlMode('backend')}>後端控制</button>
        </div>
      </header>

      <section className="workspace">
        <div className="viewport-panel">
          <div className="viewport-toolbar">
            <div className="button-row">
              <button type="button" onClick={() => setPaused((current) => !current)}>
                {paused ? '繼續' : '暫停'}
              </button>
              <button type="button" className="secondary" onClick={() => {
                seekTarget.current = { kind: 'start' }
                setResetToken((current) => current + 1)
                setDiagnostics(INITIAL_DIAGNOSTICS)
              }}>重設時間</button>
            </div>
            <div className="segmented-control" aria-label="Scene layout">
              <button type="button" className={sceneMode === 'single' ? 'active' : 'secondary'}
                aria-pressed={sceneMode === 'single'} onClick={() => changeSceneMode('single')}>單組</button>
              <button type="button" className={sceneMode === 'nine' ? 'active' : 'secondary'}
                aria-pressed={sceneMode === 'nine'} onClick={() => changeSceneMode('nine')}>1×9</button>
            </div>
            {sceneMode === 'nine' && (
              <div className="unit-picker" aria-label="Selected unit">
                {Array.from({ length: 9 }, (_, index) => (
                  <button type="button" key={index}
                    className={selectedUnit === index ? 'active' : 'secondary'}
                    aria-pressed={selectedUnit === index}
                    onClick={() => setSelectedUnit(index)}>{index + 1}</button>
                ))}
              </div>
            )}
            <label className="scene-toggle">
              <input type="checkbox" checked={showStructure}
                onChange={(event) => setShowStructure(event.target.checked)} />
              <span>骨架</span>
            </label>
          </div>
          <div className="canvas-wrap">
            <SimulationCanvas
              settings={settings}
              weather={weather}
              effectPreset={viewPreset}
              sequence={viewSequence}
              sequenceRevision={sequenceRevision}
              syncFrame={inBackend ? backendFrame : null}
              startFrame={inSequence ? sequenceSeekFrame(sequenceSchedule, seekTarget.current, settings.controllerFps) : 0}
              paused={paused}
              resetToken={resetToken}
              sceneMode={sceneMode}
              selectedUnit={selectedUnit}
              showStructure={showStructure}
              onSelectUnit={setSelectedUnit}
              onDiagnostics={setDiagnostics}
              unitColors={unitTestColors}
            />
            <p className="viewport-caption">
              <strong>{activeEffect.label}</strong>
              <span>{settings.controllerFps} FPS · {settings.rpm} RPM</span>
              {inBackend && (
                <span>{following
                  ? `後端輸出 · ${liveMode === 'sequence' ? '串接' : '單一效果'}`
                  : '後端未播放 · 本地模擬'}</span>
              )}
              {unitTestColors && <span className="viewport-test">單色測試中</span>}
            </p>
            <div className="diagnostics" aria-live="polite">
              <div><span>Rotor</span><strong>{diagnostics.angleDegrees.toFixed(1)}°</strong></div>
              <div><span>Frame</span><strong>{diagnostics.controllerFrame}</strong></div>
              <div><span>Phase</span><strong>{diagnostics.cyclePhase + 1}/20</strong></div>
              <div><span>°/frame</span><strong>{degreesPerFrame.toFixed(1)}°</strong></div>
              <div><span>Exposure</span><strong>{exposureArc.toFixed(1)}°</strong></div>
              <div><span>Time</span><strong>{diagnostics.simulationTime.toFixed(1)} s</strong></div>
            </div>
          </div>
        </div>

        <ControlPanel
          settings={settings}
          weather={weather}
          onWeather={setWeather}
          effectPreset={effectPreset}
          sceneMode={sceneMode}
          controlMode={controlMode}
          backendState={backendState}
          backendBusy={backendBusy}
          backendError={backendError}
          backendDirty={backendState !== null && JSON.stringify(effectPreset) !== JSON.stringify(backendState.preset)}
          playback={playback.unsupported ? null : playback.state}
          playbackSupported={!playback.unsupported}
          playbackReceivedAt={playback.receivedAt}
          playbackError={playbackError}
          playbackStepCount={savedDocument?.steps.length ?? null}
          savedSequence={savedDocument}
          backendPlayingStepId={backendPlayingStepId}
          playingStepId={playingStepId}
          sequenceEnabled={sequenceEnabled}
          sequenceConnected={sequenceConnected}
          sequencePlaybackMode={sequencePlaybackMode}
          sequenceBusy={sequenceBusy}
          sequenceError={sequenceError}
          sequenceDirty={sequenceDirty}
          onSaveSequence={() => { void saveSequence() }}
          onReloadSequence={() => setSequenceRefresh((current) => current + 1)}
          sequenceSteps={sequenceSteps}
          sequenceEnding={sequenceEnding}
          selectedStepId={selectedStepId}
          sequenceSchedule={sequenceSchedule}
          currentSequenceFrame={currentSequenceFrame}
          onSequenceEnabled={(enabled) => { setSequenceEnabled(enabled); resetSequencePreview() }}
          onSequenceSelect={setSelectedStepId}
          onSequencePlayFrom={(id) => resetSequencePreview({ kind: 'step', id })}
          onSequencePreviewTransition={(id) => resetSequencePreview({ kind: 'transition', id })}
          onSequenceAdd={addStep}
          onSequenceDuplicate={duplicateStep}
          onSequenceRemove={removeStep}
          onSequenceMove={moveStep}
          onSequencePlayback={updatePlayback}
          onSequenceEnding={updateEnding}
          onSequenceTransition={updateTransition}
          onRefreshBackend={() => setBackendRefresh((current) => current + 1)}
          onApplyBackend={() => { void applyToBackend(effectPreset) }}
          onMotor={(enabled) => { void setMotor(enabled) }}
          onRestartBackend={(source) => { void restartBackend(source) }}
          onUnitColorTest={() => setPlaybackPoll((current) => current + 1)}
          onSetting={updateSetting}
          onEffectChange={selectEffect}
          onEffectParameter={updateEffectParameter}
          onEffectColor={updateEffectColor}
          onUnitVariation={updateUnitVariation}
        />
      </section>

    </main>
  )
}
