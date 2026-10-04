# 시안 스프라이트(clo-pet-assets)에서 바탕화면 클로의 프레임 PNG를 만든다.
#   pip install pillow
#   python tools/make-frames.py <압축을 푼 clo-pet-assets 폴더>
#
# 칸(192×208)마다:
#   1. 가슴의 배지(흰색·크림색 테두리 동그라미)를 지우고 둘레의 몸 색으로 메운다.
#   2. 반투명 가장자리를 없앤다(바탕화면 창은 한 색을 투명색으로 쓰므로 반투명이 없어야 깨끗하다).
#   3. 모든 칸에 같은 상자를 잘라 위치를 맞추고, 세 크기(작게·보통·크게)로 저장한다.
# 결과: desktop/frames/<s|m|l>/<동작>/<번호>.png, desktop/frames/meta.json
from PIL import Image, ImageDraw
import json, sys, os
from collections import Counter

SRC = os.path.join(sys.argv[1], '')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'desktop', 'frames')
meta = json.load(open(SRC + 'clo.json', encoding='utf-8'))
sheet = Image.open(SRC + 'assets/clo-spritesheet.png').convert('RGBA')

CROP = (4, 8, 190, 186)  # 모든 칸의 내용이 들어가는 상자(점프 포함)
SIZES = {'s': 0.5, 'm': 0.75, 'l': 1.0}
NAMES = {'idle': 'idle', 'running-right': 'runRight', 'running-left': 'runLeft', 'waving': 'waving',
         'jumping': 'jumping', 'failed': 'failed', 'waiting': 'waiting', 'running': 'running', 'review': 'review'}


def comps(mask, w, h):
    seen = set(); out = []
    for y in range(h):
        for x in range(w):
            if mask[y][x] and (x, y) not in seen:
                st = [(x, y)]; seen.add((x, y)); pts = []
                while st:
                    a, b = st.pop(); pts.append((a, b))
                    for da, db in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        c, d = a + da, b + db
                        if 0 <= c < w and 0 <= d < h and mask[d][c] and (c, d) not in seen:
                            seen.add((c, d)); st.append((c, d))
                out.append(pts)
    return out


def clean(cell):
    """배지를 지우고 알파를 0/255로"""
    W, H = cell.size
    px = cell.load()
    light = [[px[x, y][3] > 128 and px[x, y][0] > 180 and px[x, y][1] > 180 and px[x, y][2] > 110 for x in range(W)] for y in range(H)]
    # 배지 자리: 밝은 테두리 덩어리의 상자에 맞춘 타원(조금 넓게)
    hole = Image.new('L', (W, H), 0)
    draw = ImageDraw.Draw(hole)
    for pts in comps(light, W, H):
        if 25 <= len(pts) <= 700:
            xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
            draw.ellipse((min(xs) - 6, min(ys) - 6, max(xs) + 6, max(ys) + 6), fill=255)
    hp = hole.load()
    mint = lambda p: p[1] > 150 and p[2] > 120 and p[0] < 150  # 밝은 스카프는 배지가 아니다
    body = lambda p: p[3] > 128 and p[0] > p[1] + 30  # 주황 몸
    unknown = {(x, y) for y in range(H) for x in range(W) if hp[x, y] and px[x, y][3] > 128 and not mint(px[x, y])}
    # 둘레의 몸(주황) 색으로 바깥부터 한 겹씩 메운다. 스카프 색은 끌어오지 않는다
    while unknown:
        filled = {}
        for x, y in unknown:
            near = Counter(px[x + dx, y + dy][:3] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
                           if 0 <= x + dx < W and 0 <= y + dy < H and (x + dx, y + dy) not in unknown and body(px[x + dx, y + dy]))
            if near:
                filled[(x, y)] = near.most_common(1)[0][0]
        if not filled:
            break
        for (x, y), c in filled.items():
            px[x, y] = c + (255,)
        unknown -= set(filled)
    if unknown:  # 몸에 닿지 않고 갇힌 자리는 이 칸에서 가장 흔한 몸 색으로
        common = Counter(px[x, y][:3] for y in range(H) for x in range(W) if body(px[x, y])).most_common(1)
        for x, y in unknown:
            px[x, y] = (common[0][0] if common else (230, 100, 60)) + (255,)
    for y in range(H):
        for x in range(W):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255 if a >= 128 else 0)
    return cell


def save(cell, anim, i):
    body = clean(cell).crop(CROP)
    for tag, k in SIZES.items():
        img = body if k == 1 else body.resize((round(body.width * k), round(body.height * k)), Image.LANCZOS)
        if k != 1:
            p = img.load()
            for y in range(img.height):
                for x in range(img.width):
                    r, g, b, a = p[x, y]
                    p[x, y] = (r, g, b, 255 if a >= 128 else 0)
        d = os.path.join(OUT, tag, anim)
        os.makedirs(d, exist_ok=True)
        img.save(os.path.join(d, f'{i:02d}.png'), optimize=True)


counts = {}
crop = lambda f: sheet.crop((f['x'], f['y'], f['x'] + 192, f['y'] + 208))
for k, a in meta['animations'].items():
    for i, f in enumerate(a['frames']):
        save(crop(f), NAMES[k], i)
    counts[NAMES[k]] = len(a['frames'])
for i, f in enumerate(meta['look_directions']):
    save(crop(f), 'look', i)
counts['look'] = len(meta['look_directions'])

w, h = CROP[2] - CROP[0], CROP[3] - CROP[1]
json.dump({'frames': counts, 'sizes': {t: [round(w * k), round(h * k)] for t, k in SIZES.items()},
           'look': '시선 16방향: 위=0°부터 시계 방향 22.5°씩'},
          open(os.path.join(OUT, 'meta.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
print('wrote', os.path.normpath(OUT), counts)
