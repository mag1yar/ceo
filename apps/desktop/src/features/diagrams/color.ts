const OKLCH =
  /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+)(%?))?\s*\)$/

const gamma = (x: number) =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055

// Mermaid reads only hex, rgb and hsl. shortcut: clamps out-of-gamut oklch instead of CSS gamut mapping, fine while tokens stay in sRGB.
export function toRgb(css: string): string {
  const m = OKLCH.exec(css.trim())
  if (!m) return css.trim()
  const l = Number(m[1]) / (m[2] ? 100 : 1)
  const c = Number(m[3])
  const h = (Number(m[4]) * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const [r, g, bl] = [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ].map((v) => Math.round(Math.min(1, Math.max(0, gamma(v))) * 255))
  if (m[5] === undefined) return `rgb(${r}, ${g}, ${bl})`
  const alpha = Number(m[5]) / (m[6] ? 100 : 1)
  return `rgba(${r}, ${g}, ${bl}, ${alpha})`
}
