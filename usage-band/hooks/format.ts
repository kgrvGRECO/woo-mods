// 막대·색·남은 시간 표시와 띠의 행 모양. 시간대 데이터에 기대지 않도록 "몇 시간 후"로 쓴다.

/** 막대 한 칸(눈금 하나): 사용량 표시에 쓰는 한 창 */
export type Meter = {
  label: string
  /** 사용한 비율, 0–100. 없으면 이 창은 "—"로 그린다 */
  pct?: number
  resetsAtMs?: number
}

/** 띠의 한 줄: Claude 또는 Codex */
export type BandRow = {
  name: string
  /** 이름 색(#rrggbb) */
  color: string
  /** 열마다 한 칸. undefined는 빈칸(다른 줄만 그 열이 있을 때) */
  meters: (Meter | undefined)[]
  /** 줄 끝: 컨텍스트 같은 값 하나와 흐린 메모 */
  tail?: { label: string; pct: number }
  note?: string
}

export const BAR_WIDTH = 10

/** 50% 미만 초록, 80% 미만 주황, 그 이상 빨강. 밝은·어두운 테마 모두에서 읽히는 중간 밝기 */
export const hexFor = (pct: number): string => (pct < 50 ? '#2f9e44' : pct < 80 ? '#e8890c' : '#e5484d')

/** 터미널 테마 키 */
export const colorFor = (pct: number): string => (pct < 50 ? 'success' : pct < 80 ? 'warning' : 'error')

export const pctText = (pct: number): string => `${Math.round(pct)}%`

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']

/** 1/8칸까지 나누는 막대: [채운 부분, 빈 부분] */
export function barParts(pct: number, width = BAR_WIDTH): [string, string] {
  const eighths = Math.round((Math.max(0, Math.min(100, pct)) / 100) * width * 8)
  const full = Math.floor(eighths / 8)
  const part = EIGHTHS[eighths % 8] ?? ''
  const filled = '█'.repeat(full) + part
  return [filled, '░'.repeat(width - full - (part ? 1 : 0))]
}

/** 예전 모양(채움+빈칸을 한 문자열로) */
export const bar = (pct: number, width = BAR_WIDTH): string => barParts(pct, width).join('')

/** 남은 시간: "3일 4시간", "2시간 13분", "45분", "곧" */
export function untilText(ms: number): string {
  if (ms <= 60_000) return '곧'
  const totalMin = Math.floor(ms / 60_000)
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return h > 0 ? `${d}일 ${h}시간` : `${d}일`
  if (h > 0) return m > 0 ? `${h}시간 ${m}분` : `${h}시간`
  return `${m}분`
}

/** 지난 시간: "방금", "3분 전", "2시간 전", "1일 전" */
export function agoText(ms: number): string {
  if (ms < 60_000) return '방금'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}시간 전`
  return `${Math.floor(h / 24)}일 전`
}

/** 한도가 다시 차는 때까지: "1일 13시간 후" */
export const resetText = (m: Meter, now: number): string =>
  m.pct !== undefined && m.resetsAtMs !== undefined && m.resetsAtMs > now ? `${untilText(m.resetsAtMs - now)} 후` : ''

/** 터미널에서 차지하는 칸 수(한글·전각은 2칸) */
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) ? 2 : 1
  }
  return w
}

export const padCells = (s: string, width: number): string => s + ' '.repeat(Math.max(0, width - cellWidth(s)))
export const padCellsStart = (s: string, width: number): string => ' '.repeat(Math.max(0, width - cellWidth(s))) + s

/** 열마다 가장 긴 이름표·리셋 글자 너비(칸) */
export function columnsOf(rows: BandRow[], now: number, measure: (s: string) => number) {
  const n = Math.max(0, ...rows.map(r => r.meters.length))
  return Array.from({ length: n }, (_, c) => {
    const ms = rows.map(r => r.meters[c]).filter((m): m is Meter => m !== undefined)
    return {
      label: Math.max(0, ...ms.map(m => measure(m.label))),
      reset: Math.max(0, ...ms.map(m => measure(resetText(m, now)))),
    }
  })
}
