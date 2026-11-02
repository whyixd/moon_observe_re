import { describe, expect, it } from 'vitest'
import {
  angleAtTime,
  buildUnitLayouts,
  buildTemporalSamples,
  controllerFrameAtTime,
  controllerFrameStartTime,
  DEFAULT_SETTINGS,
  ALL_UNIT_SCALE,
  applyMotorCommand,
  degreesPerControllerFrame,
  DEFAULT_MOTOR_RPM,
  longnUnitPlacement,
  retimeRotor,
  rotorAngle,
  signedRpm,
  type UnitMotor,
  normalizedAngle,
  simulatedUnknownPhase,
  stripCoordinate,
  unitRelativeHeightAtPhase,
} from '../src/simulation/model'
import { ARC_RADIUS, LEDS_PER_ARC } from '../src/preview3d/geometry'

describe('rotor and controller clocks', () => {
  it('rotates 54 degrees during one 40 FPS frame at 360 RPM', () => {
    expect(degreesPerControllerFrame(360, 40)).toBe(54)
  })

  it('keeps the LED frame unchanged inside each 25 ms interval', () => {
    expect(controllerFrameAtTime(0.024999, 40)).toBe(0)
    expect(controllerFrameAtTime(0.025, 40)).toBe(1)
  })

  it('returns to the same nominal phase after 20 controller frames', () => {
    const angleAtStart = normalizedAngle(angleAtTime(0, 360))
    const angleAtTwentyFrames = normalizedAngle(angleAtTime(20 / 40, 360))
    expect(angleAtTwentyFrames).toBeCloseTo(angleAtStart, 10)
  })
})

describe('open-loop top-third sampling', () => {
  it('keeps one Art-Net LED choice while the rotor leaves the top 120-degree sector', () => {
    const localLed = [-1, 0, 0] as const
    const initialPhase = 320 * Math.PI / 180
    const frame = controllerFrameAtTime(0.024, 40)
    const heldAngle = angleAtTime(controllerFrameStartTime(frame, 40), 360, initialPhase)
    const actualAngle = angleAtTime(0.024, 360, initialPhase)
    const heightAt = (angle: number) => unitRelativeHeightAtPhase(
      localLed, Math.cos(angle), Math.sin(angle), 0, 1, 1,
    )

    expect(frame).toBe(0)
    expect(heightAt(heldAngle)).toBeGreaterThan(0.5)
    expect(heightAt(actualAngle)).toBeLessThan(0.5)
    expect(controllerFrameStartTime(controllerFrameAtTime(0.025, 40), 40))
      .toBe(0.025)
  })

  it('assigns different unknown startup phases per unit and reset', () => {
    const first = simulatedUnknownPhase(0, 0)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(first).toBeLessThan(Math.PI * 2)
    expect(simulatedUnknownPhase(0, 0)).toBe(first)
    expect(simulatedUnknownPhase(1, 0)).not.toBe(first)
    expect(simulatedUnknownPhase(0, 1)).not.toBe(first)
  })
})
describe('3D semicircle effect mapping', () => {
  it('defaults to the LongN 152 LEDs x 5 units until the backend says otherwise', () => {
    expect(DEFAULT_SETTINGS.ledCount).toBe(LEDS_PER_ARC)
    expect(LEDS_PER_ARC).toBe(152)
    expect(DEFAULT_SETTINGS.unitCount).toBe(5)
    expect(DEFAULT_SETTINGS.motorRpm).toEqual({ mid: 130, max: 500 })
  })
})

describe('diameter strip geometry', () => {
  it('places one LED strip across both sides of the rotor center', () => {
    expect(stripCoordinate(0, 5, 3)).toBe(-3)
    expect(stripCoordinate(2, 5, 3)).toBe(0)
    expect(stripCoordinate(4, 5, 3)).toBe(3)
  })

  it('keeps an even LED count symmetric around the center', () => {
    expect(stripCoordinate(0, 48, 3.35)).toBeCloseTo(-3.35)
    expect(stripCoordinate(47, 48, 3.35)).toBeCloseTo(3.35)
    expect(stripCoordinate(23, 48, 3.35)).toBeCloseTo(
      -stripCoordinate(24, 48, 3.35),
    )
  })
})

describe('LongN multi-unit layout', () => {
  const units = buildUnitLayouts('all', 5, 40, 2)
  const apex = (index: number) => [Math.sin(units[index].yawRadians), Math.cos(units[index].yawRadians)]

  it('ports calcMotorPosition for five units', () => {
    // LongN/Simulation.pde: X = map(i, 0, 4, -595, 595), Y = -500 sin((i+1)π/6) + 500/3,
    // Z = map(cos((i+1)π/6 + π), -1, 1, 200, 700) - 160, Angle = i·(3π/2)/4 + π/2.
    expect(longnUnitPlacement(0, 5).x).toBeCloseTo(-595)
    expect(longnUnitPlacement(2, 5).x).toBeCloseTo(0)
    expect(longnUnitPlacement(2, 5).y).toBeCloseTo(-500 + 500 / 3)
    expect(longnUnitPlacement(0, 5).z).toBeCloseTo(450 - 250 * Math.cos(Math.PI / 6) - 160)
    expect(longnUnitPlacement(4, 5).angle).toBeCloseTo(2 * Math.PI)
    expect(longnUnitPlacement(0, 1)).toMatchObject({ x: 0, angle: Math.PI / 2 })
  })

  it('maps Processing (X, Y toward viewer, Z up) onto three.js and keeps LongN proportions', () => {
    expect(units).toHaveLength(5)
    const scale = (ARC_RADIUS * ALL_UNIT_SCALE) / 35
    units.forEach((unit, index) => {
      const placement = longnUnitPlacement(index, 5)
      expect(unit.index).toBe(index)
      expect(unit.x).toBeCloseTo(placement.x * scale)
      expect(unit.y).toBeCloseTo((placement.z - longnUnitPlacement(0, 5).z) * scale)
      expect(unit.z).toBeCloseTo(units[4 - index].z)
      expect(unit.scale).toBe(ALL_UNIT_SCALE)
      expect(unit.tiltXRadians).toBeCloseTo(Math.PI / 2)
      expect(unit.phaseOffsetRadians).toBeCloseTo(index * 40 * Math.PI / 180)
      expect(unit.frameOffset).toBe(index * 2)
    })
    expect(units[0].y).toBeCloseTo(0)
    expect(units.map((unit) => unit.y)).toEqual([...units.map((unit) => unit.y)].sort((a, b) => a - b))
    expect(units[2].z).toBeLessThan(units[0].z)  // the middle unit stands farthest back
    expect(units.reduce((sum, unit) => sum + unit.z, 0)).toBeCloseTo(0)
  })

  it('points each apex like a moon phase: left, back-left, back-right, front-right, front', () => {
    const expected = [[-1, 0], [-0.383, -0.924], [0.707, -0.707], [0.924, 0.383], [0, 1]]
    expected.forEach(([x, z], index) => {
      expect(apex(index)[0]).toBeCloseTo(x, 2)
      expect(apex(index)[1]).toBeCloseTo(z, 2)
    })
  })

  it('follows the configured unit count', () => {
    expect(buildUnitLayouts('all', 3, 0, 0)).toHaveLength(3)
    expect(buildUnitLayouts('all', 1, 0, 0)[0]).toMatchObject({ x: 0, y: 0, z: 0 })
  })

  it('keeps single-unit mode unshifted and full scale', () => {
    expect(buildUnitLayouts('single', 5, 40, 2)).toEqual([{
      index: 0,
      x: 0,
      y: 0,
      z: 0,
      scale: 1,
      phaseOffsetRadians: 0,
      tiltXRadians: Math.PI / 2,
      yawRadians: 0,
      frameOffset: 0,
    }])
  })
})

describe('per-unit motors', () => {
  const stopped: UnitMotor = { speed: 'stop', direction: 'cw' }

  it('signs the rpm by direction and stops at zero', () => {
    expect(signedRpm({ speed: 'max', direction: 'cw' }, DEFAULT_MOTOR_RPM)).toBe(500)
    expect(signedRpm({ speed: 'mid', direction: 'ccw' }, DEFAULT_MOTOR_RPM)).toBe(-130)
    expect(signedRpm({ speed: 'stop', direction: 'ccw' }, DEFAULT_MOTOR_RPM)).toBe(0)
  })

  it('keeps the rotor angle continuous across speed changes', () => {
    let rotor = { time: 0, angle: 1, rpm: 0 }
    rotor = retimeRotor(rotor, 2, 60)  // stopped for 2 s, then 1 turn per second
    expect(rotorAngle(rotor, 2)).toBeCloseTo(1)
    expect(rotorAngle(rotor, 2.25)).toBeCloseTo(1 + Math.PI / 2)
    const same = retimeRotor(rotor, 3, 60)
    expect(same).toBe(rotor)
    rotor = retimeRotor(rotor, 2.5, -120)  // reverse at 2 turns per second
    expect(rotorAngle(rotor, 2.5)).toBeCloseTo(1 + Math.PI)
    expect(rotorAngle(rotor, 2.75)).toBeCloseTo(1)
  })

  it('applies commands like the backend: all units by default, omitted fields kept', () => {
    const motors = [stopped, stopped, stopped]
    const all = applyMotorCommand(motors, { speed: 'max' })
    expect(all.map((motor) => motor.speed)).toEqual(['max', 'max', 'max'])
    const one = applyMotorCommand(all, { unitIds: [2], direction: 'ccw' })
    expect(one).toEqual([
      { speed: 'max', direction: 'cw' }, { speed: 'max', direction: 'ccw' }, { speed: 'max', direction: 'cw' },
    ])
  })
})

describe('temporal exposure samples', () => {
  it('normalizes exposure and persistence weights', () => {
    const samples = buildTemporalSamples(1, 25, 45, 64)
    const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0)
    expect(samples).toHaveLength(64)
    expect(totalWeight).toBeCloseTo(1, 10)
    expect(samples[0].timeSeconds).toBe(1)
    expect(samples.at(-1)!.timeSeconds).toBeLessThan(0.8)
  })

  it('uses one current-time sample when blur is disabled', () => {
    expect(buildTemporalSamples(2, 0, 0, 64)).toEqual([
      { timeSeconds: 2, weight: 1 },
    ])
  })
})
