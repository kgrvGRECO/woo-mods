# 바탕화면 클로: 투명한 창에 사는 픽셀 펫. Claude Code의 pocket-pet mod가 세션마다 적는
# ~/.claude/clo/sessions/<세션 ID>.json 을 읽고 Claude가 하는 일에 반응한다.
# 세션이 여럿이면 허락을 기다리는 세션이 먼저, 그다음 가장 최근에 바뀐 세션을 따른다.
#
#   마우스 올리기        아래에 입력 카드: 질문을 적고 보내면 Claude 데스크톱 앱에서 이어진다
#                        Code = 고른 폴더에서 새 Claude Code 세션(CLI로 첫 턴을 돌린 뒤 claude://resume 으로 앱에
#                        들여온다), 또는 목록에서 고른 열린 세션에 이어서 보내기
#                        (~/.claude/clo/inbox/<세션 ID>.json 에 남기면 그 세션의 mod가 받아 넣는다)
#                        대화 = 일반 Claude 대화. 말하기 = Windows 음성 입력
#   왼쪽 버튼으로 끌기   옮기기(자리는 다음에도 남는다)
#   왼쪽 클릭            Claude 데스크톱 앱을 앞으로 불러온다(없으면 실행)
#   오른쪽 클릭          메뉴: Claude 열기 · 쓰다듬기 · 말풍선 · 크기 · 끄기
#
# 표준 라이브러리(tkinter)만 쓴다. 그림은 frames/<s|m|l>/<동작>/<번호>.png (tools/make-frames.py).

import glob
import json
import math
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
import uuid
from tkinter import filedialog
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
FRAMES = os.path.join(HERE, 'frames')
HOME = os.path.join(os.path.expanduser('~'), '.claude', 'clo')
SESSIONS = os.path.join(HOME, 'sessions')
INBOX = os.path.join(HOME, 'inbox')  # 열린 세션으로 보낼 메시지
PREFS = os.path.join(HOME, 'desktop.json')
LOCK_PORT = 47533  # 하나만 뜨도록 이 포트를 잡는다

# 새 Code 세션: 앱의 claude://code/new 주소는 작성 화면에 글을 채워 줄 뿐 세션을 만들지 않는다(Enter는 사용자 몫).
# 그래서 Claude Code CLI로 첫 턴을 화면 없이 돌린 뒤 claude://resume?session=<ID> 로 앱에 들여온다(앱이 그 세션을
# 사이드바에 올리고 바로 연다). 화면이 없는 첫 턴은 허락을 물을 수 없어서(고치기·실행은 자동 거부) 아래 안내를 붙인다.
FIRST_TURN_TIMEOUT = 10 * 60.0  # 첫 턴이 이만큼 넘게 걸리면 포기하고 작성 화면으로
FIRST_TURN_NOTE = (
    '이 세션은 바탕화면 펫 "클로"의 입력 카드에서 시작되었습니다. 이 첫 턴은 화면 없이 돌아가고, 끝나는 대로 '
    'Claude 데스크톱 앱에 세션으로 들어가 거기서 이어집니다. 지금은 허락을 물을 수 없어서 파일을 고치거나 명령을 '
    '실행하는 도구는 거부됩니다. 읽기·찾기만으로 답할 수 있으면 지금 바로 답하세요. 파일 수정이나 명령 실행이 '
    '필요하면 하지 말고, 무엇을 어떻게 할지 짧게 정리한 뒤 앱에서 "진행"이라고 하면 시작하겠다고 알려 주세요.'
)

KEY = '#ff00fe'  # 투명으로 쓰는 색(그림에 없는 색)
TICK_MS = 50
FONT = 'Malgun Gothic'  # 둥근모꼴을 못 불러오면 쓰는 글꼴
PIXEL_FONT = 'NeoDunggeunmo'  # fonts/neodgm.ttf (Neo둥근모, SIL OFL 1.1): 16px 픽셀 글꼴
WIN_W_MIN = 360  # 화면 배율 100% 기준
ACCENT = '#d97757'  # Claude 주황
PLACEHOLDER = {'code': '무엇을 맡길까요?', 'chat': '무엇이든 물어보세요'}
# 입력 카드 색: 크림색 카드, 살구빛 테두리, 갈색 글자
CARD = '#fffaf5'
CARD_LINE = '#ecd6c6'
SOFT = '#f4e9e0'  # 토글 바탕·마이크 버튼
SOFT_HOVER = '#ebdbcd'
INK = '#8a6a58'  # 카드 안 흐린 글자·아이콘
ACCENT_HOVER = '#c8643f'

# 동작별 한 프레임 시간(ms)과 재생 순서
CLIPS = {
    'idle': ('idle', 170, None),
    'thinking': ('look', 320, [14, 15, 0, 1, 2, 1, 0, 15]),  # 위쪽을 두리번
    'working': ('running', 95, None),
    'reading': ('review', 170, None),
    'waiting': ('waiting', 150, None),
    'done': ('jumping', 110, None),
    'oops': ('failed', 140, None),
    'sleep': ('failed', 1300, [3, 4]),  # 납작하게 눈 감고 숨쉬기
    'love': ('waving', 150, None),
    'dragL': ('runLeft', 80, None),
    'dragR': ('runRight', 80, None),
}
LINGER = {'done': 10.0, 'oops': 8.0, 'love': 3.0}  # 이만큼 지나면 쉬는 중으로
SLEEP_AFTER = 180.0  # 조용하면 잠든다
QUIT_AFTER = 30 * 60.0  # Claude Code 세션 소식이 이만큼 없으면 스스로 끈다
LOOK_FOR = 4.0  # 마우스가 움직인 뒤 이만큼 눈으로 따라간다
LIVE_FOR = 10 * 60.0  # 이만큼 안에 살아 있다는 표시가 온 세션만 '열린 세션'으로
# 그림 위쪽 투명 여백(점프 자리) 중 머리 꼭대기까지의 비율. 동작마다 머리가 올라가는 높이가 달라
# 말풍선·위쪽 카드는 그 동작에서 머리가 가장 높이 올라가는 곳보다 위에 둔다
HEAD = {'done': 0.0, 'dragL': 0.17, 'dragR': 0.17}  # 점프(완료), 끌기(달리기)
HEAD_REST = 0.25  # 나머지 동작
HOVER_OPEN = 0.3  # 이만큼 올려 두면 입력 영역이 열린다
HOVER_CLOSE = 1.0  # 마우스가 떠난 뒤 이만큼 지나면 닫힌다(입력 중이면 열어 둔다)

# Claude 데스크톱 앱: Microsoft Store 판(MSIX)의 앱 ID, 그다음 claude:// 주소로 연다
CLAUDE_APP_IDS = ['Claude_pzs8sxrjxfjjc!Claude']
CLAUDE_EXE_HINTS = ('\\windowsapps\\claude_', '\\anthropicclaude\\')  # 데스크톱 앱 실행 파일 경로(CLI claude.exe는 제외)


def claude_windows():
    """열려 있는 Claude 데스크톱 앱의 큰 창들(넓이 순)"""
    import ctypes
    from ctypes import wintypes
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    found = []
    paths = {}

    def exe_of(pid):
        if pid not in paths:
            path = ''
            h = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if h:
                buf = ctypes.create_unicode_buffer(1024)
                size = wintypes.DWORD(1024)
                if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                    path = buf.value.lower()
                kernel32.CloseHandle(h)
            paths[pid] = path
        return paths[pid]

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        # 보이는 창 중 제목이 있고 다른 창에 딸리지 않은 것(트레이로 숨은 앱은 아래에서 다시 실행해 깨운다)
        if not user32.IsWindowVisible(hwnd) or user32.GetWindowTextLengthW(hwnd) == 0 or user32.GetWindow(hwnd, 4):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if any(h in exe_of(pid.value) for h in CLAUDE_EXE_HINTS):
            r = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(r))
            found.append(((r.right - r.left) * (r.bottom - r.top), hwnd))
        return True

    user32.EnumWindows(each, 0)
    return [h for _, h in sorted(found, reverse=True)]


def open_claude():
    """Claude 데스크톱 앱 창을 앞으로. 창이 없으면 앱을 실행한다"""
    if sys.platform != 'win32':
        return False
    import ctypes
    user32 = ctypes.windll.user32
    try:
        for hwnd in claude_windows():
            if user32.IsIconic(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
            if user32.SetForegroundWindow(hwnd):
                return True
    except Exception:
        pass
    for target in [f'shell:AppsFolder\\{a}' for a in CLAUDE_APP_IDS] + ['claude://']:
        try:
            os.startfile(target)
            return True
        except OSError:
            continue
    return False


def new_session_url(mode, text, folder=None):
    """새 세션 주소. code = Claude Code 새 세션 작성 화면(폴더 지정, 글만 채워짐), chat = 일반 Claude 대화"""
    if mode == 'code':
        url = 'claude://code/new?q=' + quote(text, safe='')
        return url + ('&folder=' + quote(folder, safe='') if folder else '')
    # 대화 주소는 q만 받고, '/'로 시작하는 글은 받지 않는다
    return 'claude://claude.ai/new?q=' + quote(text.lstrip('/ ') or text, safe='')


def resume_url(session_id):
    """CLI 세션을 Claude 데스크톱 앱의 세션으로 들여오는 주소(호스트가 resume, code/resume 이 아니다)"""
    return 'claude://resume?session=' + quote(session_id, safe='')


def claude_cli(preferred=None):
    """Claude Code CLI 실행 파일. 설정(desktop.json의 claude) → PATH의 claude → 데스크톱 앱이 내려받은 것 순"""
    if preferred and os.path.isfile(preferred):
        return preferred
    found = shutil.which('claude')
    if found:
        return found
    bundled = glob.glob(os.path.join(os.environ.get('APPDATA', ''), 'Claude', 'claude-code', '*', '*', 'claude.exe'))
    return max(bundled, key=os.path.getmtime) if bundled else None


def run_first_turn(cli, job):
    """(다른 스레드) 고른 폴더에서 CLI로 첫 턴을 돌린다. 끝나면 job['exit']에 결과(0이면 성공)"""
    argv = [cli, '-p', job['text'], '--session-id', job['id'], '--append-system-prompt', FIRST_TURN_NOTE]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0) if sys.platform == 'win32' else 0
    proc = None
    try:
        proc = subprocess.Popen(argv, cwd=job['folder'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.PIPE, creationflags=flags)
        job['proc'] = proc
        _, err = proc.communicate(timeout=FIRST_TURN_TIMEOUT)
        job['error'] = (err or b'').decode('utf-8', 'replace').strip()[-300:]
        job['exit'] = proc.returncode
    except subprocess.TimeoutExpired:
        proc.kill()
        job['error'] = '시간 초과'
        job['exit'] = 'timeout'
    except Exception as ex:
        job['error'] = str(ex)
        job['exit'] = 'error'


def voice_typing():
    """Windows 음성 입력(Win+H): 지금 포커스가 있는 칸에 받아 적는다"""
    if sys.platform != 'win32':
        return
    import ctypes
    user32 = ctypes.windll.user32
    VK_LWIN, VK_H, UP = 0x5B, 0x48, 0x0002
    user32.keybd_event(VK_LWIN, 0, 0, 0)
    user32.keybd_event(VK_H, 0, 0, 0)
    user32.keybd_event(VK_H, 0, UP, 0)
    user32.keybd_event(VK_LWIN, 0, UP, 0)


def load_pixel_font():
    """fonts/neodgm.ttf를 이 프로그램 안에서만 불러온다(Windows에 설치하지 않음). 되면 True"""
    path = os.path.join(HERE, 'fonts', 'neodgm.ttf')
    if sys.platform != 'win32' or not os.path.exists(path):
        return False
    try:
        import ctypes
        return ctypes.windll.gdi32.AddFontResourceExW(path, 0x10, 0) > 0  # FR_PRIVATE
    except Exception:
        return False


def load_json(path, fallback):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


def save_json(path, value):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(value, f, ensure_ascii=False)
        os.replace(tmp, path)
    except Exception:
        pass


def duration_text(sec):
    s = max(1, round(sec))
    return f'{s}초' if s < 60 else f'{s // 60}분 {s % 60}초'


class Pet:
    def __init__(self, root):
        self.root = root
        # 화면 배율(100% = 1.0). 크기와 여백을 여기에 맞춘다
        self.dpi = max(1.0, root.winfo_fpixels('1i') / 96)
        # 자리는 발 위치(그림 아래 가운데)로 남긴다: 창 크기가 바뀌어도 클로는 그 자리에 선다
        self.prefs = {'size': 'm', 'bubble': True, 'fx': None, 'fy': None, 'mode': 'code', 'folder': None, 'folders': []}
        self.prefs.update(load_json(PREFS, {}))
        # 글꼴: 둥근모꼴(16px 픽셀 글꼴)을 화면 배율 100% 기준 14px로(배율 200%면 28px). 굵은 글꼴은 없어서 쓰지 않는다
        self.is_pixel = load_pixel_font()
        if self.is_pixel:
            px = -round(14 * self.dpi)
            self.fonts = {'bubble': (PIXEL_FONT, px), 'entry': (PIXEL_FONT, px), 'chip': (PIXEL_FONT, px), 'bold': (PIXEL_FONT, px)}
        else:
            self.fonts = {'bubble': (FONT, 9), 'entry': (FONT, 10), 'chip': (FONT, 9), 'bold': (FONT, 9, 'bold')}
        f = self.fonts['bubble']
        self.font = tkfont.Font(root=root, family=f[0], size=f[1])
        self.line_h = self.font.metrics('linespace')
        self.bubble_h = self.line_h * 2 + int(30 * self.dpi)  # 두 줄 + 안쪽 여백 + 꼬리
        self.meta = load_json(os.path.join(FRAMES, 'meta.json'), {})
        self.state = {}
        self.sessions = {}  # 파일 이름 → (수정 시각, 내용)
        self.last_command = 0
        self.started = time.time()
        self.love_until = 0.0
        self.say_until, self.say_text = 0.0, ''
        self.last_poke = time.time()  # 마지막으로 무슨 일이 있었던 때
        self.pointer = (0, 0)
        self.pointer_moved = 0.0
        self.drag = None  # (시작 포인터 x, y, 창 x, y, 움직였는지, 방향)
        self.clip_key = None
        self.clip_started = time.time()
        self.hover_since = None
        self.away_since = None
        self.panel_open = False
        self.panel_above = False
        self.dropdown = None  # 폴더 목록 창
        self.dropdown_box = (0, 0, 0, 0)
        self.jobs = []  # 첫 턴이 도는 중인 새 Code 세션들(start_session → check_jobs)

        root.overrideredirect(True)
        root.attributes('-topmost', True)
        root.configure(bg=KEY)
        try:
            root.attributes('-transparentcolor', KEY)
        except tk.TclError:
            pass
        self.canvas = tk.Canvas(root, bg=KEY, highlightthickness=0, bd=0)
        self.canvas.pack(fill='both', expand=True)

        self.menu = tk.Menu(root, tearoff=0)
        self.menu.add_command(label='Claude 열기', command=open_claude)
        self.menu.add_command(label='쓰다듬기', command=self.pat)
        self.bubble_var = tk.BooleanVar(value=bool(self.prefs.get('bubble', True)))
        self.menu.add_checkbutton(label='말풍선 보이기', variable=self.bubble_var, command=self.toggle_bubble)
        sizes = tk.Menu(self.menu, tearoff=0)
        self.size_var = tk.StringVar(value=self.prefs.get('size', 'm'))
        for tag, label in (('s', '작게'), ('m', '보통'), ('l', '크게')):
            sizes.add_radiobutton(label=label, value=tag, variable=self.size_var, command=lambda t=tag: self.set_size(t))
        self.menu.add_cascade(label='크기', menu=sizes)
        self.menu.add_separator()
        self.menu.add_command(label='끄기', command=self.quit)

        self.canvas.bind('<ButtonPress-1>', self.on_press)
        self.canvas.bind('<B1-Motion>', self.on_drag)
        self.canvas.bind('<ButtonRelease-1>', self.on_release)
        self.canvas.bind('<Button-3>', self.on_menu)

        self.build_panel()
        self.load_frames(self.prefs.get('size', 'm'))
        self.place_initially()
        self.read_state()
        # 숨긴 채로 실행돼도(Start-Process -WindowStyle Hidden 등) 보이게
        root.deiconify()
        root.lift()
        self.tick()

    # ── 입력 영역 ────────────────────────────────────────────────────
    # 캔버스에 직접 그린다: 크림색 둥근 카드(클로 쪽 꼬리), 알약 모양 Code/대화 토글, 폴더 칩,
    # 둥근 입력칸 안의 동그란 마이크·보내기 버튼. 입력칸만 Tk Entry를 얹는다.
    def build_panel(self):
        self.mode = self.prefs.get('mode') if self.prefs.get('mode') in ('code', 'chat') else 'code'
        font = lambda k: tkfont.Font(root=self.root, family=self.fonts[k][0], size=self.fonts[k][1],
                                     weight=self.fonts[k][2] if len(self.fonts[k]) > 2 else 'normal')
        self.entry_font, self.chip_font, self.bold_font = font('entry'), font('chip'), font('bold')
        self.entry = tk.Entry(self.canvas, font=self.entry_font, relief='flat', bd=0, bg='#ffffff', fg='#3a2e27',
                              insertbackground=ACCENT, highlightthickness=0)
        self.entry.bind('<Button-1>', self.focus_entry)
        self.entry.bind('<FocusIn>', lambda e: (self.placeholder(False), self.focus_ring(True)))
        self.entry.bind('<FocusOut>', lambda e: (self.placeholder(True), self.focus_ring(False)))
        self.entry.bind('<Return>', lambda e: self.send())
        self.entry.bind('<Escape>', lambda e: self.close_panel())
        self.is_placeholder = False
        self.placeholder(True)
        c = self.canvas
        c.tag_bind('seg_code', '<Button-1>', lambda e: self.set_mode('code'))
        c.tag_bind('seg_chat', '<Button-1>', lambda e: self.set_mode('chat'))
        c.tag_bind('folder', '<Button-1>', self.pick_folder)
        c.tag_bind('mic', '<Button-1>', lambda e: self.speak())
        c.tag_bind('send', '<Button-1>', lambda e: self.send())
        for tag, base, hover in (('mic', SOFT, SOFT_HOVER), ('send', ACCENT, ACCENT_HOVER)):
            c.tag_bind(tag, '<Enter>', lambda e, t=tag, h=hover: c.itemconfigure(t + '_bg', fill=h))
            c.tag_bind(tag, '<Leave>', lambda e, t=tag, b=base: c.itemconfigure(t + '_bg', fill=b))
        for tag in ('seg_code', 'seg_chat', 'folder', 'mic', 'send'):
            c.tag_bind(tag, '<Enter>', lambda e: c.configure(cursor='hand2'), add='+')
            c.tag_bind(tag, '<Leave>', lambda e: c.configure(cursor=''), add='+')

    def set_mode(self, mode, save=True):
        self.mode = mode
        self.placeholder(self.root.focus_get() is not self.entry)
        if self.panel_open:
            self.layout_panel()
        if save:
            self.prefs['mode'] = mode
            save_json(PREFS, self.prefs)

    def focus_ring(self, on):
        self.canvas.itemconfigure('input_bg', outline=ACCENT if on else CARD_LINE)

    def placeholder(self, show):
        """비어 있는 칸에는 흐린 안내 글"""
        text = '이 세션에 이어서 말하기' if self.mode == 'code' and self.target_session() else PLACEHOLDER[self.mode]
        if show and not self.entry.get():
            self.entry.insert(0, text)
            self.entry.configure(fg='#a3a8af')
            self.is_placeholder = True
        elif not show and self.is_placeholder:
            self.entry.delete(0, 'end')
            self.entry.configure(fg='#2b2b2b')
            self.is_placeholder = False
        elif show and self.is_placeholder:
            self.entry.delete(0, 'end')
            self.entry.insert(0, text)

    def focus_entry(self, _=None):
        self.root.focus_force()
        self.entry.focus_set()

    def text(self):
        return '' if self.is_placeholder else self.entry.get().strip()

    def live_sessions(self):
        """지금 열려 있는 Claude Code 세션(최근에 움직인 것 먼저): [(세션 ID, 상태 파일 내용)]"""
        now = time.time()
        out = []
        for name, (_, v) in self.sessions.items():
            alive = (v.get('alive') or 0) / 1000
            if alive and now - alive < LIVE_FOR and v.get('canReceive'):  # 메시지를 받을 수 있는 세션만
                out.append((name[:-5], v))
        out.sort(key=lambda kv: -max(kv[1].get('at') or 0, kv[1].get('alive') or 0))
        return out[:6]

    def target_session(self):
        """이어서 보낼 세션(골라 두었고 아직 열려 있으면): (ID, 내용) 또는 None"""
        sid = self.prefs.get('session')
        return next(((i, v) for i, v in self.live_sessions() if i == sid), None) if sid else None

    @staticmethod
    def session_label(v):
        """세션 이름: 첫 질문(제목), 없으면 폴더 이름"""
        cwd = (v.get('cwd') or '').rstrip('\\/')
        return v.get('title') or os.path.basename(cwd) or '세션'

    @staticmethod
    def mood_color(v):
        mood = v.get('mood')
        return ACCENT if mood in ('working', 'thinking') else '#e0a800' if mood == 'waiting' else '#7fb069'

    def choose_session(self, sid):
        self.close_dropdown()
        self.prefs['session'] = sid
        save_json(PREFS, self.prefs)
        self.set_mode(self.mode, save=False)
        self.focus_entry()

    def known_folders(self):
        """최근 세션 폴더(가장 최근 먼저) + 전에 고른 폴더"""
        seen = []
        for _, v in sorted(self.sessions.values(), key=lambda kv: -(kv[1].get('alive') or 0)):
            cwd = v.get('cwd')
            if isinstance(cwd, str) and cwd and cwd not in seen:
                seen.append(cwd)
        for f in self.prefs.get('folders') or []:
            if f not in seen:
                seen.append(f)
        return seen[:10]

    def folder(self):
        f = self.prefs.get('folder')
        if isinstance(f, str) and f:
            return f
        known = self.known_folders()
        return known[0] if known else None

    def folder_name(self):
        f = self.folder()
        return os.path.basename(f.rstrip('\\/')) or f if f else '고르기'

    # ── 폴더 목록: 클로 스타일로 그린 작은 창(크림색 카드, 둥근모꼴) ──
    def pick_folder(self, e=None):
        if self.dropdown is not None:
            self.close_dropdown()
            return
        d = self.dpi
        u = lambda v: int(round(v * d))
        target = self.target_session()
        current = None if target else self.folder()
        sessions = self.live_sessions()
        folders = []
        for f in self.known_folders():
            path = f.rstrip('\\/')
            folders.append((f, os.path.basename(path) or f, os.path.basename(os.path.dirname(path))))

        top = tk.Toplevel(self.root)
        top.overrideredirect(True)
        top.attributes('-topmost', True)
        top.configure(bg=KEY)
        try:
            top.attributes('-transparentcolor', KEY)
        except tk.TclError:
            pass
        cv = tk.Canvas(top, bg=KEY, highlightthickness=0, bd=0)
        cv.pack()
        px0, py0, pw, ph = self.panel_box()  # 입력 카드와 같은 너비로, 카드 가장자리에 붙인다
        w, pad, row_h, head_h, sep = pw, u(8), u(38), u(26), u(10)
        # 줄 구성: (종류, …)
        lines = []
        if sessions:
            lines.append(('head', '열린 세션에 이어서'))
            lines += [('session', sid, v) for sid, v in sessions]
            lines.append(('sep',))
            lines.append(('head', '새 세션 폴더'))
        lines += [('folder',) + f for f in folders]
        if folders:
            lines.append(('sep',))
        lines.append(('browse',))
        hgt = {'head': head_h, 'sep': sep}
        h = pad * 2 + sum(hgt.get(line[0], row_h) for line in lines)
        cv.configure(width=w, height=h)
        self.rounded(1, 1, w - 2, h - 2, u(16), fill=CARD, outline=CARD_LINE, width=max(1, u(1)), cv=cv)

        def row(i, y0, label, sub, color, on_click, is_current=False, icon='folder', dot=None):
            tag = f'row{i}'
            bg = self.rounded(pad, y0 + u(2), w - pad, y0 + row_h - u(2), u(12), fill=SOFT if is_current else CARD, outline='', tags=(tag,), cv=cv)
            cy = y0 + row_h / 2
            ix = pad + u(14)
            if icon == 'folder':
                cv.create_polygon(ix, cy - u(5), ix + u(5), cy - u(5), ix + u(6), cy - u(4), ix + u(12), cy - u(4),
                                  ix + u(12), cy + u(5), ix, cy + u(5), fill=ACCENT if is_current else INK, outline='', tags=(tag,))
            elif icon == 'dot':  # 세션: 상태 점(작업 중 주황, 허락 대기 노랑, 쉬는 중 초록)
                cv.create_oval(ix + u(2), cy - u(4), ix + u(10), cy + u(4), fill=dot, outline='', tags=(tag,))
            else:  # 더하기
                cv.create_line(ix + u(6), cy - u(6), ix + u(6), cy + u(6), fill=ACCENT, width=max(2, u(2)), tags=(tag,))
                cv.create_line(ix, cy, ix + u(12), cy, fill=ACCENT, width=max(2, u(2)), tags=(tag,))
            # 오른쪽 작은 글자(상위 폴더·세션 폴더)는 늘 보이고(길면 줄 너비의 40%까지), 이름은 남은 자리에 맞춰 …로 줄인다
            room = (w - pad - u(12)) - (ix + u(22))
            if sub:
                sub = self.fit(sub, self.chip_font, int(room * 0.4))
            sub_w = self.chip_font.measure(sub) + u(14) if sub else 0
            label = self.fit(label, self.entry_font, room - sub_w)
            cv.create_text(ix + u(22), cy, text=label, anchor='w', font=self.entry_font, fill=color, tags=(tag,))
            if sub:
                cv.create_text(w - pad - u(12), cy, text=sub, anchor='e', font=self.chip_font, fill='#b49a8a', tags=(tag,))
            cv.tag_bind(tag, '<Button-1>', lambda e: on_click())
            cv.tag_bind(tag, '<Enter>', lambda e: (cv.itemconfigure(bg, fill=SOFT_HOVER if not is_current else SOFT), cv.configure(cursor='hand2')))
            cv.tag_bind(tag, '<Leave>', lambda e: (cv.itemconfigure(bg, fill=SOFT if is_current else CARD), cv.configure(cursor='')))

        y = pad
        for i, line in enumerate(lines):
            kind = line[0]
            if kind == 'head':
                cv.create_text(pad + u(14), y + head_h / 2 + u(2), text=line[1], anchor='w', font=self.chip_font, fill='#b49a8a')
                y += head_h
            elif kind == 'sep':
                cv.create_line(pad + u(10), y + sep / 2, w - pad - u(10), y + sep / 2, fill=CARD_LINE, width=max(1, u(1)))
                y += sep
            elif kind == 'session':
                sid, v = line[1], line[2]
                on = target is not None and target[0] == sid
                cwd = (v.get('cwd') or '').rstrip('\\/')
                if v.get('title'):
                    sub = os.path.basename(cwd)
                else:  # 제목이 아직 없으면 마지막 활동 시각으로 구분
                    ago = time.time() - max(v.get('at') or 0, v.get('alive') or 0) / 1000
                    sub = '방금' if ago < 60 else f'{int(ago // 60)}분 전'
                row(i, y, self.session_label(v), sub, ACCENT if on else '#3a2e27', lambda sid=sid: self.choose_session(sid),
                    is_current=on, icon='dot', dot=self.mood_color(v))
                y += row_h
            elif kind == 'folder':
                path, name, parent = line[1], line[2], line[3]
                on = path == current
                row(i, y, name, parent, ACCENT if on else '#3a2e27', lambda p=path: self.choose_folder(p), is_current=on)
                y += row_h
            else:
                row(i, y, '다른 폴더 고르기…', '', ACCENT, self.browse_from_dropdown, icon='plus')
                y += row_h

        # 카드 바로 아래(화면 아래가 모자라면 카드 위)에, 카드와 같은 너비로
        rx, ry = self.root.winfo_x(), self.root.winfo_y()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        sx = max(0, min(sw - w, rx + px0))
        sy = ry + py0 + ph + u(6)
        if sy + h > sh - u(48):
            sy = ry + py0 - h - u(6)
        top.geometry(f'{w}x{h}+{sx}+{sy}')
        top.bind('<Escape>', lambda e: self.close_dropdown())
        top.focus_force()
        self.dropdown, self.dropdown_box = top, (sx, sy, w, h)

    @staticmethod
    def fit(text, font, max_w):
        """max_w에 들어가게 끝을 …로 줄인다"""
        if font.measure(text) <= max_w:
            return text
        while len(text) > 1 and font.measure(text + '…') > max_w:
            text = text[:-1]
        return text + '…'

    def close_dropdown(self):
        if self.dropdown is not None:
            self.dropdown.destroy()
            self.dropdown = None

    def choose_folder(self, path):
        self.close_dropdown()
        self.use_folder(path)
        self.focus_entry()

    def browse_from_dropdown(self):
        self.close_dropdown()
        self.browse_folder()

    def browse_folder(self):
        f = filedialog.askdirectory(parent=self.root, initialdir=self.folder() or os.path.expanduser('~'), title='Claude Code를 시작할 폴더')
        if f:
            self.use_folder(os.path.normpath(f))

    def use_folder(self, f):
        self.prefs['session'] = None  # 폴더를 고르면 새 세션으로
        self.prefs['folder'] = f
        self.prefs['folders'] = [f] + [x for x in self.prefs.get('folders') or [] if x != f][:9]
        save_json(PREFS, self.prefs)
        self.set_mode(self.mode, save=False)

    def speak(self):
        self.focus_entry()
        self.placeholder(False)
        self.root.after(150, voice_typing)

    def send(self):
        text = self.text()
        if not text:
            self.focus_entry()
            return
        target = self.target_session() if self.mode == 'code' else None
        if target:
            # 그 세션의 mod가 1초 안에 받아 사용자 입력처럼 넣는다
            now_ms = int(time.time() * 1000)
            save_json(os.path.join(INBOX, f'{target[0]}.json'), {'id': now_ms, 'text': text, 'at': now_ms})
            open_claude()
            done = f'{self.session_label(target[1])}에 보냈어요!'
        elif self.mode == 'code':
            done = self.start_session(text, self.folder())
            if not done:
                return
        else:
            try:
                os.startfile(new_session_url('chat', text))
            except OSError:
                self.say('Claude 앱을 열지 못했어요')
                return
            done = '새 대화를 열었어요!'
        self.entry.delete(0, 'end')
        self.close_panel()
        self.say(done, 6.0)
        self.pat()

    def start_session(self, text, folder):
        """고른 폴더에서 새 Code 세션. CLI로 첫 턴을 화면 없이 돌린 뒤(check_jobs) 앱에 들여온다.
        CLI가 없으면 앱의 새 세션 작성 화면(글만 채워진)을 연다. 말풍선에 쓸 글을 돌려주고, 못 열면 None"""
        folder = folder if folder and os.path.isdir(folder) else os.path.expanduser('~')
        cli = claude_cli(self.prefs.get('claude'))
        if not cli:
            return self.open_composer(text, folder, 'Claude Code CLI가 없어서 작성 화면만 열었어요. Enter로 시작하세요')
        job = {'id': str(uuid.uuid4()), 'text': text, 'folder': folder, 'started': time.time(), 'proc': None, 'exit': None, 'error': ''}
        threading.Thread(target=run_first_turn, args=(cli, job), daemon=True).start()
        self.jobs.append(job)
        return '세션을 여는 중… 첫 답이 오면 앱에서 열려요'

    def open_composer(self, text, folder, done):
        """앱의 새 세션 작성 화면을 그 폴더로 열고 글을 채운다(세션은 사용자가 Enter를 눌러야 생긴다)"""
        try:
            os.startfile(new_session_url('code', text, folder))
        except OSError:
            self.say('Claude 앱을 열지 못했어요')
            return None
        return done

    def check_jobs(self):
        """첫 턴이 끝난 세션을 앱에 들여온다. 실패하면 작성 화면으로"""
        for job in [j for j in self.jobs if j['exit'] is not None]:
            self.jobs.remove(job)
            if job['exit'] == 0:
                try:
                    os.startfile(resume_url(job['id']))
                    self.say('새 Code 세션을 열었어요!', 6.0)
                    self.pat()
                    continue
                except OSError:
                    self.say('Claude 앱을 열지 못했어요', 6.0)
                    continue
            why = '시간이 너무 걸려서' if job['exit'] == 'timeout' else '첫 턴이 실패해서'
            done = self.open_composer(job['text'], job['folder'], f'{why} 작성 화면을 열었어요. Enter로 시작하세요')
            if done:
                self.say(done, 8.0)
                self.last_poke = time.time()

    def say(self, text, sec=4.0):
        self.say_text, self.say_until = text, time.time() + sec

    def open_panel(self):
        if self.panel_open:
            return
        self.panel_open = True
        self.set_mode(self.mode, save=False)  # 폴더 목록이 바뀌었을 수 있다
        self.layout_panel()

    def close_panel(self):
        self.close_dropdown()
        if not self.panel_open:
            return
        self.panel_open = False
        self.canvas.delete('panel')
        self.hover_since = self.away_since = None
        if self.root.focus_get() is self.entry:
            self.root.focus_set()
        self.placeholder(True)

    def panel_box(self):
        """입력 카드의 자리(캔버스 좌표): 발 아래, 화면 아래가 모자라면 머리 위"""
        d = self.dpi
        margin = int(10 * d)
        # 창이 화면 끝에 걸쳐 있으면 보이는 쪽 안에서만
        wx = self.root.winfo_x()
        lo = max(margin, -wx + margin)
        hi = min(self.win_w - margin, self.root.winfo_screenwidth() - wx - margin)
        w = min(int(320 * d), self.win_w - 2 * margin, hi - lo)
        x = max(lo, min(hi - w, self.win_w // 2 - w // 2))
        h = self.panel_h
        sh = self.root.winfo_screenheight()
        foot_screen = self.root.winfo_y() + self.foot_y
        gap = self.panel_gap  # 꼬리 자리
        self.panel_above = foot_screen + gap + h > sh - int(48 * d)  # 작업 표시줄 자리
        head = self.foot_y - self.sprite_h + int(self.sprite_h * HEAD.get(getattr(self, 'key', 'idle'), HEAD_REST))  # 머리 꼭대기
        y = head - gap - h if self.panel_above else self.foot_y + gap
        return x, max(0, y), w, h

    def rounded(self, x0, y0, x1, y1, r, cv=None, **kw):
        """둥근 사각형(r이 높이의 절반이면 알약)"""
        r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
        pts = [x0 + r, y0, x1 - r, y0, x1, y0, x1, y0 + r, x1, y1 - r, x1, y1,
               x1 - r, y1, x0 + r, y1, x0, y1, x0, y1 - r, x0, y0 + r, x0, y0]
        return (cv or self.canvas).create_polygon(pts, smooth=True, **kw)

    def layout_panel(self):
        c = self.canvas
        c.delete('panel')
        d = self.dpi
        u = lambda v: int(round(v * d))
        x, y, w, h = self.panel_box()
        T = ('panel',)

        # 카드 + 클로 쪽 꼬리
        self.rounded(x, y, x + w, y + h, u(18), fill=CARD, outline=CARD_LINE, width=max(1, u(1)), tags=T)
        tx = max(x + u(24), min(x + w - u(24), self.win_w // 2))
        if self.panel_above:
            c.create_polygon(tx - u(8), y + h - 1, tx + u(8), y + h - 1, tx, y + h + u(8), fill=CARD, outline='', tags=T)
            c.create_line(tx - u(8), y + h, tx, y + h + u(8), tx + u(8), y + h, fill=CARD_LINE, width=max(1, u(1)), tags=T)
        else:
            c.create_polygon(tx - u(8), y + 1, tx + u(8), y + 1, tx, y - u(8), fill=CARD, outline='', tags=T)
            c.create_line(tx - u(8), y, tx, y - u(8), tx + u(8), y, fill=CARD_LINE, width=max(1, u(1)), tags=T)

        # 윗줄: Code / 대화 알약 토글
        pad = u(12)
        row1 = y + pad
        seg_w, seg_h = u(54), u(26)
        self.rounded(x + pad, row1, x + pad + 2 * seg_w + u(6), row1 + seg_h, seg_h / 2, fill=SOFT, outline='', tags=T)
        for i, (mode, label) in enumerate((('code', 'Code'), ('chat', '대화'))):
            sx = x + pad + u(3) + i * seg_w
            on = self.mode == mode
            tag = ('panel', 'seg_' + mode)
            if on:
                self.rounded(sx, row1 + u(3), sx + seg_w, row1 + seg_h - u(3), (seg_h - u(6)) / 2, fill=ACCENT, outline='', tags=tag)
            else:  # 빈 자리도 눌리게
                self.rounded(sx, row1 + u(3), sx + seg_w, row1 + seg_h - u(3), (seg_h - u(6)) / 2, fill=SOFT, outline='', tags=tag)
            c.create_text(sx + seg_w / 2, row1 + seg_h / 2, text=label, font=self.bold_font,
                          fill='#ffffff' if on else INK, tags=tag)

        # 윗줄 오른쪽: 폴더 칩(Code) 또는 안내(대화)
        right = x + w - pad
        if self.mode == 'code':
            # 칩은 토글 오른쪽 남은 자리까지만: 폴더 이름이 길면 …로 줄여 토글을 덮지 않게
            toggle_end = x + pad + 2 * seg_w + u(6)
            room = right - toggle_end - u(12) - u(32) - self.chip_font.measure(' ▾')
            target = self.target_session()
            name = self.session_label(target[1]) if target else self.folder_name()
            label = self.fit(name, self.chip_font, max(u(30), room)) + ' ▾'
            tw = self.chip_font.measure(label)
            chip_w = tw + u(32)
            cx0 = right - chip_w
            self.rounded(cx0, row1 + u(2), right, row1 + seg_h - u(2), (seg_h - u(4)) / 2, fill=SOFT if target else CARD,
                         outline=CARD_LINE, width=max(1, u(1)), tags=('panel', 'folder'))
            fx, fy = cx0 + u(10), row1 + seg_h / 2
            if target:  # 열린 세션: 상태 점
                c.create_oval(fx + u(1), fy - u(4), fx + u(9), fy + u(4), fill=self.mood_color(target[1]), outline='',
                              tags=('panel', 'folder'))
            else:  # 새 세션: 작은 폴더 아이콘
                c.create_polygon(fx, fy - u(4), fx + u(4), fy - u(4), fx + u(5), fy - u(3), fx + u(10), fy - u(3),
                                 fx + u(10), fy + u(4), fx, fy + u(4), fill=INK, outline='', tags=('panel', 'folder'))
            c.create_text(cx0 + u(24), fy, text=label, anchor='w', font=self.chip_font, fill=INK, tags=('panel', 'folder'))
        else:
            c.create_text(right, row1 + seg_h / 2, text='새 대화로 열어요', anchor='e', font=self.chip_font, fill=INK, tags=T)

        # 아랫줄: 둥근 입력칸 + 마이크 + 보내기
        row2 = row1 + seg_h + u(10)
        ih = u(40)
        x0, x1 = x + pad, x + w - pad
        focused = self.root.focus_get() is self.entry
        self.rounded(x0, row2, x1, row2 + ih, ih / 2, fill='#ffffff', outline=ACCENT if focused else CARD_LINE,
                     width=max(1, u(1.5)), tags=('panel', 'input_bg'))
        btn = u(30)
        by = row2 + ih / 2
        send_cx = x1 - u(5) - btn / 2
        mic_cx = send_cx - btn - u(6)
        # 마이크: 동그란 바탕 + 캡슐 + 받침
        c.create_oval(mic_cx - btn / 2, by - btn / 2, mic_cx + btn / 2, by + btn / 2, fill=SOFT, outline='', tags=('panel', 'mic', 'mic_bg'))
        self.rounded(mic_cx - u(3.5), by - u(8), mic_cx + u(3.5), by + u(2), u(3.5), fill=INK, outline='', tags=('panel', 'mic'))
        c.create_arc(mic_cx - u(6), by - u(6), mic_cx + u(6), by + u(5), start=200, extent=140, style='arc', outline=INK,
                     width=max(1, u(1.5)), tags=('panel', 'mic'))
        c.create_line(mic_cx, by + u(5), mic_cx, by + u(8), fill=INK, width=max(1, u(1.5)), tags=('panel', 'mic'))
        # 보내기: 주황 동그라미 + 위 화살표
        c.create_oval(send_cx - btn / 2, by - btn / 2, send_cx + btn / 2, by + btn / 2, fill=ACCENT, outline='', tags=('panel', 'send', 'send_bg'))
        c.create_line(send_cx, by + u(6), send_cx, by - u(6), fill='#ffffff', width=max(2, u(2)), capstyle='round', tags=('panel', 'send'))
        c.create_line(send_cx - u(5), by - u(1), send_cx, by - u(6), send_cx + u(5), by - u(1), fill='#ffffff', width=max(2, u(2)),
                      capstyle='round', joinstyle='round', tags=('panel', 'send'))
        # 입력칸(Entry)은 왼쪽 여백부터 마이크 앞까지
        ex0 = x0 + u(16)
        ex1 = mic_cx - btn / 2 - u(8)
        c.create_window(ex0, by, window=self.entry, anchor='w', width=max(u(60), ex1 - ex0), height=u(24), tags=T)

    # ── 그림 ─────────────────────────────────────────────────────────
    # 크기는 화면 배율 100% 기준(작게 0.5 · 보통 0.75 · 크게 1.0배)이고, 배율이 높은 화면에서는
    # 준비된 세 크기 가운데 가장 가까운 것을 정수배로 키워 픽셀이 흐려지지 않게 한다.
    SCALE = {'s': 0.5, 'm': 0.75, 'l': 1.0}

    def load_frames(self, size):
        if size not in self.SCALE:
            size = 'm'
        self.size = size
        want = self.SCALE[size] * self.dpi
        src, zoom = min(((t, z) for t in self.SCALE for z in (1, 2, 3)), key=lambda c: abs(self.SCALE[c[0]] * c[1] - want))
        self.images = {}
        for anim, count in self.meta.get('frames', {}).items():
            frames = []
            for i in range(count):
                img = tk.PhotoImage(file=os.path.join(FRAMES, src, anim, f'{i:02d}.png'))
                frames.append(img.zoom(zoom) if zoom > 1 else img)
            self.images[anim] = frames
        w, h = self.meta.get('sizes', {}).get(src, [140, 134])
        self.sprite_w, self.sprite_h = w * zoom, h * zoom
        self.win_w = max(int(WIN_W_MIN * self.dpi), self.sprite_w + 40)
        # 창: [말풍선·위쪽 입력 영역] [클로] [아래쪽 입력 영역]
        self.panel_h = int(round(100 * self.dpi))  # 윗줄 26 + 아랫줄 40 + 여백
        # 카드와 클로 사이(꼬리) 틈 + 테두리·여유. 위로 열릴 때도 아래로 열릴 때도 잘리지 않게
        self.panel_gap = int(12 * self.dpi)
        room = self.panel_gap + self.panel_h + int(6 * self.dpi)
        top = max(self.bubble_h, room)
        self.foot_y = top + self.sprite_h
        self.win_h = self.foot_y + room
        self.canvas.config(width=self.win_w, height=self.win_h)
        if self.panel_open:
            self.layout_panel()

    def foot(self):
        """지금 발 위치(화면 좌표)"""
        return self.root.winfo_x() + self.win_w // 2, self.root.winfo_y() + self.foot_y

    def stand_at(self, fx, fy):
        """발이 (fx, fy)에 오도록 창을 놓는다. 클로가 화면 밖으로 나가지 않게"""
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        half = self.sprite_w // 2
        fx = max(half, min(sw - half, fx))
        fy = max(self.sprite_h, min(sh, fy))
        self.root.geometry(f'{self.win_w}x{self.win_h}+{fx - self.win_w // 2}+{fy - self.foot_y}')

    def place_initially(self):
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        fx, fy = self.prefs.get('fx'), self.prefs.get('fy')
        if not isinstance(fx, int) or not isinstance(fy, int):
            fx, fy = sw - self.win_w // 2 - int(40 * self.dpi), sh - int(60 * self.dpi)  # 오른쪽 아래, 작업 표시줄 위
        self.stand_at(fx, fy)

    def remember_place(self):
        self.prefs['fx'], self.prefs['fy'] = self.foot()
        save_json(PREFS, self.prefs)

    def set_size(self, size):
        fx, fy = self.foot()
        self.load_frames(size)
        self.stand_at(fx, fy)
        self.prefs['size'] = size
        self.remember_place()

    def toggle_bubble(self):
        self.prefs['bubble'] = bool(self.bubble_var.get())
        save_json(PREFS, self.prefs)

    # ── Claude Code 상태 ───────────────────────────────────────────────
    def read_state(self):
        now = time.time()
        try:
            names = [n for n in os.listdir(SESSIONS) if n.endswith('.json')]
        except OSError:
            names = []
        seen = {}
        for name in names:
            path = os.path.join(SESSIONS, name)
            try:
                mtime = os.stat(path).st_mtime
            except OSError:
                continue
            if now - mtime > 86400:  # 하루 지난 세션 파일은 치운다
                try:
                    os.remove(path)
                except OSError:
                    pass
                continue
            old = self.sessions.get(name)
            if old and old[0] == mtime:
                seen[name] = old
                continue
            value = load_json(path, None)
            if isinstance(value, dict):
                seen[name] = (mtime, value)
            elif old:
                seen[name] = old  # 쓰는 도중이면 지난 내용으로
        self.sessions = seen

        # 명령(/pet, /pet pat, /pet 끄기): 아직 처리하지 않은, 이 프로그램이 뜨기 조금 전 이후의 것
        for _, value in seen.values():
            cmd = value.get('command') or {}
            cid = cmd.get('id') or 0
            if cid > self.last_command and cid / 10000 > self.started - 15:
                self.last_command = cid
                kind = cmd.get('kind')
                if kind == 'pat':
                    self.pat()
                elif kind == 'quit':
                    self.quit()
                    return
                elif kind == 'show':
                    fx, fy = self.foot()
                    self.stand_at(fx, fy)  # 화면 밖에 있었으면 안으로
                    self.root.lift()

        alive = [v for _, v in seen.values() if now - (v.get('alive') or 0) / 1000 < QUIT_AFTER]
        waiting = [v for v in alive if v.get('mood') == 'waiting']
        pick = max(waiting or alive, key=lambda v: v.get('at') or 0, default={})
        if self.state.get('mood') != pick.get('mood') or self.state.get('detail') != pick.get('detail'):
            self.last_poke = now
        self.state = pick

    def mood_now(self, now):
        """지금 보여 줄 동작 이름과 말풍선 글"""
        if self.drag and self.drag[4]:
            return ('dragL' if self.drag[5] < 0 else 'dragR'), ''
        if now < self.love_until:
            return 'love', self.say_text if now < self.say_until else '헤헤, 좋아요!'
        s = self.state
        mood = s.get('mood', 'idle')
        detail = s.get('detail', '')
        at = (s.get('at') or 0) / 1000
        if mood in LINGER and now - at > LINGER[mood]:
            mood, detail = 'idle', ''
        if mood == 'thinking':
            started = (s.get('turnStartedAt') or 0) / 1000
            dots = '.' * (int(now * 2) % 3 + 1)
            return 'thinking', f'생각하는 중{dots} {duration_text(now - started)}' if started else f'생각하는 중{dots}'
        if mood == 'working':
            count = s.get('toolCount') or 0
            return ('reading' if s.get('isReading') else 'working'), detail + (f' · 도구 {count}번째' if count > 1 else '')
        if mood in ('waiting', 'done', 'oops'):
            # 다 했을 때는 클로가 할 말(세션을 열었다는 등)이 먼저
            return mood, self.say_text if mood != 'waiting' and now < self.say_until else detail
        if now < self.say_until:
            return 'idle', self.say_text
        if now - max(self.last_poke, at) > SLEEP_AFTER and not self.panel_open:
            return 'sleep', ''
        return 'idle', ''

    # ── 매 틱 ────────────────────────────────────────────────────────
    def tick(self):
        now = time.time()
        self.read_state()
        self.check_jobs()
        alive = max([(v.get('alive') or 0) / 1000 for _, v in self.sessions.values()], default=0)
        if self.jobs:
            alive = now  # 새 세션의 첫 턴이 도는 동안은 끄지 않는다
        if now - max(alive, self.started, self.last_poke) > QUIT_AFTER:
            self.quit()
            return
        px, py = self.root.winfo_pointerxy()
        if (px, py) != self.pointer:
            self.pointer, self.pointer_moved = (px, py), now
        self.hover(now)
        self.draw(now)
        self.root.after(TICK_MS, self.tick)

    def hover(self, now):
        """클로 위에 마우스를 올려 두면 입력 영역을 열고, 떠나면 닫는다"""
        if self.drag:
            self.hover_since = None
            return
        wx, wy = self.root.winfo_x(), self.root.winfo_y()
        px, py = self.pointer[0] - wx, self.pointer[1] - wy
        on_pet = self.on_pet(px, py)
        on_panel = False
        if self.panel_open:
            x, y, w, h = self.panel_box()
            # 클로와 입력 영역 사이 틈도 포함
            top, bottom = (y, self.foot_y) if self.panel_above else (self.foot_y - self.sprite_h, y + h)
            on_panel = x <= px <= x + w and top <= py <= bottom
        if self.dropdown is not None:
            dx, dy, dw, dh = self.dropdown_box
            if dx <= self.pointer[0] <= dx + dw and dy <= self.pointer[1] <= dy + dh:
                on_panel = True
        if on_pet or on_panel:
            self.away_since = None
            if self.hover_since is None:
                self.hover_since = now
            if not self.panel_open and now - self.hover_since >= HOVER_OPEN:
                self.open_panel()
                self.last_poke = now
        else:
            self.hover_since = None
            if self.panel_open:
                typing = self.root.focus_get() is self.entry and bool(self.text())
                if self.away_since is None:
                    self.away_since = now
                elif now - self.away_since > HOVER_CLOSE and not typing:
                    self.close_dropdown()
                    self.close_panel()

    def frame_for(self, key, now):
        anim, ms, order = CLIPS[key]
        frames = self.images.get(anim) or self.images.get('idle') or []
        if not frames:
            return None
        if key != self.clip_key:
            self.clip_key, self.clip_started = key, now
        order = order or list(range(len(frames)))
        step = int((now - self.clip_started) * 1000 / ms)
        return frames[order[step % len(order)] % len(frames)]

    def look_frame(self, now):
        """쉬는 중에 마우스가 움직이면 눈으로 따라간다"""
        if now - self.pointer_moved > LOOK_FOR or self.drag:
            return None
        cx = self.root.winfo_x() + self.win_w / 2
        cy = self.root.winfo_y() + self.foot_y - self.sprite_h * 0.6
        dx, dy = self.pointer[0] - cx, self.pointer[1] - cy
        if dx * dx + dy * dy < 50 * 50:
            return None
        angle = math.degrees(math.atan2(dx, -dy)) % 360  # 위=0°, 시계 방향
        looks = self.images.get('look') or []
        return looks[round(angle / 22.5) % 16] if len(looks) == 16 else None

    def draw(self, now):
        key, text = self.mood_now(now)
        image = (self.look_frame(now) if key == 'idle' else None) or self.frame_for(key, now)
        c = self.canvas
        c.delete('art')
        sx = self.win_w // 2
        sy = self.foot_y
        if image is not None:
            c.create_image(sx, sy, image=image, anchor='s', tags=('art', 'pet'))
        top = sy - self.sprite_h
        self.key = key
        head = top + int(self.sprite_h * HEAD.get(key, HEAD_REST))  # 이 동작에서 머리가 가장 높이 오르는 곳
        self.draw_effect(key, now, sx + self.sprite_w * 0.42, head + self.sprite_h * 0.04)
        name = self.state.get('name') or '클로'
        # 입력 영역이 머리 위에 열려 있으면 말풍선은 쉰다
        if text and self.bubble_var.get() and not (self.panel_open and self.panel_above):
            self.draw_bubble(f'{name} · {text}' if key in ('done', 'oops') else text, sx, head - int(6 * self.dpi))

    def draw_effect(self, key, now, x, y):
        c = self.canvas
        blink = int(now * 3) % 2 == 0
        size = {'s': 12, 'm': 16, 'l': 20}[self.size]
        if key == 'waiting' and blink:
            c.create_text(x, y, text='!', fill='#f5b301', font=('Segoe UI', size, 'bold'), tags='art')
        elif key == 'sleep':
            rise = (now % 2.4) / 2.4
            c.create_text(x, y - rise * 18, text='z', fill='#7aa2ff', font=('Segoe UI', int(size * (0.7 + rise * 0.4)), 'bold'), tags='art')
        elif key == 'love':
            c.create_text(x, y - (6 if blink else 0), text='♥', fill='#ff5470', font=('Segoe UI Symbol', size, 'bold'), tags='art')
        elif key == 'done':
            c.create_text(x, y - (5 if blink else 0), text='✦', fill='#f5b301', font=('Segoe UI Symbol', size, 'bold'), tags='art')
        elif key == 'oops':  # 땀방울
            r = size * 0.32
            dy = (now % 1.6) * 4
            c.create_polygon(x, y + dy - r * 2, x + r, y + dy, x - r, y + dy, fill='#7ab8ff', outline='', tags='art')
            c.create_oval(x - r, y + dy - r, x + r, y + dy + r, fill='#7ab8ff', outline='', tags='art')

    def draw_bubble(self, text, cx, bottom):
        c = self.canvas
        font = self.font
        two_lines = self.line_h * 2 + 2
        d = self.dpi
        pad_x, pad_y = int(10 * d), int(6 * d)
        # 창이 화면 끝에 걸쳐 있으면 말풍선은 화면에 보이는 쪽에만 둔다
        wx = self.root.winfo_x()
        lo = max(4, -wx + 4)
        hi = min(self.win_w, self.root.winfo_screenwidth() - wx) - 4
        max_w = hi - lo
        t = c.create_text(0, 0, text=text, font=font, fill='#2b2b2b', anchor='nw', width=max_w - 2 * pad_x, tags='art')
        x0, y0, x1, y1 = c.bbox(t)
        w, h = x1 - x0, y1 - y0
        # 두 줄을 넘으면 줄인다
        if h > two_lines:
            c.delete(t)
            short = text
            while len(short) > 4:
                short = short[:-2]
                t = c.create_text(0, 0, text=short + '…', font=font, fill='#2b2b2b', anchor='nw', width=max_w - 2 * pad_x, tags='art')
                x0, y0, x1, y1 = c.bbox(t)
                w, h = x1 - x0, y1 - y0
                if h <= two_lines:
                    break
                c.delete(t)
        bw, bh = w + 2 * pad_x, h + 2 * pad_y
        left = max(lo, min(hi - bw, cx - bw // 2))
        tail = int(8 * d)
        top = max(2, bottom - bh - tail - 2)
        r = int(9 * d)
        pts = [left + r, top, left + bw - r, top, left + bw, top, left + bw, top + r, left + bw, top + bh - r, left + bw, top + bh,
               left + bw - r, top + bh, cx + tail, top + bh, cx, top + bh + tail, cx - tail, top + bh, left + r, top + bh,
               left, top + bh, left, top + bh - r, left, top + r, left, top]
        c.create_polygon(pts, smooth=True, fill='#ffffff', outline='#d0d0d0', tags='art')
        c.coords(t, left + pad_x, top + pad_y)
        c.tag_raise(t)

    # ── 마우스 ────────────────────────────────────────────────────────
    def on_pet(self, x, y):
        """캔버스 좌표 (x, y)가 클로 그림 위인지"""
        sx0 = self.win_w // 2 - self.sprite_w // 2
        return sx0 <= x <= sx0 + self.sprite_w and self.foot_y - self.sprite_h <= y <= self.foot_y

    def on_press(self, e):
        if not self.on_pet(e.x, e.y):  # 입력 영역 테두리 등은 끌지 않는다
            self.drag = None
            return
        self.drag = [e.x_root, e.y_root, self.root.winfo_x(), self.root.winfo_y(), False, 1]
        self._last_x = e.x_root

    def on_drag(self, e):
        if not self.drag:
            return
        dx, dy = e.x_root - self.drag[0], e.y_root - self.drag[1]
        if not self.drag[4] and dx * dx + dy * dy > 16:
            self.drag[4] = True
            self.close_panel()
        if self.drag[4]:
            step = e.x_root - getattr(self, '_last_x', e.x_root)
            if abs(step) > 1:
                self.drag[5] = 1 if step > 0 else -1
            self._last_x = e.x_root
            self.root.geometry(f'+{self.drag[2] + dx}+{self.drag[3] + dy}')

    def on_release(self, e):
        if not self.drag:
            return
        dragged = self.drag[4]
        self.drag = None
        self.last_poke = time.time()
        if dragged:
            fx, fy = self.foot()
            self.stand_at(fx, fy)
            self.remember_place()
        else:
            # 클릭: Claude 앱을 불러오고 손을 흔든다
            open_claude()
            self.pat()

    def on_menu(self, e):
        try:
            self.menu.tk_popup(e.x_root, e.y_root)
        finally:
            self.menu.grab_release()

    def pat(self):
        self.love_until = time.time() + LINGER['love']
        self.last_poke = time.time()

    def quit(self):
        for job in self.jobs:  # 아직 도는 첫 턴은 끊는다(들여올 사람이 없어진다)
            try:
                job['proc'].kill()
            except Exception:
                pass
        self.root.destroy()


def main():
    lock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        lock.bind(('127.0.0.1', LOCK_PORT))
    except OSError:
        return  # 이미 떠 있다
    if sys.platform == 'win32':
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass
    root = tk.Tk()
    root.title('클로')
    Pet(root)
    root.mainloop()
    lock.close()


if __name__ == '__main__':
    main()
