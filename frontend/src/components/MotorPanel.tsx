import type { BackendMotorState, MotorCommand } from '../backendApi'
import { MOTOR_DIRECTIONS, MOTOR_SPEEDS, type MotorDirection, type MotorSpeed, type UnitMotor } from '../simulation/model'

const SPEED_LABELS: Record<MotorSpeed, string> = { stop: '停', mid: '中速', max: '全速' }
const DIRECTION_LABELS: Record<MotorDirection, string> = { cw: '順', ccw: '逆' }

type MotorPanelProps = {
  /** backend：送到後端；simulation：只改 3D 畫面。 / backend sends commands; simulation only changes the 3D view. */
  mode: 'backend' | 'simulation'
  motors: UnitMotor[]
  moonCorrection: boolean
  /** 後端的 channel 與 DMX 數值（後端模式才有）。 / Backend channels and DMX values (backend mode only). */
  backendMotor?: BackendMotorState | null
  disabled?: boolean
  /** 後端排程啟用中：馬達由排程控制，這裡只顯示。 / The backend schedule drives the motors; display only. */
  scheduled?: boolean
  onMotor: (command: MotorCommand) => void
  onMoonCorrection: (enabled: boolean) => void
}

function MotorRow({ label, motor, disabled, detail, onMotor }: {
  label: string
  /** null：「全部」列，各台不一致時不標示選取。 / null for the "all" row: nothing is marked when units differ. */
  motor: UnitMotor | null
  disabled: boolean
  detail?: string
  onMotor: (command: Omit<MotorCommand, 'unitIds'>) => void
}) {
  return (
    <div className="motor-row">
      <span className="motor-row-label">{label}{detail && <small>{detail}</small>}</span>
      <div className="segmented-control motor-speeds" role="group" aria-label={`${label} 速度`}>
        {MOTOR_SPEEDS.map((speed) => (
          <button key={speed} type="button" disabled={disabled}
            className={motor?.speed === speed ? 'active' : 'secondary'}
            aria-pressed={motor?.speed === speed}
            onClick={() => onMotor({ speed })}>{SPEED_LABELS[speed]}</button>
        ))}
      </div>
      <div className="segmented-control motor-directions" role="group" aria-label={`${label} 方向`}>
        {MOTOR_DIRECTIONS.map((direction) => (
          <button key={direction} type="button" disabled={disabled}
            className={motor?.direction === direction ? 'active' : 'secondary'}
            aria-pressed={motor?.direction === direction}
            onClick={() => onMotor({ direction })}>{DIRECTION_LABELS[direction]}</button>
        ))}
      </div>
    </div>
  )
}

/** 各台都一樣時回傳那個狀態，否則 null。 / The shared state when every unit agrees, else null. */
export function commonMotor(motors: UnitMotor[]): UnitMotor | null {
  if (motors.length === 0) return null
  const [first] = motors
  return motors.every((motor) => motor.speed === first.speed && motor.direction === first.direction) ? first : null
}

export function MotorPanel({
  mode,
  motors,
  moonCorrection,
  backendMotor = null,
  disabled = false,
  scheduled = false,
  onMotor,
  onMoonCorrection,
}: MotorPanelProps) {
  const channels = backendMotor?.channels
  const motorDisabled = disabled || scheduled
  return (
    <div className="motor-controls">
      <span className="control-label">
        {mode === 'backend' && channels
          ? `馬達控制 · Art-Net Channel ${channels.speed}（速度）／${channels.direction}（方向）`
          : '模擬馬達（只影響 3D 畫面）'}
      </span>
      {scheduled && (
        <p className="weather-override" role="status">排程啟用中：馬達由排程控制（到「排程」分頁關閉排程後才能手動控制）</p>
      )}
      <MotorRow label="全部" motor={commonMotor(motors)} disabled={motorDisabled} onMotor={onMotor} />
      {motors.map((motor, index) => {
        const unit = backendMotor?.units[index]
        return (
          <MotorRow key={index} label={`第 ${index + 1} 台`} motor={motor} disabled={motorDisabled}
            detail={unit && !scheduled ? `${unit.value}／${unit.directionValue}` : undefined}
            onMotor={(command) => onMotor({ ...command, unitIds: [index + 1] })} />
        )
      })}
      <label className="scene-toggle motor-moon">
        <input type="checkbox" checked={moonCorrection} disabled={disabled}
          onChange={(event) => onMoonCorrection(event.target.checked)} />
        <span>月亮校正（全速時兩腳漸暗、頂點壓暗）</span>
      </label>
      <p className="control-note">
        {mode === 'backend'
          ? '馬達由這裡手動控制，或由「排程」分頁定時控制；串接與效果不會改變轉速。後端重新啟動後一律停止、月亮校正回到設定檔的預設；Art-Net 中斷時控制器不會自動停止馬達。'
          : '模擬模式預設全速順轉；切到「後端控制」後改為顯示後端實際的馬達狀態。'}
      </p>
    </div>
  )
}
