import type { CommandRunInput, On, RenderElement, RenderInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { effectivePct, lastSnapshot, parseLine } from '../hooks/codex'
import { parseClaudeCache } from '../hooks/claude-cache'
import { bar, cellWidth, untilText } from '../hooks/format'

// 2026-10-02 09:00 UTC
const NOW = Date.parse('2026-10-02T09:00:00Z')
const SEC = (ms: number) => Math.floor(ms / 1000)

const LINE_NEW = JSON.stringify({
  timestamp: '2026-10-02T08:57:00.000Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: { total_token_usage: { total_tokens: 1234 } },
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 12.0, window_minutes: 300, resets_at: SEC(NOW + 2 * 3600_000) },
      secondary: { used_percent: 30.0, window_minutes: 10080, resets_at: SEC(NOW + 5 * 86400_000) },
      plan_type: 'plus',
    },
  },
})
const LINE_NULL = JSON.stringify({ timestamp: '2026-10-02T08:58:00.000Z', type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: null } })
const LINE_WEEKLY_PRIMARY = JSON.stringify({
  timestamp: '2026-10-02T08:00:00.000Z',
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: 43, window_minutes: 10080, resets_at: 0 }, secondary: null } },
})
const LINE_OLD = JSON.stringify({
  timestamp: '2026-10-02T08:00:00.000Z',
  payload: { type: 'token_count', rate_limits: { primary: { used_percent: 55, resets_in_seconds: 600 }, secondary: { used_percent: 20, resets_in_seconds: 86400 } } },
})

/** 상태줄이 받아 두는 claude.ai 사용량 응답(필요한 부분만) */
const CACHE = JSON.stringify({
  five_hour: { utilization: 3.0, resets_at: '2026-10-02T14:09:59+00:00' },
  seven_day: { utilization: 77.0, resets_at: '2026-10-04T00:59:59+00:00' },
  seven_day_opus: null,
  limits: [
    { kind: 'session', percent: 3, resets_at: '2026-10-02T14:09:59+00:00', scope: null },
    { kind: 'weekly_all', percent: 77, resets_at: '2026-10-04T00:59:59+00:00', scope: null },
    { kind: 'weekly_scoped', percent: 100, resets_at: '2026-10-04T00:59:59+00:00', scope: { model: { id: null, display_name: 'Fable' }, surface: null } },
  ],
})

describe('codex rollout parsing', () => {
  test('reads the newest line that has limits, skipping null ones', () => {
    const snap = lastSnapshot([LINE_NEW, LINE_NULL, ''].join('\n'))
    expect(snap?.short?.pct).toBe(12)
    expect(snap?.week?.pct).toBe(30)
    expect(snap?.short?.resetsAtMs).toBe(NOW + 2 * 3600_000)
    expect(snap?.plan).toBe('plus')
  })

  test('a weekly window in primary is filed as weekly; resets_at 0 is unknown', () => {
    const snap = parseLine(LINE_WEEKLY_PRIMARY)
    expect(snap?.short).toBeUndefined()
    expect(snap?.week?.pct).toBe(43)
    expect(snap?.week?.resetsAtMs).toBeUndefined()
  })

  test('older files: resets_in_seconds counts from the line time', () => {
    const snap = parseLine(LINE_OLD)
    expect(snap?.short?.pct).toBe(55)
    expect(snap?.short?.resetsAtMs).toBe(Date.parse('2026-10-02T08:10:00Z'))
    expect(snap?.week?.pct).toBe(20)
  })

  test('a window whose reset passed counts as 0%', () => {
    expect(effectivePct({ pct: 80, resetsAtMs: NOW - 1 }, NOW)).toBe(0)
    expect(effectivePct({ pct: 80, resetsAtMs: NOW + 1 }, NOW)).toBe(80)
  })

  test('the usage cache gives the per-model weekly limits', () => {
    const cache = parseClaudeCache(CACHE, NOW - 30_000)
    expect(cache?.fiveHour?.pct).toBe(3)
    expect(cache?.sevenDay?.pct).toBe(77)
    expect(cache?.scoped).toEqual([{ name: 'Fable', window: { pct: 100, resetsAtMs: Date.parse('2026-10-04T00:59:59Z') } }])
    expect(parseClaudeCache('not json', 0)).toBeUndefined()
  })

  test('bars and times', () => {
    expect(bar(42, 10)).toBe('████▎░░░░░')
    expect(bar(0, 10)).toBe('░░░░░░░░░░')
    expect(bar(100, 10)).toBe('██████████')
    for (const p of [0, 3, 42, 77, 99, 100]) expect(cellWidth(bar(p, 10))).toBe(10)
    expect(cellWidth('Fable 주간')).toBe(10)
    expect(untilText(2 * 3600_000 + 13 * 60_000)).toBe('2시간 13분')
    expect(untilText(3 * 86400_000 + 4 * 3600_000)).toBe('3일 4시간')
  })
})

const BAND = (surface: 'terminal' | 'desktop', bodyColumns = 120): RenderInput<'AbovePrompt'> =>
  ({
    component: 'AbovePrompt',
    surface,
    requestId: 'band',
    viewport: { columns: bodyColumns, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns, scroll: { offset: 0, bodyRows: 19 }, view: {} },
  }) as RenderInput<'AbovePrompt'>

/** 그린 것 전부(SVG 안의 글자까지) */
const allOf = (node: unknown): string => JSON.stringify(node)

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const kids = Reflect.get(node, 'children')
  return Array.isArray(kids) ? kids.map(textOf).join('') : ''
}

// The Linux test host reads `C:\\…` as relative and puts its own folder in front
const at = (path: string) => path.slice(Math.max(0, path.indexOf('C:\\')))

/** What the engine draws in the band when no plugin draws */
const ENGINE_BAND: RenderElement = { type: 'Box', children: [] }

const USAGEBAR: CommandRunInput = {
  command: 'usagebar',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
}

/** A Windows PC with one Codex session file and a Claude subscription.
 *  `cache`: the statusline's cache file exists. `api`: the session has a credential, and the usage API answers
 *  (every call is counted in `api.calls`, the first one's request kept in `api.first`) */
function windowsPc(on: On, options: { cache?: boolean; api?: { calls: number; first?: { url: string; init?: Record<string, unknown> }; text?: string }; codexLive?: { calls: number; argv?: readonly string[] } } = {}) {
  if (options.codexLive) {
    const live = options.codexLive
    on('process.run', ($, e) => {
      live.calls += 1
      live.argv ??= e.argv
      const answer = { ok: true, at: NOW, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: SEC(NOW + 5 * 86400_000) }, secondary: null, planType: 'prolite' } } }
      return { value: { exitCode: 0, stdout: JSON.stringify(answer) + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
  }
  if (options.api) {
    const api = options.api
    on('session.authorize', () => ({ value: { handle: 'cred-handle', kind: 'bearer' as const } }))
    on('http.fetch', ($, e) => {
      api.calls += 1
      api.first ??= { url: e.url, init: e.init as Record<string, unknown> | undefined }
      return { value: { status: 200, ok: true, headers: {}, text: api.text ?? CACHE } }
    })
  }
  const HOME = 'C:\\Users\\spdlq'
  const TEMP = `${HOME}\\AppData\\Local\\Temp`
  const CACHE_FILE = `${TEMP}\\.claude_usage_cache`
  const DAY = `${HOME}\\.codex\\sessions\\2026\\10\\02`
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, () => ENGINE_BAND)
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW,
      context: { window: 200_000, tokens: 70_000, percent: 35 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(NOW + 2 * 3600_000 + 13 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 18, resetsAt: new Date(NOW + 3 * 86400_000).toISOString() },
      ],
    },
  }))
  on('fs.exists', ($, e) => ({ value: at(e.path) === `${HOME}\\.codex\\sessions` || (!!options.cache && at(e.path) === CACHE_FILE) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: CACHE.length, mtimeMs: NOW - 30_000 } as never }))
  on('fs.list', ($, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const listing: Record<string, unknown[]> = {
      [`${HOME}\\.codex\\sessions`]: [dir('2026')],
      [`${HOME}\\.codex\\sessions\\2026`]: [dir('09'), dir('10')],
      [`${HOME}\\.codex\\sessions\\2026\\10`]: [dir('02')],
      [DAY]: [{ name: 'rollout-2026-10-02T08-00-00-abc.jsonl', kind: 'file', size: 2000, mtimeMs: NOW - 180_000, isLink: false }],
    }
    return { value: (listing[at(e.path)] ?? []) as never }
  })
  on('fs.read', ($, e) => ({ value: at(e.path) === CACHE_FILE ? CACHE : [LINE_NEW, LINE_NULL].join('\n') }))
  mock.env(on, { USERPROFILE: HOME, TEMP })
  mock.store(on, {})
  return mock.clock(on, { now: NOW })
}

describe('the band', () => {
  test('two lines: Claude limits and Codex limits from the session file', async ($, on) => {
    const clock = windowsPc(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
    await clock.settle()
    // the first Codex read runs in the background: draw until it lands
    for (let i = 0; i < 30 && textOf(await $.ui.render(BAND('terminal'))).includes('기록이 없어요'); i++) await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const text = surface === 'terminal' ? textOf(await $.ui.render(BAND(surface))) : allOf(await $.ui.render(BAND(surface)))
      expect(text).toContain('Claude')
      expect(text).toContain('42%')
      expect(text).toContain('2시간 13분')
      expect(text).toContain(surface === 'terminal' ? '컨텍스트' : 'ctx')
      expect(text).toContain('35%')
      expect(text).toContain('Codex')
      expect(text).toContain('12%')
      expect(text).toContain('30%')
      expect(text).toContain(surface === 'terminal' ? '3분 전 기록' : '3분 전')
    }
  })

  test('the terminal lines up both rows column by column', async ($, on) => {
    const clock = windowsPc(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
    for (let i = 0; i < 30 && textOf(await $.ui.render(BAND('terminal', 140))).includes('기록이 없어요'); i++) await clock.settle()
    const tree = await $.ui.render(BAND('terminal', 140))
    const lines = (Reflect.get(Reflect.get(tree as object, 'children')[0], 'children') as unknown[]).map(textOf)
    expect(lines).toHaveLength(2)
    const [claude = '', codex = ''] = lines
    // "주간" 이름표가 두 줄에서 같은 칸에 온다
    const col = (line: string) => cellWidth(line.slice(0, line.indexOf('주간')))
    expect(col(claude)).toBe(col(codex))
  })

  test('Fable weekly limit from the usage cache sits in its own column', async ($, on) => {
    const clock = windowsPc(on, { cache: true })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    for (let i = 0; i < 30 && !allOf(await $.ui.render(BAND('desktop'))).includes('Fable'); i++) await clock.settle()
    const desktop = allOf(await $.ui.render(BAND('desktop')))
    expect(desktop).toContain('>Fable<')
    expect(desktop).toContain('100%')
    // 5시간·주간은 더 최근인 엔진 값(캐시는 30초 전)
    expect(desktop).toContain('42%')
    expect(desktop).not.toContain('77%')
    await $.command.run(USAGEBAR)
    const compact = textOf(await $.ui.render(BAND('terminal')))
    expect(compact).toContain('Fable 100%')
  })

  test('the usage API through the session credential gives Fable in real time, and the cache file is not read', async ($, on) => {
    const api = { calls: 0 } as { calls: number; first?: { url: string; init?: Record<string, unknown> } }
    const clock = windowsPc(on, { cache: true, api })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    for (let i = 0; i < 30 && !allOf(await $.ui.render(BAND('desktop'))).includes('Fable'); i++) await clock.settle()
    const desktop = allOf(await $.ui.render(BAND('desktop')))
    expect(desktop).toContain('>Fable<')
    expect(desktop).toContain('100%')
    // the official usage endpoint, with the credential handle (never the token) and the OAuth beta header
    expect(api.first?.url).toBe('https://api.anthropic.com/api/oauth/usage')
    expect(api.first?.init?.auth).toBe('cred-handle')
    expect((api.first?.init?.headers as Record<string, string>)['anthropic-beta']).toBe('oauth-2025-04-20')
    // the API answer is the newest figure: its 주간 77% and 5시간 3% replace the engine's 18% and 42%
    expect(desktop).toContain('77%')
    expect(desktop).not.toContain('42%')
    expect(desktop).not.toContain('기록')
    expect(api.calls).toBe(1)
  })

  test('Codex limits come from the app server when it answers, and carry no "기록" note', async ($, on) => {
    const live = { calls: 0 } as { calls: number; argv?: readonly string[] }
    const clock = windowsPc(on, { codexLive: live })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
    for (let i = 0; i < 30 && !textOf(await $.ui.render(BAND('terminal'))).includes('7%'); i++) await clock.settle()
    const text = textOf(await $.ui.render(BAND('terminal')))
    expect(text).toContain('Codex')
    expect(text).toContain('7%') // the app server's figure, not the 12%/30% of the session file
    expect(text).not.toContain('12%')
    expect(text).not.toContain('기록')
    expect(live.argv?.[0]).toBe('node')
    expect(String(live.argv?.[1])).toContain('codex-limits.mjs')
    expect(live.calls).toBe(1)
  })

  test('/usagebar cycles to one line, then hides', async ($, on) => {
    const clock = windowsPc(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:\\work' })
    await clock.settle()

    await $.command.run(USAGEBAR)
    const compact = textOf(await $.ui.render(BAND('terminal')))
    expect(compact).toContain('│')
    expect(compact).not.toContain('█')

    await $.command.run(USAGEBAR)
    const hidden = textOf(await $.ui.render(BAND('terminal')))
    expect(hidden).not.toContain('Claude')
  })
})
