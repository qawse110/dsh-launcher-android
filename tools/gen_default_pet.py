#!/usr/bin/env python3
"""
生成 DshLauncher 内置默认桌宠（兼容 Codex 桌宠格式）：
- 输出 app/src/main/assets/codex-pets/default/spritesheet.png（1536x1872，8 列 x 9 行，单元格 192x208）
- 输出 pet.json（id / displayName / description / spritesheetPath）

行布局（Codex Pet Contract / animation-rows.md）：
  0 idle          1 running-right   2 running-left   3 waving
  4 jumping       5 failed          6 waiting        7 running
  8 review

Python 依赖：Pillow（termux: pkg install python-pillow，或 pip install pillow）。
用法：python3 tools/gen_default_pet.py
"""
import json
import os
from PIL import Image, ImageDraw, ImageOps

CELL_W, CELL_H = 192, 208
COLS, ROWS = 8, 9

# 每行动画帧数（Codex 规范：行首到末列）
USE_COLS = {
    0: 6,  # idle
    1: 8,  # running-right
    2: 8,  # running-left (镜像 row1)
    3: 4,  # waving
    4: 5,  # jumping
    5: 8,  # failed
    6: 6,  # waiting
    7: 6,  # running
    8: 6,  # review
}

# 主色（蓝青色小豆丁）
BODY = (108, 156, 255, 255)        # 蓝
BODY_LIGHT = (168, 198, 255, 255)  # 高光
BODY_DARK = (72, 112, 214, 255)    # 描边/暗部
CHEEK = (255, 170, 190, 210)
EYE_B = (36, 48, 84, 255)
MOUTH = (52, 64, 104, 255)
ANTENNA = (255, 214, 108, 255)
SHADOW = (30, 40, 70, 90)

# 身体几何（相对单元格中心，脚底约在 y=196）
BX, BY = 96, 120
BRX, BRY = 50, 56


def new_cell() -> Image.Image:
    img = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
    return img


def draw_body(d: ImageDraw.ImageDraw, cx=96, cy=120, rx=50, ry=56,
              squish=1.0, lift=0, lean=0.0, mirror=False):
    """画身体 + 腮红 + 天线。lift 为整体上移像素，squish 为垂直挤压，lean 为水平倾斜角。"""
    ry2 = ry * squish
    cy2 = cy + (ry - ry2) + lift  # 挤压时向下坐
    top = cy2 - ry2
    bot = cy2 + ry2
    if lean:
        # 简单做法：先画水平版本再旋转（独立帧，成本可接受）
        pass
    # 身体（带底部描边阴影）
    d.ellipse([cx - rx - 2, top - 2, cx + rx + 2, bot + 2], fill=BODY_DARK)
    d.ellipse([cx - rx, top, cx + rx, bot], fill=BODY)
    # 高光
    d.ellipse([cx - rx + 12, top + 12, cx - rx + 34, top + 30], fill=BODY_LIGHT)
    # 腮红
    d.ellipse([cx - rx + 6, cy2 - 6, cx - rx + 20, cy2 + 8], fill=CHEEK)
    d.ellipse([cx + rx - 20, cy2 - 6, cx + rx - 6, cy2 + 8], fill=CHEEK)
    # 天线
    ax = cx
    d.line([ax, top - 6, ax, top - 26], fill=BODY_DARK, width=5)
    d.ellipse([ax - 8, top - 38, ax + 8, top - 22], fill=ANTENNA)


def draw_eyes(d: ImageDraw.ImageDraw, cx=96, cy=112, ex=16, r=10,
              blink=False, pupil_dx=0, pupil_dy=0, sad=False, happy=False):
    if blink:
        for s in (-1, 1):
            x = cx + s * ex
            d.line([x - 8, cy, x + 8, cy], fill=EYE_B, width=4)
        return
    for s in (-1, 1):
        x = cx + s * ex
        if sad:
            d.line([x - 8, cy + 6, x + 8, cy + 2], fill=EYE_B, width=4)
            continue
        d.ellipse([x - r, cy - r, x + r, cy + r], fill=(255, 255, 255, 255))
        pr = 5 if happy else 4
        d.ellipse([x + pupil_dx - pr, cy + pupil_dy - pr, x + pupil_dx + pr, cy + pupil_dy + pr],
                  fill=EYE_B)


def draw_mouth(d: ImageDraw.ImageDraw, cx=96, cy=138, kind="smile", w=14, sad=False):
    if sad:
        d.arc([cx - w, cy - 4, cx + w, cy + 12], 200, 340, fill=MOUTH, width=4)
        return
    if kind == "smile":
        d.arc([cx - w, cy - 10, cx + w, cy + 6], 20, 160, fill=MOUTH, width=4)
    elif kind == "open":
        d.ellipse([cx - w // 2, cy - 4, cx + w // 2, cy + 8], fill=MOUTH)
    else:  # flat
        d.line([cx - w, cy, cx + w, cy], fill=MOUTH, width=4)


def draw_limbs(d: ImageDraw.ImageDraw, cx=96, cy=140, lx=38, rx2=38,
               l_phase=0, r_phase=0, wave=0.0, droop=False, down=0):
    """手臂：默认垂在身体两侧；wave>0 时右臂上举摆动；l_phase/r_phase 为跑步摆臂角度。"""
    ly = cy + down
    if wave > 0:
        # 右臂上举挥手：wave 控制举臂高度
        hand_y = ly - 26 - int(wave * 18)
        d.ellipse([cx + rx2 - 12, hand_y - 12, cx + rx2 + 12, hand_y + 12], fill=BODY_DARK)
        d.ellipse([cx + rx2 - 10, hand_y - 14, cx + rx2 + 10, hand_y + 10], fill=BODY)
        # 左臂自然下垂
        d.ellipse([cx - lx - 11, ly - 6, cx - lx + 9, ly + 14], fill=BODY_DARK)
        d.ellipse([cx - lx - 9, ly - 4, cx - lx + 7, ly + 12], fill=BODY)
        return
    for side, phase, sign in ((-1, l_phase, -1), (1, r_phase, 1)):
        swing = phase * 6.0
        dx = cx + side * (lx if side < 0 else rx2)
        hand_y = ly + 18 + swing
        # 手臂（圆端线段）
        d.line([dx, ly - 8, dx + 2, hand_y], fill=BODY_DARK, width=10)
        d.line([dx, ly - 8, dx + 2, hand_y], fill=BODY, width=8)
        d.ellipse([dx - 5, hand_y - 6, dx + 9, hand_y + 8], fill=BODY)
        if droop:
            d.ellipse([dx - 7, hand_y - 2, dx + 13, hand_y + 10], fill=BODY_DARK)


def draw_feet(d: ImageDraw.ImageDraw, cx=96, base=196, phase=0, jump=0, spread=22):
    """脚：跑步相位交替，jump>0 时收脚上提。"""
    y = base + (jump * 6)
    for s in (-1, 1):
        fx = cx + s * spread + phase * 6
        if abs(phase) > 0.001:
            fy = y - abs(phase) * 14
        else:
            fy = y - 2
        d.ellipse([fx - 12, fy - 8, fx + 12, fy + 8], fill=BODY_DARK)
        d.ellipse([fx - 10, fy - 8, fx + 10, fy + 6], fill=BODY)


def draw_shadow(d: ImageDraw.ImageDraw, cx=96, base=200, width=46, alpha=1.0):
    d.ellipse([cx - width, base - 6, cx + width, base + 6], fill=SHADOW)


def frame_idle(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    squish = 1.0
    if f == 0:
        squish = 1.05
    elif f == 1:
        squish = 1.0
    elif f == 2:
        squish = 0.97
    blink = f == 3
    draw_body(d, squish=squish)
    draw_eyes(d, blink=blink)
    draw_mouth(d)
    draw_limbs(d)
    draw_shadow(d)
    return img


def frame_run_side(f: int, direction: int):
    """跑步（左右）：8 帧摆腿摆臂 + 上下颠簸。"""
    img = new_cell()
    d = ImageDraw.Draw(img)
    phase = [0.0, -0.6, -1.0, -0.6, 0.0, 0.6, 1.0, 0.6][f % 8]
    bob = -abs(phase) * 4
    draw_body(d, lift=bob, lean=phase * 0.02)
    draw_eyes(d, pupil_dx=phase * 2)
    draw_mouth(d, kind="flat")
    draw_limbs(d, l_phase=-phase * 0.6, r_phase=phase * 0.6, down=bob)
    draw_feet(d, phase=phase, spread=20)
    draw_shadow(d, base=200 + bob, width=40)
    img = img.rotate(phase * 3, resample=Image.BILINEAR, center=(96, 190))
    if direction < 0:
        img = ImageOps.mirror(img)
    return img


def frame_waving(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    wave = [0.0, 0.8, 1.0, 0.4][f % 4]
    draw_body(d)
    draw_eyes(d, happy=True)
    draw_mouth(d, kind="open")
    draw_limbs(d, wave=wave)
    draw_shadow(d)
    return img


def frame_jumping(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    lift = [0, -16, -30, -16, 0][f % 5]
    squish = [1.0, 0.95, 1.1, 0.95, 1.0][f % 5]
    if f % 5 == 4:
        squish = 0.85  # 落地压扁
    draw_body(d, lift=lift, squish=squish)
    draw_eyes(d, happy=True, pupil_dy=-2)
    draw_mouth(d, kind="open")
    draw_limbs(d, wave=0.5 if lift < -10 else 0.0, down=lift)
    draw_feet(d, jump=1 if lift < 0 else 0)
    draw_shadow(d, base=200, width=max(34, 46 - abs(lift)))
    return img


def frame_failed(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    # 逐渐压扁 + 眼神死
    t = (f % 8) / 7.0
    squish = 1.0 - 0.25 * t
    draw_body(d, squish=squish, cy=124 + 10 * t)
    draw_eyes(d, sad=True)
    draw_mouth(d, sad=True)
    draw_limbs(d, droop=True, down=8 * t)
    draw_shadow(d, base=200, width=46 + 8 * t)
    return img


def frame_waiting(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    glance = [0.0, 4.0, 7.0, 4.0, 0.0, -5.0][f % 6]
    bob = -2 if f % 6 in (1, 2) else 0
    draw_body(d, lift=bob)
    draw_eyes(d, pupil_dx=glance)
    draw_mouth(d, kind="smile")
    draw_limbs(d, down=bob)
    draw_shadow(d)
    return img


def frame_running(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    phase = [0.0, -0.7, -1.0, -0.7, 0.0, 0.7][f % 6]
    bob = -abs(phase) * 5
    draw_body(d, lift=bob, lean=phase * 0.03)
    draw_eyes(d, pupil_dx=phase * 2, pupil_dy=-1)
    draw_mouth(d, kind="flat")
    draw_limbs(d, l_phase=-phase * 0.8, r_phase=phase * 0.8, down=bob)
    draw_feet(d, phase=phase, spread=22)
    draw_shadow(d, base=200 + bob, width=40)
    return img


def frame_review(f: int):
    img = new_cell()
    d = ImageDraw.Draw(img)
    dots = ["...", " ..", "  ."][f % 3]
    draw_body(d)
    draw_eyes(d, pupil_dy=-4, happy=False)
    draw_mouth(d, kind="flat")
    draw_limbs(d)
    # 思考气泡
    for i, ch in enumerate(dots):
        if ch == ".":
            x = 96 + 14 + i * 14
            d.ellipse([x - 5, 46, x + 5, 56], fill=(255, 255, 255, 230))
    draw_shadow(d)
    return img


GENERATORS = {
    0: frame_idle,
    1: lambda f: frame_run_side(f, 1),
    2: lambda f: frame_run_side(f, -1),
    3: frame_waving,
    4: frame_jumping,
    5: frame_failed,
    6: frame_waiting,
    7: frame_running,
    8: frame_review,
}


def build_atlas() -> Image.Image:
    atlas = Image.new("RGBA", (CELL_W * COLS, CELL_H * ROWS), (0, 0, 0, 0))
    for row in range(ROWS):
        gen = GENERATORS[row]
        for col in range(USE_COLS[row]):
            frame = gen(col)
            atlas.paste(frame, (col * CELL_W, row * CELL_H))
    return atlas


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, "app", "src", "main", "assets", "codex-pets", "default")
    os.makedirs(out_dir, exist_ok=True)
    atlas = build_atlas()
    sheet_path = os.path.join(out_dir, "spritesheet.png")
    atlas.save(sheet_path, "PNG", optimize=True)
    pet_json = {
        "id": "dsh-default",
        "displayName": "小豆丁",
        "description": "DshLauncher 内置默认桌宠（兼容 Codex 桌宠格式：8x9 精灵表）",
        "spritesheetPath": "spritesheet.png",
    }
    with open(os.path.join(out_dir, "pet.json"), "w", encoding="utf-8") as f:
        json.dump(pet_json, f, ensure_ascii=False, indent=2)
    print(f"written: {sheet_path} ({atlas.size[0]}x{atlas.size[1]})")
    print(f"written: {os.path.join(out_dir, 'pet.json')}")
    # 校验：尺寸 + 非透明单元格分布
    assert atlas.size == (CELL_W * COLS, CELL_H * ROWS), "atlas size mismatch"
    for row in range(ROWS):
        for col in range(8):
            cell = atlas.crop((col * CELL_W, row * CELL_H, (col + 1) * CELL_W, (row + 1) * CELL_H))
            has_px = cell.getbbox() is not None
            expect = col < USE_COLS[row]
            if expect and not has_px:
                raise SystemExit(f"FAIL: row {row} col {col} empty but expected used")
            if has_px and not expect:
                print(f"WARN: row {row} col {col} has pixels but spec says unused")


if __name__ == "__main__":
    main()