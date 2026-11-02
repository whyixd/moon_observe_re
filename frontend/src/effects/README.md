# Effect contract

Effects are pure controller-frame renderers. They do not import React、Three.js or browser timing APIs.

The synchronization payload is JSON-compatible:

```json
{
  "schemaVersion": 2,
  "effectId": "center-out-sine",
  "parameters": {
    "speedHz": 0.35
  },
  "color": { "mode": "gradient", "axis": "radius", "colors": [
    { "r": 0.2, "g": 0.92, "b": 1 },
    { "r": 0.66, "g": 0.28, "b": 1 }
  ] }
}
```

Frontend and future backend implementations must use the same inputs:

- `controllerFrame`：40 FPS logical frame index
- `controllerFps`：controller update rate, normally 40
- `ledIndex` / `ledCount`：index over one semicircle (156 LEDs in the current 3D scene)
- `normalizedStripPosition`：0 at one foot of the semicircle and 1 at the other
- `normalizedRadius`：0 at the semicircle apex and 1 at either foot
- `unitIndex` / `unitCount`：目前 unit 的 zero-based index 與場景 unit 總數
- `globalControllerFrame`：未套用 per-unit offset 的共同 frame，供跨 unit choreography 使用
- `unitRelativeY`：燈點相對 unit 中心的 Y 高度，供空間效果使用
- `unitPhaseProjection`：該半圓的估計旋轉相位在垂直方向的投影（-1 到 1）；用於縮短點亮時間，不縮短亮燈長度

Each preset includes a solid color or a gradient with 2–8 evenly spaced colors. `strip` samples from one foot of the semicircle to the other; `radius` samples from apex to feet. `spectrum-cycle` cycles through its gradient over 20 controller frames; in solid mode it cycles brightness over the same period. The preset schema is version 2; version 1 payloads need conversion before synchronization. Each effect returns normalized RGB channels in the 0–1 range. The frontend converts this to Three.js color; the backend can quantize it to RGB/RGBW payload bytes. Effect time is derived from `controllerFrame / controllerFps`, never browser render time, so LED state remains sample-and-hold and can be reproduced by the Raspberry Pi renderer.

`sequential-center-fill` (逐月) uses `globalControllerFrame` to illuminate Unit 1 through Unit 9 in order. The active unit fills from the center toward both outer edges; completed units stay fully lit while the next unit fills. After Unit 9 finishes, all units remain lit.

`periodic-leds` (落雨) lights exactly `litCount` individual LEDs on each semicircle, starting at index 0. Each pair of lit LEDs has `darkGap` unlit LEDs between them. The whole pattern shifts along the semicircle and returns to its starting positions every `periodSeconds`; timing comes from controller frames. The UI limits `litCount` and `darkGap` so the requested LEDs fit within the 156 LED arc.

`random-leds` (隨機亮點) selects exactly `litCount` unique LED indices per semicircle at the start of each `holdFrames` group. A seeded shuffle uses `floor(controllerFrame / holdFrames)` and unit index, so the selection is reproducible across renderers. Both arcs of a unit share the same indices. `durationMode: 0` keeps every selected LED lit for the whole group (the original behavior). `durationMode: 1` turns each LED off after `ceil(holdFrames / (1 + (holdFrames / minHoldFrames - 1) * normalizedRadius))` frames; radius is 0 at the semicircle apex and 1 at either foot. This approximates equal visual streak length while respecting the Art-Net minimum of one whole controller frame. `minHoldFrames` cannot exceed `holdFrames`. If `holdFrames` is one frame, both modes produce the same duration. The actual minimum in milliseconds is `1000 * minHoldFrames / controllerFps`; it changes with the configured FPS.

`world-upper-half` (空間上方 1/3 圓) lights all 78 LEDs from the outer edge to the center on the upper side of a 156-LED arc, only while that side rotates through the top 120° (`abs(unitPhaseProjection) > 0.5`). The inner 20% of the radius fades smoothly toward the center; the LED span and timing do not change. The ID stays unchanged so existing presets remain valid. The simulator estimates phase from nominal RPM at each Art-Net frame boundary and holds the chosen LED pattern until the next frame; the rotor continues rotating in between. Each unit has an unknown startup phase simulated by a reproducible offset. Resetting time selects another offset. At 40 FPS and 360 RPM the rotor turns 54° during each 25 ms hold, so the actual lit duration is quantized to whole frames. This models one possible no-feedback result, assuming nominal motor speed without drift or network jitter.

`moving-rings` projects each continuous ring center onto the two adjacent radial LED coordinates. Their brightness weights sum to one LED of white energy on each side of the semicircle apex, preserving white chromaticity and total intensity while avoiding discrete position jumps. At an exact LED coordinate only one LED is full white `(1, 1, 1)`; between coordinates two LEDs share equal-channel RGB brightness. Camera exposure and persistence may still make the simulated captured trail appear wider.

For `ringCount = N`, normalized radius is partitioned into `N` non-overlapping lanes. Adjacent rings use opposite sine directions and every shared lane boundary reserves a collision gap of up to two radial LED steps. The innermost lane begins at radius `0` and the outermost lane ends at `1`, so those rings still reach the apex and feet at their respective motion extremes. Even LED counts have no pixel exactly at radius `0`, so the apex is represented by the nearest symmetric LED pair.

`full-on` (全亮) keeps every LED at full brightness with the preset color (solid, or the gradient along its axis); it has no parameters and no cycle, so sequences play it by time.

`random-fill` (隨機填滿) starts dark and lights one LED at a time in a seeded random order (`floor(controllerFrame / cycle)` and unit index, shared by both arcs of a unit). LED `rank` lights at `floor(fill * ((rank + 1) / ledCount) ^ (1 / acceleration))` frames, so the lit count follows `ledCount * (t / fill) ^ acceleration`: slow at first, then faster; `acceleration = 1` is a constant rate. After the fill it holds full brightness and fades out; one cycle is `fill + ledFade + hold + fadeOut` whole frames. Whatever the gradient axis, each unit takes one solid palette color at `((unitIndex * stride) % unitCount) / (unitCount - 1)`, where `stride` is the largest number ≤ `unitCount / 2` coprime with `unitCount` (4 for nine units), so neighbouring units are about half the palette apart.

The additional phase-free effects use only LED position, controller frame, and (for stardust) unit index. `reverse-tide` draws an inward radial front that fades before restarting. `wide-rings` moves broad radial bands. `comet-tail` moves a head and fading tail along strip order. `stardust-cloud` places deterministic clusters that widen and fade. `color-breathing` pulses brightness while its gradient cycles continuously, so sequence playback uses time rather than a brightness-cycle count. `sector-smear` repeats eight radial lengths; `twenty-beat` repeats five radial profiles in twenty frames. The latter two create drifting smear and do not imply a known physical start angle.

`unit-chase` (逐台巡行) lights one whole unit at a time from unit 1 to unit N, goes dark for `gapSeconds`, then lights pairs `(k, N-1-k)` from both ends inward, holds the centre unit (or centre pair) for `holdSeconds` and stays dark for `endDarkSeconds`. Every stage is whole frames; one cycle is `(N + ceil(N / 2)) * step + gap + hold + endDark`. With `fadeSeconds > 0` each step fades in from its start and out from its end, crossing the neighbouring step.

`unit-random` (隨機單台) lights one whole unit per turn: fade in, hold, fade out, then a dark gap. Each round of N turns visits every unit once in a seeded random order (`randomRanks(round, 1009, unitCount)`); when a round would start with the unit that ended the previous round, its first two turns swap so no unit lights twice in a row. One cycle is one round.

`roulette-ring` (輪盤收束) lights one whole unit at a time like a roulette ball: from unit 1 it bounces end to end `sweeps` times, then runs to the centre unit `floor((N - 1) / 2)` and stops. Step times grow geometrically from `startStepFrames` (whole frames, at least 1) to `endStepSeconds`; each step is rounded to whole frames and never shorter than the one before. After `holdSeconds` the centre unit darkens from the strip centre outward over `dimSeconds` (each LED goes out within one LED of the moving front), leaving only the outermost LED at each strip end; then every unit's outermost LEDs light from the centre unit outward, one unit distance per `spreadStepSeconds`, hold for `ringHoldSeconds`, then each unit's rim glitches and switches off: every unit starts at a random frame within `glitchSpreadSeconds` (overlaps allowed), flickers on/off for `glitchSeconds` in cells of `flickerFrames` with an on-chance falling from 0.85 to 0.1, then stays off; starts and flicker come from `hash01(round, unit, salt)`, a 32-bit integer hash, so they change every round. It then stays dark for `endDarkSeconds`.

All three share one schedule across units: they set `ignoresWeatherTiming`, so the renderer skips weather cloud offsets and unit frame offsets for them (they have no rain lines either), and per-unit parameter variation is disabled.

## Rain lines

While the weather category is `rain`, `sampleEffect(preset, context, elapsedFrame, true)` uses an effect's optional `rain(context, parameters, base)` brightness instead of the dry one; effects without it are unchanged. The shared building blocks live in `rain.ts` (`RAIN_LINES` matches the backend):

- `rainStripe`: one LED in every `stripeSpacing` (6), counted inward from the rim and mirrored, so it spins into concentric thin rings. Used by `sequential-center-fill`, `reverse-tide` and `color-breathing` on top of their dry brightness.
- `rainRing(radialDistance)`: full within half an LED of the ring and fading over the next one, so the total stays two LEDs of energy and the ring moves smoothly. `center-out-sine` and `sine-swell` keep only their crests; `wide-rings` keeps the inner and outer edge of each band.
- `rainStreak(density)`: each LED lights for one `streakFrames` (2) cell when `hash01(cell, unitIndex, ledIndex + 101) < density`, drawing short arcs. `full-on` uses `sparseDensity` (0.18), `random-fill` uses it only on LEDs its fill has lit, `stardust-cloud` uses `denseDensity` (0.45) times the cloud brightness, and `comet-tail` keeps a thin head ring with tail streaks thinning from `denseDensity` to none.

