type Point = [number, number]

const SAMPLES = 48

// The cubic of a React Flow path: getBezierPath gives "M C", getStraightPath "M L" (a line as an even cubic).
function cubic(d: string): Point[] {
  const n = d.match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? []
  if (n.length < 8) {
    const [ax, ay, bx, by] = n
    const lerp = (t: number): Point => [ax + (bx - ax) * t, ay + (by - ay) * t]
    return [lerp(0), lerp(1 / 3), lerp(2 / 3), lerp(1)]
  }
  return [0, 2, 4, 6].map((i) => [n[i], n[i + 1]])
}

function bezier([a, b, c, e]: Point[], t: number): Point {
  const u = 1 - t
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return [
    w[0] * a[0] + w[1] * b[0] + w[2] * c[0] + w[3] * e[0],
    w[0] * a[1] + w[1] * b[1] + w[2] * c[1] + w[3] * e[1],
  ]
}

// `steps + 1` points evenly spaced by length from the path start to `gap` short of its end, where a signal waits.
export function track(d: string, gap: number, steps = 24) {
  const c = cubic(d)
  const pts = Array.from({ length: SAMPLES + 1 }, (_, i) =>
    bezier(c, i / SAMPLES)
  )
  const acc = [0]
  for (let i = 1; i <= SAMPLES; i++)
    acc.push(
      acc[i - 1] +
        Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
    )
  const length = Math.max(0, acc[SAMPLES] - gap)
  const along = (s: number): Point => {
    let i = 1
    while (i < SAMPLES && acc[i] < s) i++
    const span = acc[i] - acc[i - 1]
    const t = span ? (s - acc[i - 1]) / span : 0
    const [a, b] = [pts[i - 1], pts[i]]
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  }
  const points = Array.from({ length: steps + 1 }, (_, i) =>
    along((length * i) / steps)
  )
  return { points, stop: points[steps], end: pts[SAMPLES], length }
}
