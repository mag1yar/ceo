import { describe, expect, it } from "vitest"
import { toRgb } from "./color"

const channels = (rgb: string) => rgb.match(/[\d.]+/g)?.map(Number)

describe("toRgb", () => {
  it("converts oklch to sRGB within one step per channel", () => {
    const cases: [string, number[]][] = [
      ["oklch(1 0 0)", [255, 255, 255]],
      ["oklch(0 0 0)", [0, 0, 0]],
      ["oklch(0.62796 0.25768 29.2339)", [255, 0, 0]],
      ["oklch(0.86644 0.29483 142.4953)", [0, 255, 0]],
      ["oklch(0.45201 0.31321 264.052)", [0, 0, 255]],
      ["oklch(62.796% 0.25768 29.2339deg)", [255, 0, 0]],
    ]
    for (const [css, want] of cases) {
      const got = channels(toRgb(css)) ?? []
      expect(got).toHaveLength(3)
      got.forEach((v, i) => {
        expect(Math.abs(v - want[i]), css).toBeLessThanOrEqual(1)
      })
    }
  })

  it("keeps alpha as rgba", () => {
    expect(toRgb("oklch(0 0 0 / 9%)")).toBe("rgba(0, 0, 0, 0.09)")
    expect(toRgb(" oklch(1 0 0 / 0.5) ")).toBe("rgba(255, 255, 255, 0.5)")
  })

  it("passes other colours through", () => {
    expect(toRgb(" #112233 ")).toBe("#112233")
    expect(toRgb("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)")
  })
})
