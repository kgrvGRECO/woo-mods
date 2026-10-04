// pocket-pet: 바탕화면에 사는 픽셀 펫 "클로"(주황 몸에 민트 스카프)의 Claude Code 쪽 절반.
//
// 이 mod는 Claude Code 화면에 아무것도 그리지 않는다. Claude가 하는 일(생각·도구·허락 대기·
// 완료·멈춤)을 세션마다 상태 파일(~/.claude/clo/sessions/<세션 ID>.json)에 적고, 바탕화면 클로
// 프로그램(desktop/clo_pet.pyw)을 띄운다. 프로그램은 살아 있는 세션들의 파일을 읽어 반응한다
// (허락 대기가 먼저, 그다음 가장 최근에 바뀐 세션). 창은 마우스로 끌어 옮길 수 있다.
//
// 바탕화면 클로의 입력 카드에서 이 세션을 골라 보내면, 클로가 ~/.claude/clo/inbox/<세션 ID>.json 에
// 메시지를 남기고, 이 mod가 1초마다 확인해 사용자가 입력한 것처럼 이 세션에 넣는다.
//
//   /pet          바탕화면 클로 켜기(이미 떠 있으면 화면 안으로 불러오기)
//   /pet pat      쓰다듬기
//   /pet 끄기     바탕화면 클로 끄기

import type { EngineInterface, Register } from 'claude-code'

type Mood = 'idle' | 'thinking' | 'working' | 'waiting' | 'done' | 'oops'
type Command = 'show' | 'pat' | 'quit'

/** 바탕화면 클로가 읽는 상태 파일의 모양 */
export type PetState = {
  v: 1
  name: string
  mood: Mood
  /** 말풍선에 쓸 한 줄 */
  detail: string
  /** 읽기·찾기 도구 중인지(살펴보는 동작) */
  isReading: boolean
  toolCount: number
  turnStartedAt: number
  /** mood가 바뀐 시각(ms) */
  at: number
  /** 세션이 살아 있다는 표시(1분마다) */
  alive: number
  /** 세션의 작업 폴더: 바탕화면 클로에서 새 세션을 열 때 고를 수 있다 */
  cwd?: string
  /** 세션 제목: Claude 앱에 보이는 세션 제목(아직 없으면 첫 질문의 앞부분). 바탕화면 클로의 세션 목록에 보인다 */
  title?: string
  /** 바탕화면 클로가 남긴 메시지를 받을 수 있다(이 표시가 있는 세션만 '열린 세션' 목록에 나온다) */
  canReceive?: boolean
  command?: { id: number; kind: Command }
}

const HEARTBEAT_MS = 60_000
const INBOX_MS = 1_000 // 바탕화면 클로가 남긴 메시지를 확인하는 간격
const INBOX_FRESH_MS = 2 * 60_000 // 이보다 오래된 메시지는 넣지 않는다

/** 바탕화면 클로가 이 세션 앞으로 남기는 메시지 */
export type InboxMessage = { id: number; text: string; at: number }
const READING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'LS', 'NotebookRead'])

// 모듈 상태(다시 불러오면 처음부터)
let petName = '클로'
let isAutoStart = true
let python = ''
let stateDir = ''
let state: PetState = { v: 1, name: '클로', mood: 'idle', detail: '', isReading: false, toolCount: 0, turnStartedAt: 0, at: 0, alive: 0 }
let isTurnRunning = false
let toolsRunning = 0
let commandId = 0
let inboxDir = ''
let lastInboxId = 0 // 이미 넣은(또는 시작 전에 있던) 메시지
let isCheckingInbox = false

async function homeOf($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
}

const isWindowsPath = (p: string) => p.includes('\\') || /^[A-Za-z]:/.test(p)
const join = (base: string, ...parts: string[]) => [base, ...parts].join(isWindowsPath(base) ? '\\' : '/')

async function save($: EngineInterface, patch: Partial<PetState>) {
  const now = await $.clock.now()
  if (patch.mood !== undefined && patch.mood !== state.mood) patch.at = now
  state = { ...state, ...patch, name: petName, alive: patch.alive ?? now }
  if (!stateDir) return
  try {
    // /clear 뒤에는 세션 ID가 바뀌므로 쓸 때마다 묻는다
    await $.fs.write(join(stateDir, `${await $.session.id()}.json`), JSON.stringify(state))
  } catch {
    // 파일을 못 써도 Claude Code 작업은 계속된다
  }
}

/** 바탕화면 클로 프로그램 띄우기. 이미 떠 있으면 프로그램이 알아서 하나만 남긴다 */
async function launch($: EngineInterface): Promise<boolean> {
  const script = join($.plugin.root, 'desktop', 'clo_pet.pyw')
  const isWindows = isWindowsPath(script)
  const argv = isWindows
    ? [
        'powershell.exe',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Start-Process -FilePath '${(python || 'pythonw').replace(/'/g, "''")}' -ArgumentList @('"${script.replace(/'/g, "''")}"')`,
      ]
    : ['sh', '-c', `nohup "${python || 'python3'}" "$1" >/dev/null 2>&1 &`, 'sh', script]
  try {
    const r = await $.process.run(argv, { timeoutMs: 15_000 })
    return r.exitCode === 0
  } catch {
    return false
  }
}

async function send($: EngineInterface, kind: Command) {
  commandId += 1
  await save($, { command: { id: (await $.clock.now()) * 10 + (commandId % 10), kind } })
}

async function readInbox($: EngineInterface): Promise<InboxMessage | undefined> {
  if (!inboxDir) return undefined
  const path = join(inboxDir, `${await $.session.id()}.json`)
  try {
    if (!(await $.fs.exists(path))) return undefined
    const m = JSON.parse(await $.fs.read(path)) as InboxMessage
    return typeof m.id === 'number' && typeof m.text === 'string' ? m : undefined
  } catch {
    return undefined // 쓰는 도중이면 다음에 다시
  }
}

/** 바탕화면 클로가 남긴 새 메시지를 이 세션에 사용자 입력처럼 넣는다 */
async function checkInbox($: EngineInterface) {
  if (isCheckingInbox) return
  isCheckingInbox = true
  try {
    const m = await readInbox($)
    if (!m || m.id <= lastInboxId) return
    lastInboxId = m.id
    if (!m.text.trim() || (await $.clock.now()) - m.at > INBOX_FRESH_MS) return
    await $.prompt.submit({ text: m.text, asUser: true })
  } catch {
    // 넣지 못해도 다음 메시지는 계속 받는다
  } finally {
    isCheckingInbox = false
  }
}

/** 도구 호출을 사람이 읽는 한 줄로 */
export function describeTool(tool: string, args: Record<string, unknown>): string {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const base = (p: string) => p.split(/[\\/]/).pop() || p
  const cut = (s: string, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
  switch (tool) {
    case 'Read':
      return `읽는 중: ${base(str('file_path'))}`
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `고치는 중: ${base(str('file_path') || str('notebook_path'))}`
    case 'Write':
      return `쓰는 중: ${base(str('file_path'))}`
    case 'Bash':
    case 'PowerShell':
      return `실행 중: ${cut(str('command').split('\n')[0] ?? '')}`
    case 'Grep':
    case 'Glob':
      return `찾는 중: ${cut(str('pattern'), 30)}`
    case 'WebSearch':
      return `웹 검색: ${cut(str('query'), 30)}`
    case 'WebFetch':
      return `웹 페이지 읽는 중`
    case 'Task':
    case 'Agent':
      return `도우미를 보내는 중`
    case 'TodoWrite':
      return `할 일 정리 중`
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(tool)
      return m ? `${m[1]} 도구: ${m[2]}` : `${tool} 쓰는 중`
    }
  }
}

function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}

export const register: Register = (on, options) => {
  if (typeof options.pet_name === 'string' && options.pet_name.trim()) petName = options.pet_name.trim()
  isAutoStart = options.auto_start !== 'off'
  python = typeof options.python === 'string' ? options.python.trim() : ''

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    stateDir = join(await homeOf($), '.claude', 'clo', 'sessions')
    await save($, { mood: 'idle', detail: '', cwd: e.cwd, canReceive: true })
    // 바탕화면 클로가 남긴 메시지: 시작 전에 있던 것은 넣지 않는다
    inboxDir = join(await homeOf($), '.claude', 'clo', 'inbox')
    const old = await readInbox($)
    if (old) lastInboxId = old.id
    $.clock.every(INBOX_MS, () => {
      void checkInbox($)
    })
    $.clock.every(HEARTBEAT_MS, () => {
      void save($, {})
    })
    if (isAutoStart) void launch($)

    try {
      await $.command.register({
        name: 'pet',
        description: '바탕화면 클로 켜기 (pat 쓰다듬기 · 끄기)',
        argumentHint: '[pat|끄기]',
        immediate: true,
      })
    } catch {
      // /pet 이 이미 있으면 명령 없이 상태만 적는다
    }
    return result
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pat' || arg === '쓰다듬기') {
      await send($, 'pat')
    } else if (arg === '끄기' || arg === 'quit' || arg === 'off' || arg === '숨기기') {
      await send($, 'quit')
      $.ui.toast(`${petName}가 쉬러 갔어요 (/pet 으로 부르기)`)
    } else {
      await send($, 'show')
      const ok = await launch($)
      $.ui.toast(ok ? `${petName}가 바탕화면에 나왔어요` : `${petName}를 띄우지 못했어요: Python(pythonw)이 있는지 확인해 주세요`)
    }
    return {}
  })

  // 세션이 끝나면 살아 있다는 표시를 지워 바탕화면 클로가 이 세션을 잊게 한다
  on('session.end', async ($, e, next) => {
    await save($, { mood: 'idle', detail: '', alive: 0 })
    return next(e)
  })

  // ── Claude가 하는 일 ──────────────────────────────────────────────
  // Claude 앱에 보이는 세션 제목: 질문을 받을 때·세션을 열 때 함께 온다(이름을 바꾸면 다음 질문 때 따라간다)
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.session_title && e.session_title !== state.title) await save($, { title: e.session_title })
    return next(e)
  })
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.session_title && e.session_title !== state.title) await save($, { title: e.session_title })
    return result
  })

  on('turn.start', async ($, e, next) => {
    // 앱의 세션 제목이 아직 없으면 첫 질문을 제목으로(바탕화면 클로의 세션 목록에 보인다)
    if (!state.title && e.text.trim()) {
      const first = e.text.trim().split('\n')[0] ?? ''
      state.title = first.length > 40 ? first.slice(0, 39) + '…' : first
    }
    isTurnRunning = true
    toolsRunning = 0
    await save($, { mood: 'thinking', detail: '', toolCount: 0, isReading: false, turnStartedAt: await $.clock.now() })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    toolsRunning += 1
    const words = (e.agentId ? '도우미: ' : '') + describeTool(String(e.tool), e as unknown as Record<string, unknown>)
    const isReading = READING_TOOLS.has(String(e.tool))
    if (state.mood === 'waiting') await save($, { toolCount: state.toolCount + 1, isReading })
    else await save($, { mood: 'working', detail: words, toolCount: state.toolCount + 1, isReading })
    try {
      return await next(e)
    } finally {
      toolsRunning -= 1
      // 동시에 돌던 도구가 모두 끝났을 때만 생각 중으로 돌아간다
      if (toolsRunning === 0 && isTurnRunning && (state.mood === 'working' || state.mood === 'waiting')) {
        await save($, { mood: 'thinking', detail: '', isReading: false })
      }
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await save($, { mood: 'waiting', detail: `허락이 필요해요 → ${describeTool(e.tool_name, (e.tool_input ?? {}) as Record<string, unknown>)}` })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) return result // 도우미의 턴은 건너뛴다
    isTurnRunning = false
    const tools = state.toolCount > 0 ? ` · 도구 ${state.toolCount}번` : ''
    if (e.reason === 'answer') await save($, { mood: 'done', detail: `다 했어요! ${durationText(e.durationMs)}${tools}`, isReading: false })
    else if (e.reason === 'aborted') await save($, { mood: 'oops', detail: '멈췄어요. 다시 말해 주세요', isReading: false })
    else await save($, { mood: 'oops', detail: '문제가 생겼어요… 다시 해 볼까요?', isReading: false })
    return result
  })
}
