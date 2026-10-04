// Codex 사용량 읽기: Codex CLI·앱이 남기는 세션 기록(rollout-*.jsonl)의
// token_count 이벤트에 들어 있는 rate_limits 스냅숏을 찾아 해석한다.
//
//   ~/.codex/sessions/YYYY/MM/DD/rollout-....jsonl
//   {"timestamp":"…","type":"event_msg","payload":{"type":"token_count",
//     "info":{…},"rate_limits":{"primary":{"used_percent":12.0,
//     "window_minutes":300,"resets_at":1790713159},"secondary":{…}}}}
//
// 버전마다 모양이 조금씩 달라서(resets_in_seconds ↔ resets_at, primary가
// 주간인 경우, rate_limits가 null인 줄) 모두 너그럽게 받아들인다.

export type Window = {
  /** 사용한 비율, 0–100 */
  pct: number
  /** 창 길이(분). 300 ≈ 5시간, 10080 = 7일 */
  windowMin?: number
  /** 리셋 시각(ms, epoch). 모르면 없음 */
  resetsAtMs?: number
}

export type CodexSnapshot = {
  /** 이 스냅숏이 기록된 시각(ms) */
  at: number
  short?: Window
  week?: Window
  plan?: string
}

type RawWindow = {
  used_percent?: unknown
  window_minutes?: unknown
  resets_at?: unknown
  resets_in_seconds?: unknown
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined

function toWindow(raw: unknown, lineAt: number): Window | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as RawWindow
  const pct = num(r.used_percent)
  if (pct === undefined) return undefined
  const windowMin = num(r.window_minutes)
  let resetsAtMs: number | undefined
  const at = num(r.resets_at)
  if (at !== undefined && at > 0) {
    resetsAtMs = at < 1e12 ? at * 1000 : at
  } else if (typeof r.resets_at === 'string' && r.resets_at && !Number.isFinite(Number(r.resets_at))) {
    const t = Date.parse(r.resets_at)
    if (Number.isFinite(t)) resetsAtMs = t
  } else {
    const inSec = num(r.resets_in_seconds)
    if (inSec !== undefined && lineAt > 0) resetsAtMs = lineAt + inSec * 1000
  }
  return { pct, windowMin, resetsAtMs }
}

/** 한 줄(JSON)에서 스냅숏을 꺼낸다. rate_limits가 없거나 비었으면 undefined */
export function parseLine(line: string): CodexSnapshot | undefined {
  if (!line.includes('rate_limits')) return undefined
  let o: Record<string, unknown>
  try {
    o = JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
  const payload = (o.payload ?? o.msg ?? {}) as Record<string, unknown>
  const rl = (payload.rate_limits ?? o.rate_limits) as Record<string, unknown> | null | undefined
  if (!rl || typeof rl !== 'object') return undefined
  const ts = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  const lineAt = Number.isFinite(ts) ? ts : 0
  const wins = [toWindow(rl.primary, lineAt), toWindow(rl.secondary, lineAt)]
  if (!wins[0] && !wins[1]) return undefined

  const snap: CodexSnapshot = { at: lineAt }
  wins.forEach((w, i) => {
    if (!w) return
    // 창 길이로 분류한다(primary가 주간인 버전이 있음). 길이를 모르면 primary=5시간
    const isShort = w.windowMin !== undefined ? w.windowMin <= 1440 : i === 0
    if (isShort) snap.short ??= w
    else snap.week ??= w
  })
  const plan = rl.plan_type
  if (typeof plan === 'string') snap.plan = plan
  return snap
}

/** 파일 내용에서 가장 마지막(최신) 스냅숏 */
export function lastSnapshot(text: string): CodexSnapshot | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseLine(lines[i] ?? '')
    if (s) return s
  }
  return undefined
}

/** 리셋 시각이 지났으면 그 창은 0%로 본다 */
export function effectivePct(w: Window | undefined, now: number): number | undefined {
  if (!w) return undefined
  if (w.resetsAtMs !== undefined && now >= w.resetsAtMs) return 0
  return w.pct
}
