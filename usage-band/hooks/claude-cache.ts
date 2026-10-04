// Claude 사용량 API 응답 해석: Claude Code의 /usage 가 받는 것과 같은 응답(api.anthropic.com/api/oauth/usage)을
// mod가 세션의 자격 증명 핸들($.session.authorize)로 직접 받거나, 그게 안 될 때는 상태줄 스크립트
// (awesome-statusline)가 같은 응답을 저장해 둔 파일(.claude_usage_cache)에서 읽는다. 토큰은 mod에 오지 않는다.
//
//   { "five_hour": { "utilization": 3.0, "resets_at": "…" }, "seven_day": { … },
//     "limits": [ { "kind": "weekly_scoped", "percent": 100, "resets_at": "…",
//                   "scope": { "model": { "display_name": "Fable" } } }, … ] }
//
// 엔진이 응답마다 주는 한도(five_hour, seven_day)에는 모델별 주간 한도가 없어서,
// Fable 같은 모델별 한도는 여기서만 얻는다.

export type CachedWindow = {
  /** 사용한 비율, 0–100 */
  pct: number
  /** 리셋 시각(ms, epoch). 모르면 없음 */
  resetsAtMs?: number
}

export type ClaudeCache = {
  /** 받은 시각(ms): API면 받은 때, 파일이면 파일이 마지막으로 바뀐 때 */
  at: number
  /** 어디서 왔는지: 사용량 API 직접(api) · 상태줄 캐시 파일(file). 없으면 옛 기록 */
  source?: 'api' | 'file'
  fiveHour?: CachedWindow
  sevenDay?: CachedWindow
  /** 모델별 주간 한도: 이름(예: Fable)과 창 */
  scoped: { name: string; window: CachedWindow }[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const time = (v: unknown): number | undefined => {
  if (typeof v !== 'string') return undefined
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : undefined
}

function windowOf(raw: unknown, key: 'utilization' | 'percent'): CachedWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const pct = num(r[key])
  return pct === undefined ? undefined : { pct, resetsAtMs: time(r.resets_at) }
}

/** 캐시 파일 내용 → 한도. 모양이 다르면 undefined */
export function parseClaudeCache(text: string, at: number): ClaudeCache | undefined {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!o || typeof o !== 'object') return undefined
  const cache: ClaudeCache = { at, fiveHour: windowOf(o.five_hour, 'utilization'), sevenDay: windowOf(o.seven_day, 'utilization'), scoped: [] }
  for (const l of Array.isArray(o.limits) ? o.limits : []) {
    if (!l || typeof l !== 'object') continue
    const limit = l as Record<string, unknown>
    if (limit.kind !== 'weekly_scoped') continue
    const scope = (limit.scope ?? {}) as Record<string, Record<string, unknown> | null>
    const name = scope.model?.display_name ?? scope.surface?.display_name
    const w = windowOf(limit, 'percent')
    if (typeof name === 'string' && name && w && !cache.scoped.some(s => s.name === name)) cache.scoped.push({ name, window: w })
  }
  return cache.fiveHour || cache.sevenDay || cache.scoped.length > 0 ? cache : undefined
}
