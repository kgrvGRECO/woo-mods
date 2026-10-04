import type { CommandRunInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { PetState } from '../hooks/register'

const NOW = Date.parse('2026-10-02T09:00:00Z')
const PET: CommandRunInput = { command: 'pet', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }

/** Windows PC 한 대: 상태 파일 쓰기와 프로그램 실행을 받아 적는다 */
function windowsPc(on: On, inbox: { text?: string } = {}) {
  const writes: { path: string; state: PetState }[] = []
  const submitted: string[] = []
  const runs: string[][] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: 'sess-1' }) as never)
  on('session.id', () => ({ value: 'sess-1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))
  // 바탕화면 클로가 남긴 메시지(inbox.text가 있을 때만)
  on('fs.exists', ($, e) => ({ value: e.path.includes('inbox') && inbox.text !== undefined }))
  on('fs.read', ($, e) => ({ value: JSON.stringify({ id: inboxId, text: inbox.text ?? '', at: NOW }) }))
  on('prompt.submit', ($, e) => {
    submitted.push(e.text)
    return { value: undefined } as never
  })
  let inboxId = 1
  const post = (text: string) => {
    inbox.text = text
    inboxId += 1
  }
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, state: JSON.parse(e.text) as PetState })
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } as never }
  })
  mock.env(on, { USERPROFILE: 'C:\\Users\\spdlq' })
  mock.store(on, {})
  const clock = mock.clock(on, { now: NOW })
  const last = () => writes[writes.length - 1]?.state
  return { writes, runs, clock, last, submitted, post }
}

describe('the desktop pet bridge', () => {
  test('a session writes its own state file and starts the desktop pet', async ($, on) => {
    const pc = windowsPc(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    expect(pc.writes[0]?.path).toMatch(/\.claude\\clo\\sessions\\sess-1\.json$/)
    expect(pc.last()?.mood).toBe('idle')
    expect(pc.last()?.alive).toBe(NOW)
    // 띄우는 방법은 이 플러그인이 설치된 곳의 경로 모양을 따른다(Windows면 PowerShell, 아니면 sh)
    const launch = pc.runs.find(a => a.join(' ').includes('clo_pet.pyw'))
    if ($.plugin.root.includes('\\')) {
      expect(launch?.[0]).toBe('powershell.exe')
      expect(launch?.join(' ')).toContain('Start-Process')
    } else {
      expect(launch?.[0]).toBe('sh')
      expect(launch?.join(' ')).toContain('nohup')
    }
  })

  test('auto_start off leaves the desktop pet alone until /pet', { options: { auto_start: 'off' } }, async ($, on) => {
    const pc = windowsPc(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    expect(pc.runs).toHaveLength(0)
    await $.command.run(PET)
    expect(pc.runs).toHaveLength(1)
    expect(pc.last()?.command?.kind).toBe('show')
  })

  test('follows a turn: thinking, reading, done', async ($, on) => {
    const pc = windowsPc(on)
    let during: PetState | undefined
    on('tool.call', async () => {
      during = pc.last()
      return { result: 'ok' } as never
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.turn.start({ text: 'README 고쳐 줘', turnId: 't1' } as never)
    expect(pc.last()?.mood).toBe('thinking')

    await $.tool.call({ tool: 'Read', file_path: 'C:\\work\\README.md' } as never)
    expect(during?.mood).toBe('working')
    expect(during?.isReading).toBe(true)
    expect(during?.detail).toBe('읽는 중: README.md')
    expect(pc.last()?.mood).toBe('thinking')

    await pc.clock.advance(12_000)
    await $.turn.complete({ answer: '고쳤어요', durationMs: 12_000, isAborted: false, turnId: 't1', reason: 'answer' } as never)
    expect(pc.last()?.mood).toBe('done')
    expect(pc.last()?.detail).toBe('다 했어요! 12초 · 도구 1번')
    expect(pc.last()?.at).toBe(NOW + 12_000)
  })

  test('/pet pat and /pet 끄기 send commands; a session end lets go', async ($, on) => {
    const pc = windowsPc(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.command.run({ ...PET, args: 'pat' })
    const pat = pc.last()?.command
    expect(pat?.kind).toBe('pat')
    await pc.clock.advance(1_000)
    await $.command.run({ ...PET, args: '끄기' })
    expect(pc.last()?.command?.kind).toBe('quit')
    expect(pc.last()?.command?.id ?? 0).toBeGreaterThan(pat?.id ?? 0)

    await $.session.end({ reason: 'exit' } as never)
    expect(pc.last()?.alive).toBe(0)
  })

  test('a message the desktop pet leaves goes into this session once', async ($, on) => {
    const pc = windowsPc(on, { text: '시작 전에 있던 메시지' })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    await pc.clock.advance(1_000)
    expect(pc.submitted).toEqual([]) // 시작 전에 있던 것은 넣지 않는다
    pc.post('README 고쳐 줘')
    await pc.clock.advance(1_000)
    expect(pc.submitted).toEqual(['README 고쳐 줘'])
    await pc.clock.advance(3_000)
    expect(pc.submitted).toEqual(['README 고쳐 줘']) // 한 번만
  })

  test('the first question becomes the session title', async ($, on) => {
    const pc = windowsPc(on)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    await $.turn.start({ text: '사용량 띠 글자 키워 줘\n자세히는…', turnId: 't1' } as never)
    expect(pc.last()?.title).toBe('사용량 띠 글자 키워 줘')
  })

  test("the app's session title wins over the first question", async ($, on) => {
    const pc = windowsPc(on)
    on('classic.UserPromptSubmit', () => ({}) as never)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: 'C:\\work' })
    await $.turn.start({ text: '첫 질문', turnId: 't1' } as never)
    await $.classic.UserPromptSubmit({ prompt: '다음 질문', session_title: '모드 폴더 검토 및 펫 모드 적용' } as never)
    expect(pc.last()?.title).toBe('모드 폴더 검토 및 펫 모드 적용')
  })
})
