# woo-mods 동기화: 이 폴더의 최신 코드를 Claude Code 플러그인 캐시에 실제 복사본으로 넣고,
# installed_plugins.json 을 고쳐 데스크톱 앱이 열린 Code 세션 모두에 플러그인을 다시 불러오게 한다.
#
# 왜 복사인가: 데스크톱 앱은 플러그인의 실제 위치(realpath)가 캐시 폴더 안에 있어야만 불러온다.
# 개발 폴더를 직접 가리키거나 정션·심볼릭 링크로 이으면 보안 검사에서 빠진다(직접 확인함).
# 그래서 고칠 때마다 캐시에 복사하고, 레지스트리를 바꿔 앱이 다시 불러오게 하는 것이 가장 빠른 길이다.
#
#   python tools/sync_mods.py                 모든 mod 동기화
#   python tools/sync_mods.py pocket-pet      한 mod만
#   (Claude Code 훅) stdin 으로 도구 입력 JSON을 받으면, 고친 파일이 mod 안일 때만 그 mod를 동기화한다

import datetime
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # C:\dev\개발용\mods
MARKET = os.path.join(ROOT, '.claude-plugin', 'marketplace.json')
PLUGINS_HOME = os.path.join(os.path.expanduser('~'), '.claude', 'plugins')
REGISTRY = os.path.join(PLUGINS_HOME, 'installed_plugins.json')
SKIP = shutil.ignore_patterns('.git', '__pycache__', '*.pyc', 'node_modules', '*.tmp')
# Claude Code가 캐시 버전 폴더에 남기는 자기 표시. 지우면 쓰고 있는 폴더를 정리 대상으로 볼 수 있다
KEEP_IN_CACHE = {'.in_use'}


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def market_name_and_plugins():
    m = load(MARKET)
    return m['name'], {p['name']: os.path.normpath(os.path.join(ROOT, p['source'])) for p in m['plugins']}


def is_link(path):
    return os.path.islink(path) or (hasattr(os.path, 'isjunction') and os.path.isjunction(path))


def same_file(a, b):
    try:
        sa, sb = os.stat(a), os.stat(b)
    except OSError:
        return False
    if sa.st_size != sb.st_size:
        return False
    with open(a, 'rb') as fa, open(b, 'rb') as fb:
        return fa.read() == fb.read()


def mirror(src, target):
    """src를 target에 그대로 맞춘다. 폴더를 통째로 지우지 않고 파일 하나씩: 바뀐 파일만 쓰고, 없어진 파일만 지운다.
    떠 있는 클로가 캐시 안의 글꼴 파일을 잡고 있어도 망가지지 않게(통째로 지우면 중간에 멈춰 반쯤 빈 캐시가 남는다).
    못 쓴 파일 목록을 돌려준다"""
    ignored = SKIP(src, os.listdir(src))  # 맨 위에서 거르는 이름(.git 등)
    failed = []
    for here, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP(here, dirs)]
        rel = os.path.relpath(here, src)
        out_dir = os.path.normpath(os.path.join(target, rel))
        os.makedirs(out_dir, exist_ok=True)
        for f in files:
            if f in SKIP(here, files):
                continue
            a, b = os.path.join(here, f), os.path.join(out_dir, f)
            if same_file(a, b):
                continue
            try:
                shutil.copy2(a, b)
            except OSError:
                failed.append(os.path.relpath(a, src))
    # 개발 폴더에서 없어진 파일·폴더는 캐시에서도 지운다(지울 수 없으면 남겨 둔다)
    for here, dirs, files in os.walk(target, topdown=False):
        rel = os.path.relpath(here, target)
        twin = os.path.normpath(os.path.join(src, rel))
        for f in files:
            if here == target and f in KEEP_IN_CACHE:
                continue
            if not os.path.exists(os.path.join(twin, f)) or f in ignored:
                try:
                    os.remove(os.path.join(here, f))
                except OSError:
                    pass
        if here != target and not os.path.isdir(twin):
            try:
                os.rmdir(here)
            except OSError:
                pass
    return failed


def live_version_dirs(cache_root, current):
    """지금 돌고 있는 세션이 붙잡은 다른 버전 폴더들. 세션은 열 때 정해진 버전 폴더에서 계속 읽으므로
    (등록을 바꿔도 그 세션은 옮겨 가지 않는다), 거기에도 최신을 넣어야 다시 불러올 때 새 코드가 올라간다.
    Claude Code는 쓰는 폴더에 .in_use 표시를 남긴다"""
    out = []
    try:
        names = os.listdir(cache_root)
    except OSError:
        return out
    for n in names:
        d = os.path.join(cache_root, n)
        if d != current and os.path.isdir(d) and not is_link(d) and os.path.exists(os.path.join(d, '.in_use')):
            out.append(d)
    return out


def copy_into_cache(market, name, src):
    """src(개발 폴더)를 캐시/<market>/<name>/<버전>에 실제 복사본으로 맞추고, 돌고 있는 세션이 쓰는 다른 버전
    폴더에도 같은 내용을 넣는다. (경로, 버전, 함께 맞춘 폴더 수)를 돌려준다"""
    version = load(os.path.join(src, '.claude-plugin', 'plugin.json'))['version']
    cache_root = os.path.realpath(os.path.join(PLUGINS_HOME, 'cache', market, name))
    target = os.path.join(cache_root, version)
    if is_link(target):
        os.rmdir(target)  # 링크만 지운다(가리키는 개발 폴더는 건드리지 않는다)
    if os.path.isdir(target) and not os.path.realpath(target).startswith(cache_root + os.sep):
        raise SystemExit(f'캐시 밖을 가리켜서 멈춤: {target}')
    failed = mirror(src, target)
    if failed:
        raise SystemExit(f'{name}: 캐시에 쓰지 못한 파일이 있어 등록을 바꾸지 않았어요: {", ".join(failed)}')
    if not os.path.isfile(os.path.join(target, '.claude-plugin', 'plugin.json')):
        raise SystemExit(f'{name}: 캐시 복사본에 plugin.json 이 없어 멈춤')
    live = live_version_dirs(cache_root, target)
    for d in live:
        if mirror(src, d):
            print(f'{name}: {os.path.basename(d)} 폴더(세션이 쓰는 중)에 일부 파일을 쓰지 못했어요', file=sys.stderr)
    return target, version, len(live)


def update_registry(market, done):
    """installed_plugins.json 의 설치 경로·버전을 바꾼다. 내용이 바뀌면 데스크톱 앱이 열린 세션에 다시 불러오기를 보낸다"""
    reg = load(REGISTRY)
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    for name, (target, version, _live) in done.items():
        for entry in reg.get('plugins', {}).get(f'{name}@{market}', []):
            entry['installPath'] = target
            entry['version'] = version
            entry['lastUpdated'] = now
    tmp = REGISTRY + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(reg, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, REGISTRY)


def stop_pet():
    """떠 있는 바탕화면 클로를 끈다. 다시 띄울 때 쓸 pythonw 경로를 돌려준다(안 떠 있었으면 None).
    PowerShell은 끄기만 한다(아무것도 띄우지 않으니 출력을 받아도 안전하다)"""
    if sys.platform != 'win32':
        return None
    stop = ("Get-CimInstance Win32_Process -Filter \"Name='pythonw.exe'\" | "
            "Where-Object { $_.CommandLine -like '*clo_pet.pyw*' } | "
            "ForEach-Object { $_.ExecutablePath; Stop-Process -Id $_.ProcessId -Force }")
    r = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', stop],
                       stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
    exes = [line.strip() for line in (r.stdout or '').splitlines() if line.strip()]
    if exes:
        time.sleep(0.6)  # 하나만 뜨게 잡아 두는 포트와 글꼴 파일이 풀릴 때까지
    return exes[0] if exes else None


def start_pet(exe, target):
    """새 클로를 완전히 떼어서 띄운다. 이 프로세스의 출력 파이프를 물려받으면 동기화가 클로가 꺼질 때까지 멈추고,
    훅의 작업 개체에 묶이면 훅이 끝날 때 같이 꺼진다. 작업 폴더는 캐시 밖(홈)으로: 캐시 폴더를 붙잡지 않게"""
    script = os.path.join(target, 'desktop', 'clo_pet.pyw')
    detached = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    breakaway = 0x01000000  # CREATE_BREAKAWAY_FROM_JOB: 훅이 끝나도 살아 있게
    for flags in (detached | breakaway, detached):  # 작업 개체가 떼어 내기를 막으면 그냥 띄운다
        try:
            subprocess.Popen([exe, script], cwd=os.path.expanduser('~'), creationflags=flags, close_fds=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return True
        except OSError:
            continue
    return False


def changed_plugin_from_hook(plugins):
    """훅으로 불렸으면 (고친 파일이 속한 mod 이름, mod 안의 상대 경로), 아니면 None.
    mod 밖 파일이면 ('', '')"""
    if sys.stdin is None or sys.stdin.isatty():
        return None
    # 훅 입력은 UTF-8이다. Windows 기본(cp949)으로 읽으면 한글 경로가 깨져 JSON이 망가진다
    raw = sys.stdin.buffer.read().decode('utf-8', 'replace').strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return '', ''  # 훅 입력인데 읽을 수 없으면 아무것도 하지 않는다
    ti = data.get('tool_input') or {}
    path = ti.get('file_path') or ti.get('notebook_path') or ''
    if not path:
        return '', ''
    path = os.path.normcase(os.path.realpath(path))
    for name, src in plugins.items():
        root = os.path.normcase(os.path.realpath(src)) + os.sep
        if path.startswith(root):
            return name, path[len(root):]
    return '', ''


def main():
    market, plugins = market_name_and_plugins()
    hooked = changed_plugin_from_hook(plugins)
    if hooked is not None and not hooked[0]:
        return  # 훅인데 mod 밖 파일: 할 일 없음
    names = [hooked[0]] if hooked else (sys.argv[1:] or list(plugins))
    for name in names:
        if name not in plugins:
            raise SystemExit(f'모르는 mod: {name} (있는 것: {", ".join(plugins)})')
    # 바탕화면 클로는 그 프로그램(desktop/)이 바뀌었을 때만 다시 띄운다. 직접 실행하면 늘 다시 띄운다.
    # 캐시를 맞추기 전에 끈다: 떠 있는 클로가 캐시 안 파일(글꼴)을 잡고 있으면 그 파일을 새로 쓸 수 없다
    wants_pet = 'pocket-pet' in names and (not hooked or hooked[1].startswith('desktop' + os.sep))
    pet_exe = stop_pet() if wants_pet else None
    done = {}
    try:
        for name in names:
            done[name] = copy_into_cache(market, name, plugins[name])
        update_registry(market, done)
    finally:
        # 동기화가 실패해도 꺼 둔 클로는 다시 띄운다(새 복사본이 있으면 그것으로, 없으면 지금 등록된 것으로)
        pet = bool(pet_exe) and start_pet(pet_exe, done['pocket-pet'][0] if 'pocket-pet' in done else
                                          load(REGISTRY)['plugins'][f'pocket-pet@{market}'][0]['installPath'])
    for name, (target, version, live) in done.items():
        print(f'{name} {version} -> {target}' + (f' (+ 세션이 쓰는 옛 버전 폴더 {live}개에도)' if live else ''))
    print('데스크톱 앱이 열린 Code 세션에 다시 불러오기를 보냈어요' + (' · 클로를 새 코드로 다시 띄웠어요' if pet else ''))


if __name__ == '__main__':
    main()
