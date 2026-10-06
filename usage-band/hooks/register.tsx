// usage-band: 프롬프트 바로 위 띠에 Claude와 Codex 사용량을 보여 주는 mod.
//
//   Claude  5시간 █▌░░░░░░░░  3% 3시간 5분 후   주간 ███████▋░░ 77% 1일 13시간 후   Fable ██████████ 100% 1일 후   컨텍스트 19%
//   Codex                                     주간 ████░░░░░░ 40% 4일 19시간 후                                  39분 전 기록
//
// 열마다 이름표·막대·퍼센트·리셋 시각의 자리를 맞춰 두 줄이 위아래로 정렬된다. 데스크톱 앱에서는
// 글꼴이 고정폭이 아니어서 두 줄을 SVG 한 장(panel.ts)으로 그리고, 터미널에서는 칸 수를 세어 맞춘다.
//
// Claude 5시간·주간·컨텍스트는 Claude Code가 응답마다 주는 값이고, 모델별 주간 한도(Fable 등)와 그 사이의
// 갱신은 /usage 가 쓰는 사용량 API를 1분마다 세션의 자격 증명 핸들로 직접 받아서(claude-cache.ts) 채운다.
// 열린 세션이 여럿이면 저장소($.store)를 같이 쓰므로 한 세션이 받은 값을 나머지가 가져다 쓰고, API가 거절하면
// (429 등) 알려 준 만큼 쉬었다 다시 받는다. 못 받은 까닭은 저장소 claudeFetch에 남기고 띠의 메모에도 붙인다.
// API를 못 쓰면(로그인 없음·게이트웨이) 상태줄이 남긴 캐시 파일로 대신한다. Codex 수치는 Codex CLI의 앱 서버에
// 물어서(hooks/codex-limits.mjs, 공식 경로) 받고, 그게 안 되면 Codex가 이 PC에 남긴 세션 기록에서 읽는다.
// /usagebar 로 두 줄 → 한 줄 → 숨김을 돌아가며 바꾼다.

import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import { parseClaudeCache, type ClaudeCache } from './claude-cache'
import { effectivePct, lastSnapshot, snapshotFromAppServer, type CodexSnapshot } from './codex'
import { agoText, BAR_WIDTH, barParts, colorFor, columnsOf, cellWidth, padCells, padCellsStart, pctText, resetText, type BandRow, type Meter } from './format'
import { panelSvg } from './panel'

type Layout = 'full' | 'compact' | 'hidden'
type ClaudeFigures = { limits: SessionRateLimit[]; at: number }
/** 사용량 API를 마지막으로 받으려 한 결과. 저장소 claudeFetch에도 남겨서 띠가 옛 값을 보일 때 까닭을 찾을 수 있게 한다 */
type FetchNote = {
  at: number
  session: string
  /** ok 받음 · no-auth 자격 증명 없음 · http 거절(status) · shape 응답 모양이 다름 · error 연결 실패 */
  outcome: 'ok' | 'no-auth' | 'http' | 'shape' | 'error'
  status?: number
  detail?: string
  /** 다음에 다시 받아 볼 때(ms) */
  retryAt?: number
}

const LAYOUTS: Layout[] = ['full', 'compact', 'hidden']
const BIG_FILE = 3_500_000 // $.fs.read 한도(4 MiB)보다 작게
const CLAUDE_LABEL: Record<string, string> = {
  five_hour: '5시간',
  seven_day: '주간',
  spend_limit: '지출 한도',
}
const CLAUDE_COLOR = '#d97757'
const CODEX_COLOR = '#3b6fe0'
const STALE_MS = 15 * 60_000 // 캐시가 이보다 오래되면 "몇 분 전"을 붙인다
// 사용량 API: Claude Code의 /usage 와 같은 곳. 자격 증명은 엔진이 핸들로 붙이므로 mod는 토큰을 보지 않는다
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const USAGE_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }
const FETCH_GAP_MS = 30_000 // 이보다 자주는 받지 않는다(턴이 연달아 끝나도)
const NO_AUTH_RETRY_MS = 10 * 60_000 // 자격 증명이 없다고 하면 이만큼 뒤에 다시 물어본다
const FAIL_RETRY_MS = 5 * 60_000 // 사용량 API가 거절하거나(429·5xx) 끊기면 이만큼 뒤에 다시 받는다(Retry-After가 있으면 그만큼)
const SHARED_FRESH_MS = 50_000 // 다른 세션이 이 안에 받아 둔 값이 저장소에 있으면 직접 받지 않는다
const CODEX_LIVE_GAP_MS = 30_000 // Codex 앱 서버에는 이보다 자주 묻지 않는다
const CODEX_LIVE_RETRY_MS = 10 * 60_000 // 앱 서버를 못 띄우면(node·codex 없음) 이만큼 뒤에 다시 해 본다

// 모듈 상태(다시 불러오면 처음부터; 남길 값은 $.store에)
let layout: Layout = 'full'
let claude: ClaudeFigures | undefined
let isClaudeFromStore = false
let contextPct: number | undefined
let codex: CodexSnapshot | undefined
let codexHome: string | undefined
let configuredHome = ''
let isReading = false
let cachePath = '' // Claude 사용량 캐시 파일(비어 있으면 아직 못 찾음)
let configuredCache = ''
let claudeCache: ClaudeCache | undefined
let lastFetchAt = 0 // 사용량 API를 마지막으로 받은(또는 시도한) 때
let noAuthUntil = 0 // 이때까지는 자격 증명을 다시 묻지 않는다
let failUntil = 0 // 사용량 API가 거절한 뒤 이때까지는 다시 받지 않는다
let lastFetch: FetchNote | undefined // 사용량 API를 마지막으로 받으려 한 결과
let lastCodexLiveAt = 0 // Codex 앱 서버에 마지막으로 물은 때
let codexLiveDownUntil = 0 // 이때까지는 앱 서버 대신 세션 기록만 읽는다
let lastBandSize = ''
let sessionTag = '' // 이 세션의 ID 앞 8자: 여러 세션이 같은 저장소를 쓰므로 기록에 누가 썼는지 남긴다
// 이미 읽은 기록 파일: 크기·수정 시각이 같으면 다시 읽지 않는다
const parsed = new Map<string, { size: number; mtimeMs: number; snap: CodexSnapshot | undefined }>()

function redraw($: EngineInterface) {
  $.ui.invalidate('ui.render')
}

// ── Codex 기록 찾기 ────────────────────────────────────────────────
async function findCodexHome($: EngineInterface): Promise<string | undefined> {
  if (configuredHome) return configuredHome
  const fromEnv = await $.env.get('CODEX_HOME')
  if (fromEnv) return fromEnv
  const profile = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!profile) return undefined
  return profile + (profile.includes('\\') ? '\\' : '/') + '.codex'
}

/** 큰 파일은 통째로 읽지 않고 rate_limits가 든 마지막 줄만 가져온다 */
async function lastRateLine($: EngineInterface, path: string, isWindows: boolean): Promise<string> {
  const argv = isWindows
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Select-String -LiteralPath '${path.replace(/'/g, "''")}' -Pattern '"rate_limits":{' -SimpleMatch | Select-Object -Last 1).Line`,
      ]
    : ['sh', '-c', 'grep -F \'"rate_limits":{\' "$1" | tail -n 1', 'sh', path]
  try {
    const r = await $.process.run(argv, { timeoutMs: 15_000 })
    return r.stdout
  } catch {
    return ''
  }
}

async function readCodex($: EngineInterface): Promise<CodexSnapshot | undefined> {
  codexHome ??= await findCodexHome($)
  if (!codexHome) return undefined
  const isWindows = codexHome.includes('\\') || /^[A-Za-z]:/.test(codexHome)
  const sep = isWindows ? '\\' : '/'
  const join = (...parts: string[]) => parts.join(sep)
  const sessions = join(codexHome, 'sessions')
  if (!(await $.fs.exists(sessions))) return undefined

  const namesDesc = async (dir: string, pattern: RegExp) =>
    (await $.fs.list(dir))
      .filter(x => x.kind === 'dir' && pattern.test(x.name))
      .map(x => x.name)
      .sort()
      .reverse()

  // 최근 날짜 폴더부터 rollout 파일을 모은다(최대 7일치, 8개)
  const files: { path: string; size: number; mtimeMs: number }[] = []
  let days = 0
  outer: for (const y of await namesDesc(sessions, /^\d{4}$/)) {
    for (const m of await namesDesc(join(sessions, y), /^\d{2}$/)) {
      for (const d of await namesDesc(join(sessions, y, m), /^\d{2}$/)) {
        const dir = join(sessions, y, m, d)
        for (const f of await $.fs.list(dir)) {
          if (f.kind === 'file' && /^rollout-.*\.jsonl$/.test(f.name)) {
            files.push({ path: join(dir, f.name), size: f.size, mtimeMs: f.mtimeMs })
          }
        }
        days += 1
        if (files.length >= 8 || days >= 7) break outer
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  // 가장 최근 파일부터, rate_limits가 실제로 들어 있는 첫 스냅숏을 쓴다
  for (const f of files.slice(0, 8)) {
    const seen = parsed.get(f.path)
    let snap = seen?.snap
    if (!seen || seen.size !== f.size || seen.mtimeMs !== f.mtimeMs) {
      const text = f.size <= BIG_FILE ? await $.fs.read(f.path).catch(() => '') : await lastRateLine($, f.path, isWindows)
      snap = lastSnapshot(text)
      parsed.set(f.path, { size: f.size, mtimeMs: f.mtimeMs, snap })
    }
    if (snap) {
      if (!snap.at) snap.at = f.mtimeMs
      return snap
    }
  }
  return undefined
}

/** Codex 앱 서버에 지금 한도를 묻는다(공식 경로, hooks/codex-limits.mjs). 못 받으면 undefined */
async function readCodexLive($: EngineInterface): Promise<CodexSnapshot | undefined> {
  const now = await $.clock.now()
  if (now < codexLiveDownUntil || now - lastCodexLiveAt < CODEX_LIVE_GAP_MS) return undefined
  lastCodexLiveAt = now
  const root = $.plugin.root
  const script = [root, 'hooks', 'codex-limits.mjs'].join(root.includes('\\') ? '\\' : '/')
  try {
    const r = await $.process.run(['node', script], { timeoutMs: 20_000 })
    const last = r.stdout.trim().split('\n').pop() ?? ''
    const o = JSON.parse(last) as { ok?: boolean; at?: number; result?: unknown }
    if (!o.ok) {
      codexLiveDownUntil = now + CODEX_LIVE_RETRY_MS
      return undefined
    }
    return snapshotFromAppServer(o.result, typeof o.at === 'number' ? o.at : now)
  } catch {
    codexLiveDownUntil = now + CODEX_LIVE_RETRY_MS // node나 codex가 없거나 시험 엔진
    return undefined
  }
}

async function refreshCodex($: EngineInterface) {
  if (isReading) return
  isReading = true
  try {
    // 앱 서버가 답하면 그게 지금 값이고, 아니면 Codex가 남긴 세션 기록(마지막으로 쓴 때의 값)
    const snap = (await readCodexLive($)) ?? (codex?.source === 'live' ? undefined : await readCodex($))
    if (snap) {
      codex = snap
      await $.store.set('codex', snap)
    }
  } catch {
    // 기록 폴더를 못 읽어도 띠는 계속 그린다
  } finally {
    isReading = false
    redraw($)
  }
}

// ── Claude 수치 ───────────────────────────────────────────────────
/** 상태줄이 남기는 사용량 캐시: %TEMP%\.claude_usage_cache(Git Bash의 /tmp) 또는 /tmp */
async function findCachePath($: EngineInterface): Promise<string> {
  if (configuredCache) return configuredCache
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
  const candidates = [temp ? temp + (temp.includes('\\') ? '\\' : '/') + '.claude_usage_cache' : '', '/tmp/.claude_usage_cache']
  for (const c of candidates) if (c && (await $.fs.exists(c).catch(() => false))) return c
  return ''
}

const isCache = (v: unknown): v is ClaudeCache => !!v && typeof v === 'object' && typeof (v as ClaudeCache).at === 'number' && Array.isArray((v as ClaudeCache).scoped)

/** 다른 세션이 같은 저장소에 받아 둔 값을 가져온다. 1분 안에 API에서 받은 값이면 true(직접 받을 필요가 없다) */
async function adoptShared($: EngineInterface, now: number): Promise<boolean> {
  const shared = await $.store.get('claudeCache').catch(() => undefined)
  if (!isCache(shared)) return false
  if (shared.at > (claudeCache?.at ?? 0)) claudeCache = shared
  return shared.source === 'api' && now - shared.at < SHARED_FRESH_MS
}

async function noteFetch($: EngineInterface, note: Omit<FetchNote, 'session'>) {
  lastFetch = { ...note, session: sessionTag }
  await $.store.set('claudeFetch', lastFetch).catch(() => undefined)
}

/** 거절당한 뒤 다시 받기까지: Retry-After(초)가 있으면 그만큼(1분~30분), 없으면 5분 */
function retryGap(headers: Record<string, string>): number {
  const sec = Number(headers['retry-after'])
  if (!Number.isFinite(sec) || sec <= 0) return FAIL_RETRY_MS
  return Math.min(30 * 60_000, Math.max(60_000, sec * 1000))
}

/** 사용량 API에서 직접 받는다(5시간·주간·모델별 주간). 받았으면(또는 다른 세션이 방금 받은 값을 썼으면) true,
 *  자격 증명이 없거나 실패하면 false */
async function fetchClaudeUsage($: EngineInterface): Promise<boolean> {
  const now = await $.clock.now()
  if (now - lastFetchAt < FETCH_GAP_MS) return claudeCache?.source === 'api'
  // 세션이 여럿이면 저장소를 같이 쓴다: 누군가 방금 받았으면 그 값을 쓰고 API를 세션 수만큼 두드리지 않는다
  if (await adoptShared($, now)) return true
  if (now < noAuthUntil || now < failUntil) return claudeCache?.source === 'api'
  lastFetchAt = now
  let auth: { handle: string } | null = null
  try {
    auth = await $.session.authorize()
  } catch {
    auth = null // 시험 엔진처럼 자격 증명을 다루지 않는 곳
  }
  if (!auth) {
    noAuthUntil = now + NO_AUTH_RETRY_MS
    await noteFetch($, { at: now, outcome: 'no-auth', retryAt: noAuthUntil })
    return false
  }
  try {
    const r = await $.http.fetch(USAGE_URL, { auth: auth.handle, headers: USAGE_HEADERS })
    if (!r.ok) {
      failUntil = now + retryGap(r.headers)
      await noteFetch($, { at: now, outcome: 'http', status: r.status, detail: r.text.slice(0, 200), retryAt: failUntil })
      return false
    }
    const next = parseClaudeCache(r.text, now)
    if (!next) {
      failUntil = now + FAIL_RETRY_MS
      await noteFetch($, { at: now, outcome: 'shape', detail: r.text.slice(0, 200), retryAt: failUntil })
      return false
    }
    claudeCache = { ...next, source: 'api' }
    await $.store.set('claudeCache', claudeCache)
    await noteFetch($, { at: now, outcome: 'ok' })
    return true
  } catch (err) {
    failUntil = now + FAIL_RETRY_MS
    await noteFetch($, { at: now, outcome: 'error', detail: String(err).slice(0, 200), retryAt: failUntil })
    return false // 네트워크가 막혀도 띠는 계속 그린다
  }
}

/** 상태줄이 남긴 캐시 파일에서 읽는다(API를 못 쓸 때의 대안) */
async function readClaudeCacheFile($: EngineInterface) {
  try {
    cachePath ||= await findCachePath($)
    if (!cachePath) return
    const st = await $.fs.stat(cachePath)
    if (claudeCache && claudeCache.at >= st.mtimeMs) return // API 값이나 같은 파일을 이미 가졌다
    const next = parseClaudeCache(await $.fs.read(cachePath), st.mtimeMs)
    if (next) {
      claudeCache = { ...next, source: 'file' }
      await $.store.set('claudeCache', claudeCache)
    }
  } catch {
    // 캐시가 없거나 모양이 달라도 띠는 계속 그린다
  }
}

async function refreshClaudeCache($: EngineInterface) {
  if (!(await fetchClaudeUsage($))) await readClaudeCacheFile($)
}

async function takeClaude($: EngineInterface, limits: SessionRateLimit[], ctx: number | undefined) {
  if (ctx !== undefined) contextPct = ctx
  if (limits.length > 0) {
    claude = { limits, at: await $.clock.now() }
    isClaudeFromStore = false
    await $.store.set('claude', claude)
  }
  redraw($)
}

export const register: Register = (on, options) => {
  layout = options.layout === 'compact' ? 'compact' : 'full'
  configuredHome = typeof options.codex_home === 'string' ? options.codex_home.trim() : ''
  configuredCache = typeof options.usage_cache === 'string' ? options.usage_cache.trim() : ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // 어느 폴더의 usage-band가 어느 세션에 올라왔는지(설치본 · 개발 폴더) 남긴다. 열린 세션은 열 때 정해진
    // 버전 폴더를 계속 쓰므로, 띠가 옛 모양이면 여기 적힌 폴더부터 본다
    try {
      sessionTag = (await $.session.id()).slice(0, 8)
    } catch {
      sessionTag = 'test' // 시험 엔진처럼 세션 ID가 없는 곳
    }
    void $.store.set('loaded', { root: $.plugin.root, session: sessionTag, at: await $.clock.now() })

    const savedLayout = await $.store.get('layout')
    if (savedLayout === 'full' || savedLayout === 'compact' || savedLayout === 'hidden') layout = savedLayout

    // 이번 세션의 첫 응답 전에는 지난 세션에서 본 값을 보여 준다
    const savedClaude = (await $.store.get('claude')) as ClaudeFigures | undefined
    if (savedClaude && Array.isArray(savedClaude.limits)) {
      claude = savedClaude
      isClaudeFromStore = true
    }
    const savedCodex = (await $.store.get('codex')) as CodexSnapshot | undefined
    if (savedCodex && typeof savedCodex.at === 'number') codex = savedCodex
    const savedCache = (await $.store.get('claudeCache')) as ClaudeCache | undefined
    if (savedCache && typeof savedCache.at === 'number' && Array.isArray(savedCache.scoped)) claudeCache = savedCache

    const usage = await $.session.usage()
    await takeClaude($, usage.rateLimits, usage.context.percent)

    void refreshClaudeCache($).then(() => refreshCodex($))
    $.clock.every(60_000, () => {
      // 사용량 API·Codex 기록 다시 받기 + 남은 시간 글자 갱신
      void refreshClaudeCache($).then(() => refreshCodex($))
    })

    try {
      await $.command.register({
        name: 'usagebar',
        description: '사용량 띠 모양 바꾸기 (두 줄 → 한 줄 → 숨김)',
        immediate: true,
      })
    } catch {
      // 같은 이름의 명령이 이미 있으면 명령 없이 띠만 그린다
    }
    return result
  })

  // 응답마다 한도·컨텍스트가 움직이면 엔진이 알려 준다
  on('session.measure', async ($, e, next) => {
    await takeClaude($, e.rateLimits, e.context.percent)
    return next(e)
  })

  // 한 턴이 끝나면 사용량 API(30초 간격 안이면 건너뜀)와 Codex 쪽도 한 번 더 받는다
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId) void refreshClaudeCache($).then(() => refreshCodex($))
    return result
  })

  on('command.run', { command: 'usagebar' }, async ($, e) => {
    const asked = e.args.trim()
    layout = (LAYOUTS as string[]).includes(asked)
      ? (asked as Layout)
      : (LAYOUTS[(LAYOUTS.indexOf(layout) + 1) % LAYOUTS.length] ?? 'full')
    await $.store.set('layout', layout)
    redraw($)
    $.ui.toast(layout === 'full' ? '사용량 띠: 두 줄' : layout === 'compact' ? '사용량 띠: 한 줄' : '사용량 띠: 숨김 (/usagebar 로 다시 켜기)')
    return {}
  })

  // ── 그리기 ────────────────────────────────────────────────────────
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || layout === 'hidden') return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const rows = rowsOf(now)
    const cols = e.props.bodyColumns
    const isTerminal = e.surface === 'terminal'

    let mine
    if (layout === 'full' && !isTerminal) {
      // 데스크톱·편집기: 두 줄을 SVG 한 장으로(열이 정확히 맞는다)
      // 크기를 정하지 않으면 그림의 너비(넉넉한 기본값)에서 회색 띠 너비까지 맞춰 그려진다
      const { Svg } = $.ui.resolve(e)
      const alt = rows.map(r => `${r.name} ${r.meters.filter(m => m?.pct !== undefined).map(m => `${m?.label} ${pctText(m?.pct ?? 0)}`).join(', ')}`).join(' / ')
      let drawn: { width: number; height: number; length: number } | undefined
      let problem = ''
      try {
        const { svg, width, height } = panelSvg(rows, now)
        drawn = { width, height, length: svg.length }
        mine = <Svg source={svg} alt={alt} width={width} height={height} />
      } catch (err) {
        // 그림을 못 만들면 띠가 비지 않게 한 줄로 대신 보여 준다
        problem = String(err)
        mine = <Text>{alt}</Text>
      }
      // 띠 크기와 그린 결과를 남겨 두면 안 보일 때 원인을 찾을 수 있다
      const seen = `${cols}x${e.viewport.columns}x${e.props.maxRows}|${drawn?.height}|${problem}`
      if (seen !== lastBandSize) {
        lastBandSize = seen
        void $.store.set('desktopBand', { bodyColumns: cols, maxRows: e.props.maxRows, viewport: e.viewport, surface: e.surface, drawn, problem, root: $.plugin.root, session: sessionTag, at: now })
      }
    } else if (layout === 'full' && cols >= 72) {
      // 터미널: 칸 수를 세어 열을 맞춘다
      const barWidth = cols >= 120 ? BAR_WIDTH : cols >= 96 ? 8 : 6
      const isResetShown = cols >= 100
      const widths = columnsOf(rows, now, cellWidth)
      const nameW = Math.max(...rows.map(r => cellWidth(r.name))) + 2
      mine = (
        <Box flexDirection="column">
          {rows.map(r => (
            <Box key={r.name} flexDirection="row">
              <Text bold color={r.color}>
                {padCells(r.name, nameW)}
              </Text>
              {widths.map((w, c) => {
                const m = r.meters[c]
                const reset = isResetShown && m ? resetText(m, now) : ''
                const restW = barWidth + 1 + 4 + (isResetShown && w.reset ? 1 + w.reset : 0) + 3
                if (!m) return <Text key={c}>{' '.repeat(w.label + 1 + restW)}</Text>
                if (m.pct === undefined) {
                  return (
                    <Text key={c} dimColor>
                      {padCells(m.label, w.label + 1) + padCells('—', restW)}
                    </Text>
                  )
                }
                const [filled, empty] = barParts(m.pct, barWidth)
                return (
                  <Text key={c}>
                    <Text dimColor>{padCells(m.label, w.label + 1)}</Text>
                    <Text color={colorFor(m.pct)}>{filled}</Text>
                    <Text dimColor>{empty}</Text>
                    <Text bold color={colorFor(m.pct)}>
                      {padCellsStart(pctText(m.pct), 5)}
                    </Text>
                    <Text dimColor>{padCells(isResetShown && w.reset ? ' ' + reset : '', isResetShown && w.reset ? 1 + w.reset : 0) + '   '}</Text>
                  </Text>
                )
              })}
              {r.tail ? (
                <Text>
                  <Text dimColor>{r.tail.label} </Text>
                  <Text bold color={colorFor(r.tail.pct)}>
                    {pctText(r.tail.pct)}
                  </Text>
                  {'  '}
                </Text>
              ) : null}
              {r.note ? <Text dimColor>{r.note}</Text> : null}
            </Box>
          ))}
        </Box>
      )
    } else {
      // 한 줄: "Claude 5시간 3% 주간 77% Fable 100% ctx 19% │ Codex 주간 40%"
      mine = (
        <Box flexDirection="row" flexWrap="wrap">
          {rows.map((r, i) => (
            <Text key={r.name}>
              {i > 0 ? <Text dimColor> │ </Text> : null}
              <Text bold color={r.color}>
                {r.name}
              </Text>
              {r.meters
                .filter((m): m is Meter & { pct: number } => m?.pct !== undefined)
                .map(m => (
                  <Text key={m.label}>
                    <Text dimColor> {m.label} </Text>
                    <Text bold color={colorFor(m.pct)}>
                      {pctText(m.pct)}
                    </Text>
                  </Text>
                ))}
              {r.tail ? (
                <Text>
                  <Text dimColor> ctx </Text>
                  <Text bold color={colorFor(r.tail.pct)}>
                    {pctText(r.tail.pct)}
                  </Text>
                </Text>
              ) : null}
              {r.meters.every(m => m?.pct === undefined) && r.note ? <Text dimColor> {r.note}</Text> : null}
            </Text>
          ))}
        </Box>
      )
    }

    // 다른 mod(예: pocket-pet)가 띠에 그린 것도 함께 보이도록 아래에 붙인다
    const below = await next(e)
    return (
      <Box flexDirection="column" rowGap={0}>
        {mine}
        {below}
      </Box>
    )
  })
}

/** 지금 가진 수치로 Claude 줄과 Codex 줄을 만든다. 열: 5시간 · 주간 · 모델별 주간… */
function rowsOf(now: number): BandRow[] {
  const at = (w: { pct: number; resetsAtMs?: number } | undefined, label: string): Meter =>
    w ? { label, pct: effectivePct({ pct: w.pct, resetsAtMs: w.resetsAtMs }, now) ?? 0, resetsAtMs: w.resetsAtMs } : { label }

  // Claude: 엔진 값과 캐시 중 더 최근 것
  const fromEngine = (kind: string) => {
    const l = claude?.limits.find(x => x.kind === kind)
    if (!l) return undefined
    const t = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    return { pct: l.percentUsed, resetsAtMs: Number.isFinite(t) ? t : undefined }
  }
  // 같은 순간에 받았으면 사용량 API 쪽(모델별 한도까지 한 벌)을 쓴다
  const isCacheNewer = claudeCache !== undefined && (!claude || claudeCache.at >= claude.at)
  const five = (isCacheNewer ? claudeCache?.fiveHour : undefined) ?? fromEngine('five_hour') ?? claudeCache?.fiveHour
  const week = (isCacheNewer ? claudeCache?.sevenDay : undefined) ?? fromEngine('seven_day') ?? claudeCache?.sevenDay
  const scoped = (claudeCache?.scoped ?? []).map(s => at(s.window, s.name)) // 모델별 주간 한도: 이름만(Fable)
  const extra = (claude?.limits ?? [])
    .filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day' && l.percentUsed >= 50)
    .map(l => at({ pct: l.percentUsed, resetsAtMs: l.resetsAt ? Date.parse(l.resetsAt) || undefined : undefined }, CLAUDE_LABEL[l.kind] ?? l.kind))

  const lastSeen = Math.max(claude?.at ?? 0, claudeCache?.at ?? 0)
  const claudeNote =
    !five && !week ? '첫 응답 뒤에 한도가 보여요' : (isClaudeFromStore && !isCacheNewer) || now - lastSeen > STALE_MS ? `${agoText(now - lastSeen)} 기록` : undefined
  // 엔진 값은 새것인데 모델별 한도(API를 못 써서 파일이나 옛 기록에서 온 것)만 오래된 경우: 왜 못 받는지도 붙인다
  const why =
    lastFetch?.outcome === 'http' ? ` · API ${lastFetch.status}` : lastFetch?.outcome === 'no-auth' ? ' · 자격 증명 없음' : lastFetch?.outcome === 'error' ? ' · API 연결 실패' : ''
  const cacheNote =
    claudeCache && scoped.length > 0 && now - claudeCache.at > STALE_MS
      ? `${claudeCache.scoped.map(s => s.name).join('·')} ${agoText(now - claudeCache.at)} 기록${why}`
      : undefined
  const claudeRow: BandRow = {
    name: 'Claude',
    color: CLAUDE_COLOR,
    meters: five || week ? [at(five, '5시간'), at(week, '주간'), ...scoped, ...extra] : [],
    tail: contextPct !== undefined ? { label: '컨텍스트', pct: contextPct } : undefined,
    note: claudeNote ?? cacheNote,
  }

  const codexRow: BandRow = {
    name: 'Codex',
    color: CODEX_COLOR,
    // 없는 창(요즘 Codex는 5시간 창이 없다)은 빈칸으로 두어 주간끼리 위아래로 맞춘다
    meters: codex?.short || codex?.week ? [codex.short ? at(codex.short, '5시간') : undefined, codex.week ? at(codex.week, '주간') : undefined] : [],
    // 앱 서버에서 방금 받은 값에는 "몇 분 전 기록"을 붙이지 않는다(15분 넘게 못 받았으면 붙인다)
    note: !codex ? '이 PC에 Codex 사용 기록이 없어요' : codex.source === 'live' && now - codex.at < STALE_MS ? undefined : codex.at ? `${agoText(now - codex.at)} 기록` : undefined,
  }
  return [claudeRow, codexRow]
}
