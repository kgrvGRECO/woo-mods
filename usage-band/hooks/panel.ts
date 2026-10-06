// 데스크톱 앱용 사용량 패널: 회색 띠 안에 지표마다 타일을 놓은 SVG 한 장(도트 타일).
//
//   Claude    ┌[5시간]   3시간 5분 후┐ ┌[주간]  1일 13시간 후┐ ┌[Fable] 1일 13시간 후┐
//   ctx 19%   └3% ■□□┆□□□  -35 여유┘ └77% ■■■■■┆□  적당 ┘ └100% ■■■■■┆■ +22 빠름┘
//   Codex     ┌[주간]   4일 6시간 후┐
//   39분 전   └40% ■■□┆□□□□□  적당 ┘
//
// 클로 펫 카드처럼 도트 느낌으로 그린다: Neo둥근모 글꼴, 계단 모서리, 2px 테두리와 그림자, 칸 나뉜 막대.
// 색으로 세 가지를 나눈다.
//   · 누구 한도인지: 타일 바탕·테두리(Claude 살구색, Codex 코발트색)
//   · 어느 창인지: 이름표(5시간 주황, 주간 갈색, 모델별 주간 보라, Codex 파랑)
//   · 얼마나 썼는지: 퍼센트·막대(낮음 초록, 중간 주황, 높음 빨강). 높음이면 타일 테두리도 빨강
// 막대의 I자 눈금은 "지금까지 흐른 시간"이고(5시간 창은 5시간, 주간·모델별 주간은 7일 기준), 쓴 양이 그보다
// 5 넘게 앞서면 "빠름", 5 넘게 뒤지면 "여유"다. 글자 크기는 두 가지(작은 글자, 큰 숫자·이름)만 쓴다.
// 데스크톱 앱의 회색 띠는 화면 배율 200%에서 안쪽이 약 745px이라 그 너비에 맞춘다.

import { pctText, untilText, type BandRow, type Meter } from './format'
import { NEODGM_WOFF2 } from './neodgm-font'

const FONT = `'NeoDunggeunmo','Malgun Gothic','Apple SD Gothic Neo',monospace`
const SMALL = 12 // 이름표·남은 시간·페이스·이름 밑 글자
const BIG = 16 // 퍼센트·이름(도트 글꼴의 원래 크기라 또렷하다)
const TILE_H = 42
const TILE_GAP = 6
const ROW_GAP = 5
const PX = 2 // 도트 한 칸
const BAR_H = 6
const SEG_W = 5 // 막대 한 칸
const SEG_GAP = 2
const PAD = 9
const COLS = 3
export const WIDTH = 740

/** 누구 한도인지: 타일 클래스(바탕·테두리·그림자 색은 CSS에서 테마별로) */
const PROVIDER: Record<string, { cls: string; color: string }> = {
  Claude: { cls: 'c', color: '#d97757' },
  Codex: { cls: 'x', color: '#3b6fe0' },
}
/** 어느 창인지: 이름표 색 */
function badgeColor(provider: string, label: string): string {
  if (provider === 'Codex') return label === '5시간' ? '#4f86f7' : '#2a4fbf'
  if (label === '5시간') return '#e2772e'
  if (label === '주간') return '#a8502c'
  return '#7c4dff' // 모델별 주간(Fable 등)
}
/** 얼마나 썼는지: 낮음 · 중간 · 높음 */
const levelColor = (pct: number) => (pct < 50 ? '#1f9d55' : pct < 80 ? '#e8890c' : '#e5484d')

const HOUR = 3_600_000
const windowOf = (m: Meter) => (m.label === '5시간' ? 5 * HOUR : 7 * 24 * HOUR)

/** 글자 너비(px): Neo둥근모는 한글·기호 1em, 영문·숫자·공백 0.5em */
export function textWidth(s: string, size = SMALL): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) < 0x80 ? 0.5 : 1
  return Math.ceil(w * size)
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 계단 모서리 사각형: 네 모서리를 도트 steps칸씩 깎는다 */
function pixelRect(x: number, y: number, w: number, h: number, steps: number): string {
  const s = steps
  const p: string[] = [`M${x + s * PX},${y}H${x + w - s * PX}`]
  for (let i = 1; i <= s; i++) p.push(`V${y + i * PX}H${x + w - (s - i) * PX}`)
  p.push(`V${y + h - s * PX}`)
  for (let i = 1; i <= s; i++) p.push(`H${x + w - i * PX}V${y + h - (s - i) * PX}`)
  p.push(`H${x + s * PX}`)
  for (let i = 1; i <= s; i++) p.push(`V${y + h - i * PX}H${x + (s - i) * PX}`)
  p.push(`V${y + s * PX}`)
  for (let i = 1; i <= s; i++) p.push(`H${x + i * PX}V${y + (s - i) * PX}`)
  return p.join('') + 'Z'
}

/** 지금까지 흐른 시간(창 길이에 대한 %). 리셋 시각을 모르면 undefined */
export function elapsedPct(m: Meter, now: number): number | undefined {
  if (m.resetsAtMs === undefined || m.resetsAtMs <= now) return undefined
  return Math.max(0, Math.min(100, (1 - (m.resetsAtMs - now) / windowOf(m)) * 100))
}

/** 페이스: 쓴 양 - 흐른 시간. 5 넘게 앞서면 빠름, 5 넘게 뒤지면 여유 */
export function paceOf(m: Meter, now: number): { delta: number; text: string; color: string } | undefined {
  const e = elapsedPct(m, now)
  if (m.pct === undefined || e === undefined) return undefined
  const delta = Math.round(m.pct - e)
  if (delta > 5) return { delta, text: `+${delta} 빠름`, color: '#e5484d' }
  if (delta < -5) return { delta, text: `${delta} 여유`, color: '#1f9d55' }
  return { delta, text: '적당', color: '#a08a7a' }
}

export function panelSvg(rows: BandRow[], now: number, width = WIDTH): { svg: string; width: number; height: number } {
  // 이름 밑 작은 글자: 메모(옛 기록·못 받는 까닭)가 있으면 그것을, 없으면 컨텍스트. 메모는 뭔가 어긋났을 때만 생기므로
  // 그때는 컨텍스트보다 먼저 보여야 한다
  const noteOf = (r: BandRow) => (r.note ?? '').replace(/ 기록(?= ·|$)/, '')
  const subOf = (r: BandRow) => (r.note ? noteOf(r) : r.tail ? `ctx ${pctText(r.tail.pct)}` : '')
  const nameW = Math.max(...rows.map(r => Math.max(textWidth(r.name, BIG), textWidth(subOf(r))))) + 14
  const tileW = Math.floor((width - nameW - TILE_GAP * (COLS - 1)) / COLS)

  const parts: string[] = []
  let y = 0
  rows.forEach(r => {
    const text = (tx: number, ty: number, s: string, cls: string, extra = '') =>
      parts.push(`<text x="${tx}" y="${ty}"${cls ? ` class="${cls}"` : ''}${extra}>${esc(s)}</text>`)
    const prov = PROVIDER[r.name] ?? { cls: 'c', color: r.color }
    // 이름과 그 밑 작은 글자(메모가 있으면 메모, 아니면 컨텍스트)
    text(0, y + 13, r.name, 'b', ` fill="${prov.color}"`)
    if (r.note) {
      text(0, y + 30, noteOf(r), 'mut')
    } else if (r.tail) {
      text(0, y + 30, 'ctx', 'mut')
      text(textWidth('ctx '), y + 30, pctText(r.tail.pct), '', ` fill="${levelColor(r.tail.pct)}"`)
    }

    const meters = r.meters.filter((m): m is Meter => m !== undefined).slice(0, COLS)
    meters.forEach((m, i) => {
      const x = nameW + i * (tileW + TILE_GAP)
      const edge = m.pct !== undefined && m.pct >= 80 ? 'h' : prov.cls
      // 타일: 그림자 → 테두리 → 바탕(2px 안쪽) 순으로 겹쳐 도트 테두리를 만든다
      const w = tileW - PX
      const h = TILE_H - PX
      parts.push(`<path class="${edge}s" d="${pixelRect(x + PX, y + PX, w, h, 2)}"/>`)
      parts.push(`<path class="${edge}l" d="${pixelRect(x, y, w, h, 2)}"/>`)
      parts.push(`<path class="${prov.cls}f" d="${pixelRect(x + PX, y + PX, w - 2 * PX, h - 2 * PX, 1)}"/>`)
      const x0 = x + PAD
      const x1 = x + w - PAD
      // 윗줄: 어느 창인지 이름표 · 남은 시간
      const bw = textWidth(m.label) + 10
      parts.push(`<path d="${pixelRect(x0 - 2, y + 5, bw, 14, 1)}" fill="${badgeColor(r.name, m.label)}"/>`)
      text(x0 + 3, y + 12, m.label, 'w')
      if (m.pct !== undefined && m.resetsAtMs !== undefined && m.resetsAtMs > now) {
        text(x1, y + 12, `${untilText(m.resetsAtMs - now)} 후`, 'mut', ' text-anchor="end"')
      }
      // 아랫줄: 퍼센트 · 칸 막대(흐른 시간 눈금) · 페이스
      const ry = y + 30
      if (m.pct === undefined) {
        text(x0, ry, '—', 'mut b')
        return
      }
      const color = levelColor(m.pct)
      // 퍼센트는 윗줄 이름표와 같은 자리에서 시작하고, 막대가 남은 폭을 채운다
      const pct = pctText(m.pct)
      text(x0 - 2, ry, pct, 'b', ` fill="${color}"`)
      const pace = paceOf(m, now)
      const paceW = pace ? textWidth(pace.text) + 8 : 0
      const bx0 = x0 - 2 + textWidth(pct, BIG) + 6
      const avail = Math.max(20, x1 - paceW - bx0)
      const n = Math.max(4, Math.floor((avail + SEG_GAP) / (SEG_W + SEG_GAP)))
      const barW = n * (SEG_W + SEG_GAP) - SEG_GAP
      const lit = m.pct <= 0 ? 0 : Math.max(1, Math.round((Math.min(100, m.pct) / 100) * n))
      const by = ry - BAR_H / 2
      for (let k = 0; k < n; k++) {
        const sx = bx0 + k * (SEG_W + SEG_GAP)
        parts.push(
          k < lit
            ? `<rect x="${sx}" y="${by}" width="${SEG_W}" height="${BAR_H}" fill="${color}"/>`
            : `<rect class="trk" x="${sx}" y="${by}" width="${SEG_W}" height="${BAR_H}"/>`,
        )
      }
      const e = elapsedPct(m, now)
      if (e !== undefined) {
        // 흐른 시간: 위아래에 가로선이 있는 대문자 I 모양 눈금
        const tx = Math.round((bx0 + (e / 100) * barW) / PX) * PX - PX / 2
        parts.push(`<rect class="tick" x="${tx}" y="${by - 4}" width="${PX}" height="${BAR_H + 8}"/>`)
        parts.push(`<rect class="tick" x="${tx - PX}" y="${by - 4}" width="${PX * 3}" height="${PX}"/>`)
        parts.push(`<rect class="tick" x="${tx - PX}" y="${by + BAR_H + 2}" width="${PX * 3}" height="${PX}"/>`)
      }
      if (pace) text(x1, ry, pace.text, '', ` text-anchor="end" fill="${pace.color}"`)
    })
    y += TILE_H + ROW_GAP
  })
  const height = Math.max(TILE_H, y - ROW_GAP)
  const total = Math.ceil(nameW + COLS * tileW + TILE_GAP * (COLS - 1))

  const style =
    `@font-face{font-family:'NeoDunggeunmo';src:url(data:font/woff2;base64,${NEODGM_WOFF2}) format('woff2')}` +
    `svg{shape-rendering:crispEdges}` +
    `text{font-family:${FONT};font-size:${SMALL}px;dominant-baseline:central}` +
    `.b{font-size:${BIG}px}.w{fill:#ffffff}.mut{fill:#8a6a58}` +
    `.cf{fill:#fff6ef}.cl{fill:#d97757}.cs{fill:#ecc3ae}` +
    `.xf{fill:#eff4ff}.xl{fill:#3b6fe0}.xs{fill:#b9cbf5}` +
    `.hl{fill:#e5484d}.hs{fill:#f2b0b2}` +
    `.trk{fill:#8a6a58;fill-opacity:.2}.tick{fill:#4a3529}` +
    `@media (prefers-color-scheme:dark){.mut{fill:#cdb6a6}` +
    `.cf{fill:#3a2a23}.cs{fill:#1c1310}.xf{fill:#1f2740}.xl{fill:#6b93ff}.xs{fill:#0f1528}.hs{fill:#2a1213}` +
    `.trk{fill:#f2e6dc;fill-opacity:.22}.tick{fill:#fff2e6}}`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${height}" viewBox="0 0 ${total} ${height}"><style>${style}</style>${parts.join('')}</svg>`
  return { svg, width: total, height }
}
