import { useState } from 'react'
import {
  EFFECT_MANIFEST,
  getEffectManifest,
  getVariableParameters,
  presetForUnit,
  rgbToHex,
  type AxisChange,
  type EffectColor,
  type EffectId,
  type EffectPreset,
  type GradientAxis,
  type UnitVariation,
  type UnitVariationDistribution,
} from '../effects'
import type { BackendPlayback, BackendState, WeatherState } from '../backendApi'
import type { CompiledSequence, PlaybackRule, SequenceDocument, SequenceEnding, SequenceFrame, SequenceStep, TransitionKind } from '../simulation/sequence'
import { ColorInput, GradientEditor } from './GradientEditor'
import { PlaybackProgress } from './PlaybackProgress'
import { SavedSequenceView } from './SavedSequenceView'
import { SequenceEditor } from './SequenceEditor'
import { UnitColorTestPanel } from './UnitColorTestPanel'
import { CATEGORY_LABELS, WeatherPanel } from './WeatherPanel'
import type { SceneMode, SimulationSettings } from '../simulation/model'

type NumericSetting = Exclude<keyof SimulationSettings, 'ledCount'>
type ControlTab = 'effect' | 'color' | 'sequence' | 'backend' | 'weather' | 'physics'

type ControlPanelProps = {
  settings: SimulationSettings
  weather: WeatherState | null
  onWeather: (weather: WeatherState) => void
  effectPreset: EffectPreset
  sceneMode: SceneMode
  controlMode: 'simulation' | 'backend'
  backendState: BackendState | null
  backendBusy: boolean
  backendError: string | null
  backendDirty: boolean
  playback: BackendPlayback | null
  playbackSupported: boolean
  playbackReceivedAt: number
  playbackError: string | null
  playbackStepCount: number | null
  playingStepId: number | null
  savedSequence: SequenceDocument | null
  backendPlayingStepId: number | null
  sequenceEnabled: boolean
  sequenceConnected: boolean
  sequencePlaybackMode: 'sequence' | 'single'
  sequenceBusy: boolean
  sequenceError: string | null
  sequenceDirty: boolean
  onSaveSequence: () => void
  onReloadSequence: () => void
  sequenceSteps: SequenceStep[]
  sequenceEnding: SequenceEnding
  selectedStepId: number
  sequenceSchedule: CompiledSequence
  currentSequenceFrame: SequenceFrame
  onSequenceEnabled: (enabled: boolean) => void
  onSequenceSelect: (id: number) => void
  onSequencePlayFrom: (id: number) => void
  onSequencePreviewTransition: (id: number) => void
  onSequenceAdd: () => void
  onSequenceDuplicate: () => void
  onSequenceRemove: () => void
  onSequenceMove: (direction: -1 | 1) => void
  onSequencePlayback: (playback: PlaybackRule) => void
  onSequenceEnding: (ending: SequenceEnding) => void
  onSequenceTransition: (kind: TransitionKind, seconds: number) => void
  onRefreshBackend: () => void
  onApplyBackend: () => void
  onMotor: (enabled: boolean) => void
  onRestartBackend: (source: 'sequence' | 'single') => void
  onUnitColorTest: () => void
  onSetting: (name: NumericSetting, value: number) => void
  onEffectChange: (effectId: EffectId) => void
  onEffectParameter: (key: string, value: number) => void
  onEffectColor: (color: EffectColor) => void
  onUnitVariation: (variation: UnitVariation | null) => void
}

type SliderProps = {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  onChange: (value: number) => void
  disabled?: boolean
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  disabled = false,
}: SliderProps) {
  return (
    <label className="control-field">
      <span>
        {label}
        <output>{value.toLocaleString()} {unit}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  )
}


const DISTRIBUTIONS: ReadonlyArray<[UnitVariationDistribution, string]> = [
  ['linear', '依序'],
  ['skip', '跳著排'],
  ['random', '隨機'],
]
const VARIATION_UNIT_COUNT = 9

function UnitVariationEditor({
  effectPreset,
  onChange,
}: {
  effectPreset: EffectPreset
  onChange: (variation: UnitVariation | null) => void
}) {
  const parameters = getVariableParameters(effectPreset.effectId)
  if (parameters.length === 0) return null
  const variation = effectPreset.unitVariation
  const definition = parameters.find((parameter) => parameter.key === variation?.parameter) ?? parameters[0]

  // 從目前值開始，結束值取往較寬一側的一半，讓差異一開始就看得到。
  // Start at the current value and end halfway toward the wider side, so the difference shows right away.
  const startFor = (key: string): UnitVariation => {
    const parameter = parameters.find((entry) => entry.key === key) ?? parameters[0]
    const current = effectPreset.parameters[parameter.key] ?? parameter.defaultValue
    const edge = current - parameter.min < parameter.max - current ? parameter.max : parameter.min
    const to = parameter.min + Math.round(((current + edge) / 2 - parameter.min) / parameter.step) * parameter.step
    return { parameter: parameter.key, from: current, to: Number(to.toFixed(6)), distribution: variation?.distribution ?? 'linear' }
  }
  const values = variation
    ? Array.from({ length: VARIATION_UNIT_COUNT }, (_, index) => (
      presetForUnit(effectPreset, index, VARIATION_UNIT_COUNT).parameters[definition.key]
    ))
    : []

  return (
    <div className="color-controls unit-variation">
      <div className="unit-variation-row">
        <label className="scene-toggle">
          <input type="checkbox" checked={variation !== undefined}
            onChange={(event) => onChange(event.target.checked ? startFor(definition.key) : null)} />
          <span>各燈台不同數值</span>
        </label>
        {variation && (
          <select aria-label="參數" value={definition.key} onChange={(event) => onChange(startFor(event.target.value))}>
            {parameters.map((parameter) => (
              <option key={parameter.key} value={parameter.key}>{parameter.label}</option>
            ))}
          </select>
        )}
      </div>
      {variation && (
        <>
          <div className="segmented-control" aria-label="分布方式">
            {DISTRIBUTIONS.map(([distribution, label]) => (
              <button key={distribution} type="button"
                className={variation.distribution === distribution ? 'active' : 'secondary'}
                aria-pressed={variation.distribution === distribution}
                onClick={() => onChange({ ...variation, distribution })}>{label}</button>
            ))}
          </div>
          <Slider label="起始值" value={variation.from} min={definition.min} max={definition.max}
            step={definition.step} unit={definition.unit}
            onChange={(from) => onChange({ ...variation, from })} />
          <Slider label="結束值" value={variation.to} min={definition.min} max={definition.max}
            step={definition.step} unit={definition.unit}
            onChange={(to) => onChange({ ...variation, to })} />
          <p className="control-note">第 1–9 台：{values.map((value) => value.toLocaleString()).join('、')}</p>
        </>
      )}
    </div>
  )
}

const AXIS_LABELS: ReadonlyArray<[GradientAxis, string]> = [
  ['radius', '中心 → 兩端'],
  ['strip', '半圓一端 → 另一端'],
  ['unit', '依燈台（每台一個純色）'],
]

// 中途切換方向：從效果（串接時為該段）開始計時，九台同時切換。
// Axis change partway through: timed from the effect (or sequence step) start; all units switch together.
function AxisChangeEditor({
  axis,
  change,
  onChange,
}: {
  axis: GradientAxis
  change: AxisChange | undefined
  onChange: (change: AxisChange | undefined) => void
}) {
  const start = (): AxisChange => ({
    to: axis === 'radius' ? 'unit' : 'radius', atSeconds: 4, blendSeconds: 1, repeat: false,
  })
  return (
    <div className="color-controls axis-change">
      <div className="unit-variation-row">
        <label className="scene-toggle">
          <input type="checkbox" checked={change !== undefined}
            onChange={(event) => onChange(event.target.checked ? start() : undefined)} />
          <span>中途切換方向</span>
        </label>
      </div>
      {change && (
        <>
          <label className="control-field gradient-axis">
            <span>切換成</span>
            <select value={change.to}
              onChange={(event) => onChange({ ...change, to: event.target.value as GradientAxis })}>
              {AXIS_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <div className="segmented-control" aria-label="切換方式">
            <button type="button" className={!change.repeat ? 'active' : 'secondary'} aria-pressed={!change.repeat}
              onClick={() => onChange({ ...change, repeat: false })}>切換一次</button>
            <button type="button" className={change.repeat ? 'active' : 'secondary'} aria-pressed={change.repeat}
              onClick={() => onChange({ ...change, repeat: true })}>來回交替</button>
          </div>
          <Slider label={change.repeat ? '每個方向停留' : '切換時間'} value={change.atSeconds} min={0.5} max={30}
            step={0.5} unit="秒" onChange={(atSeconds) => onChange({ ...change, atSeconds })} />
          <Slider label="過渡時間" value={change.blendSeconds} min={0} max={5} step={0.1} unit="秒"
            onChange={(blendSeconds) => onChange({ ...change, blendSeconds })} />
          <p className="control-note">
            {change.to === axis ? '切換前後是同一個方向，看不出變化。' : change.repeat
              ? `從效果開始算（串接時從該段開始），每 ${change.atSeconds} 秒在兩個方向間來回漸變。`
              : `從效果開始算（串接時從該段開始），第 ${change.atSeconds} 秒起漸變到新方向；段落比這短就不會切換。`}
          </p>
        </>
      )}
    </div>
  )
}

function effectParameterMax(
  effectPreset: EffectPreset,
  ledCount: number,
  key: string,
  manifestMax: number,
): number {
  if (effectPreset.effectId !== 'periodic-leds') return manifestMax

  const litCount = Math.max(1, Math.round(effectPreset.parameters.litCount ?? 12))
  const darkGap = Math.max(0, Math.round(effectPreset.parameters.darkGap ?? 12))
  if (key === 'litCount') {
    return Math.min(manifestMax, Math.floor((ledCount - 1) / (darkGap + 1)) + 1)
  }
  if (key === 'darkGap' && litCount > 1) {
    return Math.min(
      manifestMax,
      Math.max(0, Math.floor((ledCount - 1) / (litCount - 1)) - 1),
    )
  }
  return manifestMax
}

export function ControlPanel({
  settings,
  weather,
  onWeather,
  effectPreset,
  sceneMode,
  controlMode,
  backendState,
  backendBusy,
  backendError,
  backendDirty,
  playback,
  playbackSupported,
  playbackReceivedAt,
  playbackError,
  playbackStepCount,
  playingStepId,
  savedSequence,
  backendPlayingStepId,
  sequenceEnabled,
  sequenceConnected,
  sequencePlaybackMode,
  sequenceBusy,
  sequenceError,
  sequenceDirty,
  onSaveSequence,
  onReloadSequence,
  sequenceSteps,
  sequenceEnding,
  selectedStepId,
  sequenceSchedule,
  currentSequenceFrame,
  onSequenceEnabled,
  onSequenceSelect,
  onSequencePlayFrom,
  onSequencePreviewTransition,
  onSequenceAdd,
  onSequenceDuplicate,
  onSequenceRemove,
  onSequenceMove,
  onSequencePlayback,
  onSequenceEnding,
  onSequenceTransition,
  onRefreshBackend,
  onApplyBackend,
  onMotor,
  onRestartBackend,
  onUnitColorTest,
  onSetting,
  onEffectChange,
  onEffectParameter,
  onEffectColor,
  onUnitVariation,
}: ControlPanelProps) {
  const [tab, setTab] = useState<ControlTab>('effect')
  const activeEffect = getEffectManifest(effectPreset.effectId)
  const colorConfig = effectPreset.color

  const weatherFlag = colorConfig.weatherPalette === false ? { weatherPalette: false as const } : {}

  const changeColorMode = (mode: EffectColor['mode']) => {
    if (mode === colorConfig.mode) return
    if (colorConfig.mode === 'gradient') {
      onEffectColor({ mode: 'solid', color: colorConfig.colors[0], ...weatherFlag })
    } else {
      onEffectColor({
        mode: 'gradient',
        axis: effectPreset.effectId === 'center-out-sine' ? 'radius' : 'strip',
        colors: [colorConfig.color, { r: 1, g: 1, b: 1 }],
        ...weatherFlag,
      })
    }
  }

  const usesWeather = colorConfig.weatherPalette !== false

  // 天氣色盤只取顏色：方向存在效果的漸層設定裡；純色效果選方向時改成同色兩段的漸層，沒有天氣時看起來一樣。
  // The palette supplies colors only; the axis lives in the effect's gradient. Picking an axis on a solid effect
  // turns it into a two-stop gradient of the same color, which looks identical without weather.
  const changeAxis = (axis: GradientAxis) => {
    onEffectColor(colorConfig.mode === 'gradient'
      ? { ...colorConfig, axis }
      : { mode: 'gradient', axis, colors: [colorConfig.color, { ...colorConfig.color }], ...weatherFlag })
  }

  const axisSelect = (axis: GradientAxis) => (
    <label className="control-field gradient-axis">
      <span>漸層方向</span>
      <select value={axis} onChange={(event) => changeAxis(event.target.value as GradientAxis)}>
        {AXIS_LABELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
    </label>
  )

  // 隨機填滿不論方向都是每台一個純色，不提供切換。 / random-fill ignores the axis, so it has no axis change.
  const axisChangeEditor = () => colorConfig.mode === 'gradient' && effectPreset.effectId !== 'random-fill' && (
    <AxisChangeEditor axis={colorConfig.axis} change={colorConfig.axisChange} onChange={(axisChange) => {
      const { axisChange: _omit, ...color } = colorConfig
      onEffectColor(axisChange ? { ...color, axisChange } : color)
    }} />
  )

  // 自訂顏色編輯；當作天氣的備援時，方向已在上方選，不再重複顯示。
  // Custom color editor; as the weather fallback the axis is chosen above, so it is not repeated.
  const customColors = (showAxis: boolean) => (
    <>
      <div className="segmented-control" aria-label="顏色模式">
        <button type="button" className={colorConfig.mode === 'solid' ? 'active' : 'secondary'}
          aria-pressed={colorConfig.mode === 'solid'} onClick={() => changeColorMode('solid')}>純色</button>
        <button type="button" className={colorConfig.mode === 'gradient' ? 'active' : 'secondary'}
          aria-pressed={colorConfig.mode === 'gradient'} onClick={() => changeColorMode('gradient')}>漸層</button>
      </div>
      {colorConfig.mode === 'solid' ? (
        <ColorInput
          label="顏色"
          color={colorConfig.color}
          onChange={(color) => onEffectColor({ mode: 'solid', color, ...weatherFlag })}
        />
      ) : (
        <>
          {showAxis && axisSelect(colorConfig.axis)}
          {showAxis && axisChangeEditor()}
          <GradientEditor
            colors={colorConfig.colors}
            onChange={(colors) => onEffectColor({ ...colorConfig, colors })}
          />
        </>
      )}
    </>
  )

  const changeWeatherPalette = (enabled: boolean) => {
    const { weatherPalette: _omit, ...color } = colorConfig
    onEffectColor(enabled ? color : { ...color, weatherPalette: false })
  }

  const tabs: { id: ControlTab, label: string }[] = [
    { id: 'effect', label: '效果' },
    { id: 'color', label: '色彩' },
    { id: 'sequence', label: '串接' },
    { id: 'backend', label: '後端' },
    ...(weather ? [{ id: 'weather' as const, label: '天氣' }] : []),
    { id: 'physics', label: '物理' },
  ]
  const shownTab = tab === 'weather' && !weather ? 'effect' : tab

  return (
    <section className="controls" aria-label="控制面板">
      <div className="control-tabs" role="tablist" aria-label="控制分頁">
        {tabs.map(({ id, label }) => (
          <button type="button" role="tab" key={id} id={`control-tab-${id}`}
            aria-selected={shownTab === id} aria-controls="control-tabpanel"
            className={shownTab === id ? 'active' : 'secondary'} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <div className="control-tabpanel" id="control-tabpanel" role="tabpanel" aria-labelledby={`control-tab-${shownTab}`}>
        {shownTab === 'effect' && (
          <>
            <label className="control-field effect-picker">
              <span>{sequenceEnabled && controlMode === 'simulation' ? '編輯段落效果' : 'Effect'}</span>
              <select
                value={effectPreset.effectId}
                onChange={(event) => onEffectChange(event.target.value as EffectId)}
              >
                {EFFECT_MANIFEST.map((effect) => (
                  <option key={effect.id} value={effect.id}>{effect.label}</option>
                ))}
              </select>
            </label>

            {effectPreset.effectId === 'random-leds' && (
              <div className="color-controls">
                <span className="control-label">點亮時間模式</span>
                <div className="segmented-control" aria-label="點亮時間模式">
                  <button type="button" className={effectPreset.parameters.durationMode !== 1 ? 'active' : 'secondary'}
                    aria-pressed={effectPreset.parameters.durationMode !== 1}
                    onClick={() => onEffectParameter('durationMode', 0)}>等長</button>
                  <button type="button" className={effectPreset.parameters.durationMode === 1 ? 'active' : 'secondary'}
                    aria-pressed={effectPreset.parameters.durationMode === 1}
                    onClick={() => onEffectParameter('durationMode', 1)}>離中心越遠越短</button>
                </div>
              </div>
            )}

            {activeEffect.parameters.filter((parameter) => (
              parameter.key !== 'durationMode' &&
              parameter.key !== effectPreset.unitVariation?.parameter &&
              (parameter.key !== 'minHoldFrames' || effectPreset.parameters.durationMode === 1)
            )).map((parameter) => (
              <Slider
                key={parameter.key}
                label={parameter.label}
                value={effectPreset.parameters[parameter.key]}
                min={parameter.min}
                max={parameter.key === 'minHoldFrames'
                  ? Math.max(1, Math.round(effectPreset.parameters.holdFrames ?? 4))
                  : effectParameterMax(effectPreset, settings.ledCount, parameter.key, parameter.max)}
                step={parameter.step}
                unit={parameter.unit}
                onChange={(value) => onEffectParameter(parameter.key, value)}
              />
            ))}

            {effectPreset.effectId === 'random-leds' && effectPreset.parameters.durationMode === 1 && (
              <p className="control-note">
                外側設定為 {effectPreset.parameters.minHoldFrames ?? 1} 個 Art-Net 影格
                （目前約 {((effectPreset.parameters.minHoldFrames ?? 1) * 1000 / settings.controllerFps).toFixed(1)} ms）；
                可設下限為 1 影格（{(1000 / settings.controllerFps).toFixed(1)} ms）。
                中心維持變換間隔，越靠外側越接近設定的最短時間。
              </p>
            )}

            <UnitVariationEditor effectPreset={effectPreset} onChange={onUnitVariation} />

            <p className="effect-description">{activeEffect.description}</p>
          </>
        )}

        {shownTab === 'color' && (
          <div className="color-controls">
            {weather?.enabled && (
              <>
                <span className="control-label">顏色來源</span>
                <div className="segmented-control" aria-label="顏色來源">
                  <button type="button" className={usesWeather ? 'active' : 'secondary'}
                    aria-pressed={usesWeather} onClick={() => changeWeatherPalette(true)}>天氣色盤</button>
                  <button type="button" className={!usesWeather ? 'active' : 'secondary'}
                    aria-pressed={!usesWeather} onClick={() => changeWeatherPalette(false)}>自訂顏色</button>
                </div>
              </>
            )}
            {usesWeather && weather?.enabled ? (
              <>
                {axisSelect(colorConfig.mode === 'gradient' ? colorConfig.axis : weather.color?.mode === 'gradient' ? weather.color.axis : 'radius')}
                {axisChangeEditor()}
                <p className="control-note">
                  {weather.category && weather.color?.mode === 'gradient' ? (
                    <>
                      目前：{CATEGORY_LABELS[weather.category]}{weather.temperatureC !== null ? ` ${weather.temperatureC} °C` : ''}
                      <span className="palette-swatches" aria-hidden="true">
                        {weather.color.colors.map((color, index) => (
                          <span key={index} style={{ background: rgbToHex(color) }} />
                        ))}
                      </span>
                    </>
                  ) : '目前沒有天氣資料，暫時使用下方的自訂顏色。'}
                </p>
                <details className="fallback-colors">
                  <summary>沒有天氣資料時使用的顏色</summary>
                  {customColors(false)}
                </details>
              </>
            ) : (
              <>
                {customColors(true)}
                {weather?.enabled && (
                  <p className="control-note">天氣啟用時仍輸出這裡的顏色；天氣的分類效果（多雲錯開、雨天線條）照常。</p>
                )}
              </>
            )}
          </div>
        )}

        {shownTab === 'sequence' && (controlMode === 'simulation' ? (
          <SequenceEditor
            playingStepId={playingStepId}
            enabled={sequenceEnabled}
            connected={sequenceConnected}
            playbackMode={sequencePlaybackMode}
            busy={sequenceBusy}
            error={sequenceError}
            dirty={sequenceDirty}
            onSave={onSaveSequence}
            onReload={onReloadSequence}
            steps={sequenceSteps}
            ending={sequenceEnding}
            selectedId={selectedStepId}
            schedule={sequenceSchedule}
            currentStepIndex={currentSequenceFrame.stepIndex}
            complete={currentSequenceFrame.complete}
            fps={settings.controllerFps}
            unitCount={sceneMode === 'nine' ? 9 : 1}
            onEnabled={onSequenceEnabled}
            onSelect={onSequenceSelect}
            onPlayFrom={onSequencePlayFrom}
            onPreviewTransition={onSequencePreviewTransition}
            onAdd={onSequenceAdd}
            onDuplicate={onSequenceDuplicate}
            onRemove={onSequenceRemove}
            onMove={onSequenceMove}
            onPlayback={onSequencePlayback}
            onEnding={onSequenceEnding}
            onTransition={onSequenceTransition}
          />
        ) : (
          <SavedSequenceView
            document={savedSequence}
            fps={settings.controllerFps}
            unitCount={sceneMode === 'nine' ? 9 : 1}
            playingStepId={backendPlayingStepId}
            playbackMode={sequencePlaybackMode}
            busy={sequenceBusy}
            error={sequenceError}
            restartDisabled={backendBusy || backendState === null}
            onReload={onReloadSequence}
            onRestart={() => onRestartBackend('sequence')}
          />
        ))}

        {shownTab === 'backend' && playbackSupported && (
          <PlaybackProgress playback={playback} receivedAt={playbackReceivedAt}
            error={playbackError} stepCount={playbackStepCount} />
        )}

        {shownTab === 'backend' && (controlMode === 'backend' ? (
          <div className="backend-connection">
            <p role="status">
              {backendBusy ? '連線／套用中…' : backendState
                ? `已連線 · ${backendState.output.ip} · Universe ${backendState.output.universe} · 版本 ${backendState.revision}`
                : '尚未連線'}
            </p>
            {backendError && <p className="backend-error" role="alert">{backendError}</p>}
            <div className="button-row">
              <button type="button" className="secondary" onClick={onRefreshBackend} disabled={backendBusy}>重新讀取</button>
              <button type="button" onClick={onApplyBackend}
                disabled={backendBusy || backendState === null || !backendDirty}>套用到後端</button>
            </div>
            <p className="control-note">
              {backendState === null ? '連線後才能套用效果。' : backendDirty
                ? '目前畫面有尚未套用的效果變更。' : '目前效果已套用。'}
              只有效果、顏色與參數會送出；FPS／RPM 由後端 TOML 控制。
            </p>
            <div className="restart-controls">
              <span className="control-label">重新播放</span>
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => onRestartBackend('sequence')}
                  disabled={backendBusy || backendState === null}>從頭播放串接</button>
                <button type="button" className="secondary" onClick={() => onRestartBackend('single')}
                  disabled={backendBusy || backendState === null}>從頭播放單一效果</button>
              </div>
              <p className="control-note">
                重播後端已儲存的串接或已套用的效果；畫面上尚未儲存、套用的變更不會送出。
              </p>
            </div>
            <div className="motor-controls">
              <span className="control-label">馬達控制 · Art-Net Channel 469</span>
              <p role="status">{backendState?.motor.enabled ? '開啟命令：255（緩啟動）' : '關閉命令：0（緩停）'}</p>
              <div className="button-row">
                <button type="button" className="secondary" onClick={() => onMotor(false)}
                  disabled={backendBusy || backendState === null || !backendState.motor.enabled}>緩停關閉</button>
                <button type="button" onClick={() => onMotor(true)}
                  disabled={backendBusy || backendState === null || backendState.motor.enabled}>開啟緩啟動</button>
              </div>
              <p className="control-note">後端啟動預設為關閉。Channel 469 位於 156 顆 RGB 燈之後；斷線時是否停機需由接收端保障。</p>
            </div>
            {backendState && <UnitColorTestPanel unitCount={backendState.output.unitCount} onChange={onUnitColorTest} />}
          </div>
        ) : (
          <p className="control-note">切換到上方的「後端控制」後，才能連線、套用效果與控制馬達。</p>
        ))}

        {shownTab === 'weather' && weather && <WeatherPanel weather={weather} onWeather={onWeather} />}

        {shownTab === 'physics' && (
          <>
            <Slider
              label="Motor speed"
              value={settings.rpm}
              min={60}
              max={600}
              step={5}
              unit="RPM"
              onChange={(value) => onSetting('rpm', value)}
              disabled={controlMode === 'backend'}
            />
            <Slider
              label="Controller rate"
              value={settings.controllerFps}
              min={10}
              max={60}
              step={1}
              unit="FPS"
              onChange={(value) => onSetting('controllerFps', value)}
              disabled={controlMode === 'backend'}
            />
            <Slider
              label="Camera exposure"
              value={settings.exposureMs}
              min={0}
              max={50}
              step={1}
              unit="ms"
              onChange={(value) => onSetting('exposureMs', value)}
            />
            <Slider
              label="Visual persistence"
              value={settings.persistenceMs}
              min={0}
              max={160}
              step={5}
              unit="ms"
              onChange={(value) => onSetting('persistenceMs', value)}
            />
            <Slider
              label="Temporal samples"
              value={settings.temporalSamples}
              min={8}
              max={128}
              step={8}
              unit="samples"
              onChange={(value) => onSetting('temporalSamples', value)}
            />

            {sceneMode === 'nine' && (
              <>
                <Slider
                  label="Unit phase step"
                  value={settings.unitPhaseStepDegrees}
                  min={0}
                  max={90}
                  step={5}
                  unit="° / unit"
                  onChange={(value) => onSetting('unitPhaseStepDegrees', value)}
                />
                <Slider
                  label="Effect frame step"
                  value={settings.unitFrameOffsetStep}
                  min={0}
                  max={10}
                  step={1}
                  unit="frames / unit"
                  onChange={(value) => onSetting('unitFrameOffsetStep', value)}
                  disabled={weather?.category != null}
                />
              </>
            )}
            <p className="control-note">
              曝光區間內積分連續 rotor angle；LED 顏色只在 controller frame 邊界更新。
              Relative visual preview — not an electrical or safety certification.
            </p>
          </>
        )}
      </div>
    </section>
  )
}
