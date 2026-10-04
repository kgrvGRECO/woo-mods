// Codex 한도를 공식 경로로 받는다: Codex CLI의 앱 서버(`codex app-server`, JSON-RPC over stdio)에
// `account/rateLimits/read`를 묻고 답을 한 줄 JSON으로 출력한다. 인증은 Codex가 스스로 하므로 토큰을 만지지 않는다.
//
// 앱 서버는 표준 입력이 닫히면 답하기 전에 꺼지기 때문에, 입력을 닫는 mods API($.process.run)로는 바로 물을 수
// 없다. 그래서 이 작은 스크립트가 입력을 열어 둔 채 답을 기다렸다가, 입력을 닫아 서버가 스스로 끝나게 한다.
// (Windows에서 codex는 npm의 .cmd 셸 스크립트라 셸을 거쳐 뜨고, 그러면 kill()은 셸만 죽이고 서버는 남는다.
//  입력을 닫는 방식은 셸 너머의 서버까지 닫는다.)
//
//   node codex-limits.mjs   → {"ok":true,"at":<ms>,"result":{…}}  또는  {"ok":false,"error":"…"}

import { spawn, execFileSync } from 'node:child_process'

const ANSWER_TIMEOUT_MS = 15_000
const EXIT_GRACE_MS = 3_000

// 셸을 거칠 때는 인자를 붙인 한 문자열로(고정 문자열뿐이라 안전). POSIX는 바로 실행한다
const isWindows = process.platform === 'win32'
const child = isWindows
  ? spawn('codex app-server', { shell: true, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  : spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] })

let answer = null
let error = null
let exited = false

function output() {
  process.stdout.write(JSON.stringify(answer ? { ok: true, at: Date.now(), result: answer } : { ok: false, error: String(error ?? 'no answer') }) + '\n')
  process.exit(answer ? 0 : 1)
}

/** 서버를 끝낸다: 입력을 닫으면 서버가 스스로 나간다. 그래도 남으면 트리째 끈다 */
function shutdown() {
  try {
    child.stdin.end()
  } catch {
    // 이미 닫혔으면 그만
  }
  setTimeout(() => {
    if (!exited) {
      try {
        if (isWindows) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        else child.kill()
      } catch {
        // 못 끊어도 답은 돌려준다
      }
    }
    output()
  }, EXIT_GRACE_MS).unref()
}

const timer = setTimeout(() => {
  error = 'timeout'
  shutdown()
}, ANSWER_TIMEOUT_MS)

child.on('error', e => {
  error = e
  clearTimeout(timer)
  output()
})
child.on('exit', code => {
  exited = true
  if (answer === null && error === null) error = `app-server exited (${code})`
  clearTimeout(timer)
  output()
})

let buffer = ''
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    if (msg && msg.id === 2 && answer === null && error === null) {
      if (msg.error) error = JSON.stringify(msg.error)
      else answer = msg.result
      clearTimeout(timer)
      shutdown()
    }
  }
})

const send = o => child.stdin.write(JSON.stringify(o) + '\n')
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'usage-band', version: '0.6.5' } } })
send({ method: 'initialized', params: {} })
send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true } })
