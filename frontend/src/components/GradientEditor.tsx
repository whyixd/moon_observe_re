import { hexToRgb, rgbToHex, type RgbColor } from '../effects'

type ColorInputProps = {
  label: string
  color: RgbColor
  onChange: (color: RgbColor) => void
}

export function ColorInput({ label, color, onChange }: ColorInputProps) {
  return (
    <label className="color-input">
      <span>{label}</span>
      <input
        type="color"
        value={rgbToHex(color)}
        onChange={(event) => onChange(hexToRgb(event.target.value))}
      />
      <output>{rgbToHex(color).toUpperCase()}</output>
    </label>
  )
}

type GradientEditorProps = {
  colors: RgbColor[]
  onChange: (colors: RgbColor[]) => void
}

// 2–8 個色點的漸層編輯器，effect 顏色與天氣色盤共用。
// Gradient editor (2–8 stops) shared by effect colors and the weather palette.
export function GradientEditor({ colors, onChange }: GradientEditorProps) {
  return (
    <>
      <div
        className="gradient-preview"
        aria-hidden="true"
        style={{ background: `linear-gradient(to right, ${colors.map(rgbToHex).join(', ')})` }}
      />
      <div className="gradient-stops">
        {colors.map((color, index) => (
          <div className="gradient-stop" key={index}>
            <ColorInput
              label={`色點 ${index + 1}`}
              color={color}
              onChange={(nextColor) => onChange(colors.map((current, currentIndex) => (
                currentIndex === index ? nextColor : current
              )))}
            />
            {colors.length > 2 && (
              <button
                type="button"
                className="secondary remove-stop"
                aria-label={`移除色點 ${index + 1}`}
                onClick={() => onChange(colors.filter((_, currentIndex) => currentIndex !== index))}
              >移除</button>
            )}
          </div>
        ))}
      </div>
      {colors.length < 8 && (
        <button
          type="button"
          className="secondary add-stop"
          onClick={() => onChange([...colors, { ...colors.at(-1)! }])}
        >新增色點</button>
      )}
    </>
  )
}
