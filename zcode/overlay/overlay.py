#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
ZCode 补充提示挂件 · 桌面版（跟随 ZCode 桌面端窗口右下角，可拖动）

特性：
- 生命周期跟随 ZCode 桌面端：ZCode 出现/恢复时显示，关闭/最小化约 3 秒后隐藏
  （进程保留，ZCode 回来就跟着回来）；找不到 ZCode 窗口时落在屏幕右下角
- 可拖动，位置自动记忆；右键菜单可重置位置 / 退出
- 点击鲸鱼：
    * 没有正在活动的会话 → 气泡提示
    * 只有一个 → 直接定向通知
    * 检测到多个 → 展开清单，用户点选要注入哪个会话
    * 写入 pending-request.json（带 sessionHint 定向）→ 运行中的 AI 会在下一个动作
      收到「补充提示挂件·事件」，随即用 AskUserQuestion 问「有什么要补充的吗？」
      （消费逻辑在 hooks/supplement-widget-hook.mjs）

会话来源：ZCode 的 db.sqlite（session 表 + model_usage 表），
"正在活动" = 最近 15 分钟内有模型请求，或存在 status='running' 的请求。

用法：
    pythonw overlay.py            # 启动（推荐用 start-overlay.vbs，无控制台）
    python  overlay.py --stop     # 停止正在运行的挂件
    python  overlay.py --render-test out.png [--state idle|clicked|sessions|badge]
                  # 离屏渲染（调试）
"""
import os
import sys
import json
import math
import time
import ctypes
import sqlite3
import subprocess
from pathlib import Path

# ---------------------------------------------------------------- 路径与配置

def config_dir() -> Path:
    env = (os.environ.get("ZCODE_CLI_HOME") or "").strip()
    return Path(env) if env else Path.home() / ".zcode" / "cli"

STATE_DIR = config_dir() / "supplement-widget"
PID_FILE = STATE_DIR / "overlay.pid"
POS_FILE = STATE_DIR / "overlay-pos.json"
PENDING_FILE = STATE_DIR / "pending-request.json"
CMD_FILE = STATE_DIR / "overlay-cmd.json"
LOG_FILE = STATE_DIR / "overlay.log"
DB_FILE = config_dir() / "db" / "db.sqlite"

# 会话"正在活动"的判定窗口
ACTIVE_WINDOW_MS = 15 * 60 * 1000

DEBUG = os.environ.get("SUPPLEMENT_WIDGET_DEBUG") == "1"


def dbg(*args):
    if not DEBUG:
        return
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(time.strftime("%H:%M:%S ") + " ".join(str(a) for a in args) + "\n")
    except Exception:
        pass


# ---------------------------------------------------------------- Win32 工具

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
try:
    from ctypes import wintypes
except Exception:
    wintypes = None


def find_zcode_rect():
    """返回 ZCode 桌面端主窗口物理像素矩形 (left, top, right, bottom)；找不到返回 None。

    ZCode 是 Electron 应用：主窗口类 Chrome_WidgetWin_1、标题含 "ZCode"。
    类名过滤是必须的——挂件自己的窗口标题也含 "ZCode"。"""
    if wintypes is None:
        return None
    try:
        best = None
        best_area = 0

        WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

        def cb(hwnd, lparam):
            nonlocal best, best_area
            if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
                return True
            n = user32.GetWindowTextLengthW(hwnd)
            if n <= 0:
                return True
            buf = ctypes.create_unicode_buffer(n + 1)
            user32.GetWindowTextW(hwnd, buf, n + 1)
            title = buf.value
            if "ZCode" not in title:
                return True
            cls = ctypes.create_unicode_buffer(64)
            user32.GetClassNameW(hwnd, cls, 64)
            if cls.value != "Chrome_WidgetWin_1":
                return True
            rect = wintypes.RECT()
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                w = rect.right - rect.left
                h = rect.bottom - rect.top
                area = w * h
                if w > 400 and h > 300 and area > best_area:
                    best_area = area
                    best = (rect.left, rect.top, rect.right, rect.bottom)
            return True

        user32.EnumWindows(WNDENUMPROC(cb), 0)
        return best
    except Exception as e:
        dbg("find_zcode_rect error:", e)
        return None


MUTEX_NAME = "Local\\zc_supplement_widget_overlay_v1"


def acquire_single_instance():
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    h = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if not h:
        return None
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return None
    return h


def stop_running():
    """停止已运行的挂件（优先 PID 文件 → taskkill；同时写 quit 命令文件兜底）"""
    try:
        if PID_FILE.exists():
            pid_txt = PID_FILE.read_text().strip()
            pid = int(pid_txt or "0")
            if pid > 0:
                subprocess.run(
                    ["taskkill", "/PID", str(pid), "/F"],
                    creationflags=0x08000000,  # CREATE_NO_WINDOW
                    capture_output=True,
                )
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        CMD_FILE.write_text(json.dumps({"action": "quit"}), encoding="utf-8")
        print("已发送停止指令" + ("（PID " + PID_FILE.read_text().strip() + "）" if PID_FILE.exists() else ""))
    except Exception as e:
        print("停止失败：", e)


# ---------------------------------------------------------------- 会话数据

def rel_time(ms):
    if not ms:
        return ""
    d = (time.time() * 1000 - ms) / 60000.0
    if d < 1:
        return "刚刚"
    if d < 60:
        return "%d 分钟前" % int(d)
    h = d / 60.0
    if h < 24:
        return "%d 小时前" % int(h)
    return "%d 天前" % int(h / 24)


def scan_sessions(limit=5):
    """从 ZCode 的 db.sqlite 读"正在活动"的会话（含标题）。
    正在活动 = 最近 ACTIVE_WINDOW_MS 内有模型请求，或存在 status='running' 的请求。
    失败返回 None（调用方保留上次缓存）。"""
    if not DB_FILE.exists():
        return None
    try:
        con = sqlite3.connect(str(DB_FILE), timeout=0.8)
        con.row_factory = sqlite3.Row
        try:
            rows = con.execute(
                """
                SELECT s.id, s.title,
                       COALESCE(MAX(m.completed_at), 0) AS last_model_at,
                       SUM(CASE WHEN m.status = 'running' THEN 1 ELSE 0 END) AS running_n
                FROM session s
                LEFT JOIN model_usage m ON m.session_id = s.id
                WHERE s.time_archived IS NULL
                  AND s.parent_id IS NULL
                GROUP BY s.id
                HAVING last_model_at > ?
                    OR (running_n IS NOT NULL AND running_n > 0)
                ORDER BY CASE WHEN COALESCE(MAX(m.completed_at), 0) = 0
                              THEN s.time_updated
                              ELSE MAX(m.completed_at) END DESC
                LIMIT 24
                """,
                (time.time() * 1000 - ACTIVE_WINDOW_MS,),
            ).fetchall()
        finally:
            con.close()
    except Exception as e:
        dbg("scan_sessions error:", e)
        return None

    out = []
    for row in rows:
        title = (row["title"] or "").strip() or "(未命名会话)"
        out.append({
            "id": row["id"],
            "title": title,
            "at": row["last_model_at"] or 0,
            "status": "running" if row["running_n"] else "active",
        })
        if len(out) >= limit:
            break
    return out


def write_pending(session_hint=None):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": "sup-%s-%s" % (base36(), os.urandom(2).hex()),
        "at": int(time.time() * 1000),
        "source": "desktop-overlay",
    }
    if session_hint:
        payload["sessionHint"] = session_hint
    tmp = PENDING_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, PENDING_FILE)
    dbg("pending written:", payload)
    return payload["id"]


def base36():
    n = int(time.time() * 1000)
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
    s = ""
    while n:
        n, r = divmod(n, 36)
        s = alphabet[r] + s
    return s or "0"


# ---------------------------------------------------------------- Qt 界面

from PySide6.QtCore import Qt, QTimer, QRectF, QPointF  # noqa: E402
from PySide6.QtGui import (  # noqa: E402
    QPainter, QColor, QFont, QPainterPath, QPen, QBrush, QAction, QPixmap, QCursor,
)
from PySide6.QtWidgets import QApplication, QWidget, QMenu  # noqa: E402
from PySide6.QtSvg import QSvgRenderer  # noqa: E402

W_COLLAPSED, H_COLLAPSED = 252, 146
W_EXPANDED = 302
ROW_H = 30
HEADER_H = 22
CARD_H = 74
BOTTOM_MARGIN = 10
MAX_ROWS = 5
WHALE_FILE = Path(__file__).with_name("whale.svg")

CLICK_SEQ = ["已通知 AI ✓", "它马上就抽空来问你", "想补充什么，先理一理～", "不用打断，继续干你的活"]
COOLDOWN_MS = 6000
RESET_MS = 90000

FONT_FAMILIES = [
    "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "SimHei",
    "Segoe UI", "Segoe UI Symbol", "Segoe UI Emoji", "sans-serif",
]


def make_font(pt, bold=False):
    f = QFont()
    f.setFamilies(FONT_FAMILIES)
    f.setPointSizeF(pt)
    f.setBold(bold)
    return f


DEFAULT_OFFSETS = {
    "zc": {"dx": -(W_COLLAPSED + 26), "dy": -(H_COLLAPSED + 26)},      # 相对 ZCode 窗口右下角
    "screen": {"dx": -(W_COLLAPSED + 26), "dy": -(H_COLLAPSED + 26)},  # 相对屏幕右下角
}


class Overlay(QWidget):
    def __init__(self, test_mode=False):
        super().__init__()
        self.test_mode = test_mode
        self.setWindowFlags(
            Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool
        )
        self.setAttribute(Qt.WA_TranslucentBackground, True)
        self.setAttribute(Qt.WA_ShowWithoutActivating, True)
        self.setWindowTitle("ZCode 补充提示挂件")
        self.setFixedSize(W_COLLAPSED, H_COLLAPSED)

        # 状态
        self.status = "idle"          # idle | waiting
        self.bubble_text = ""
        self.bubble_until = 0.0
        self.hop_start = 0.0
        self.last_sent = 0.0
        self.seq_index = -1
        self.dragging = False
        self.moved = False
        self.press_global = QPointF()
        self.press_win = QPointF()
        self.t = 0.0
        self.offsets = self._load_offsets()

        # 展开（多会话选择）
        self.expanded = False
        self.sessions = []            # [{id,title,at,status}]
        self.row_rects = []
        self.hover_row = -1

        self.scan_tick = 0

        # 生命周期跟随
        self.zc_seen = False
        self.zc_miss = 0

        # 渲染资源
        self.whale = QSvgRenderer(str(WHALE_FILE)) if WHALE_FILE.exists() else None

        # 定时器：动画帧
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)
        self.timer.start(50)

        # 定时器：位置跟随 + 生命周期 + 命令文件 + 会话缓存
        self.follow = QTimer(self)
        self.follow.timeout.connect(self._follow_step)
        self.follow.start(450)

        self._place_initial()

    # ------------------------------------------------ 几何与位置
    def _current_collapsed_pos(self):
        """当前窗口对应的"收起态"左上角坐标（展开时锚定右下角）"""
        dx = (self.width() - W_COLLAPSED) if self.expanded else 0
        dy = (self.height() - H_COLLAPSED) if self.expanded else 0
        return QPointF(self.x() + dx, self.y() + dy)

    def _expanded_height(self, n):
        rows = max(1, min(n, MAX_ROWS))
        return HEADER_H + rows * ROW_H + 8 + CARD_H + BOTTOM_MARGIN

    def _apply_geometry(self, expanded, n=0):
        base = self._current_collapsed_pos()
        self.expanded = expanded
        w = W_EXPANDED if expanded else W_COLLAPSED
        h = self._expanded_height(n) if expanded else H_COLLAPSED
        self.setFixedSize(w, h)
        if self.test_mode:
            return
        x = base.x() - (w - W_COLLAPSED) if expanded else base.x()
        y = base.y() - (h - H_COLLAPSED) if expanded else base.y()
        self.move(int(x), int(y))
        self._rebuild_row_rects()
        self.update()

    def _rebuild_row_rects(self):
        self.row_rects = []
        if not self.expanded:
            return
        y0 = HEADER_H + 6
        for i in range(min(len(self.sessions), MAX_ROWS)):
            self.row_rects.append(QRectF(10, y0 + i * ROW_H, self.width() - 20, ROW_H - 4))

    def _card_rect(self):
        return QRectF(10, self.height() - BOTTOM_MARGIN - CARD_H, self.width() - 20, CARD_H)

    def _load_offsets(self):
        try:
            j = json.loads(POS_FILE.read_text(encoding="utf-8"))
            out = json.loads(json.dumps(DEFAULT_OFFSETS))
            for k in ("zc", "screen"):
                if isinstance(j.get(k), dict) and "dx" in j[k] and "dy" in j[k]:
                    out[k] = {"dx": float(j[k]["dx"]), "dy": float(j[k]["dy"])}
            return out
        except Exception:
            return json.loads(json.dumps(DEFAULT_OFFSETS))

    def _save_offsets(self):
        try:
            STATE_DIR.mkdir(parents=True, exist_ok=True)
            POS_FILE.write_text(json.dumps(self.offsets, ensure_ascii=False, indent=2),
                                encoding="utf-8")
        except Exception as e:
            dbg("save offsets error:", e)

    def _screen_rect(self):
        scr = QApplication.primaryScreen()
        dpr = scr.devicePixelRatio() or 1.0
        return scr.availableGeometry(), dpr

    def _corner(self):
        """返回 (右下角基准点, 模式, 屏幕几何)。ZCode 窗口找得到就用它的右下角"""
        geo, dpr = self._screen_rect()
        r = find_zcode_rect()
        if r:
            left, top, right, bottom = [v / dpr for v in r]
            return QPointF(right, bottom), "zc", geo
        return QPointF(geo.right(), geo.bottom()), "screen", geo

    def _target_pos(self):
        """收起态目标位置"""
        corner, mode, geo = self._corner()
        off = self.offsets.get(mode, DEFAULT_OFFSETS[mode])
        x = corner.x() + off["dx"]
        y = corner.y() + off["dy"]
        x = max(geo.left() + 4, min(x, geo.right() - W_COLLAPSED - 4))
        y = max(geo.top() + 4, min(y, geo.bottom() - H_COLLAPSED - 4))
        return QPointF(x, y)

    def _place_initial(self):
        if self.test_mode:
            return
        pos = self._target_pos()
        self.move(int(pos.x()), int(pos.y()))

    # ------------------------------------------------ 跟随 / 生命周期 / 轮询
    def _follow_step(self):
        if self.test_mode:
            return
        try:
            self._handle_cmd_file()

            r = find_zcode_rect()

            # 生命周期：随 ZCode 显隐
            if r:
                self.zc_seen = True
                self.zc_miss = 0
                if not self.isVisible():
                    self.show()
                    self._apply_geometry(self.expanded, len(self.sessions))
                    dbg("shown (zcode present)")
            else:
                if not self.zc_seen:
                    # 启动时 ZCode 还没起来：保持隐藏等待
                    if self.isVisible():
                        self.hide()
                else:
                    self.zc_miss += 1
                    if self.zc_miss >= 7 and self.isVisible():
                        if self.expanded:
                            self._collapse()
                        self.hide()
                        dbg("hidden (zcode gone/minimized)")

            if not self.isVisible():
                return

            # 位置跟随（仅收起态、非拖拽中）
            if r and not self.dragging and not self.expanded:
                pos = self._target_pos()
                cur = self._current_collapsed_pos()
                if abs(pos.x() - cur.x()) > 1 or abs(pos.y() - cur.y()) > 1:
                    self.move(int(pos.x()), int(pos.y()))

            # 会话缓存（约每 4 秒；展开时暂停刷新）
            self.scan_tick += 1
            if self.scan_tick % 9 == 0 and not self.expanded:
                fresh = scan_sessions()
                if fresh is not None:
                    if len(fresh) != len(self.sessions):
                        self.update()
                    self.sessions = fresh
        except Exception as e:
            dbg("follow error:", e)

    def _handle_cmd_file(self):
        try:
            if not CMD_FILE.exists():
                return
            j = json.loads(CMD_FILE.read_text(encoding="utf-8") or "{}")
            CMD_FILE.unlink(missing_ok=True)
            action = j.get("action")
            if action == "quit":
                self._quit()
            elif action == "reset-position":
                self.offsets = json.loads(json.dumps(DEFAULT_OFFSETS))
                self._save_offsets()
                self._apply_geometry(False)
                self._place_initial()
                self._bubble("位置已重置")
        except Exception as e:
            dbg("cmd file error:", e)

    # ------------------------------------------------ 交互
    def _hit_card(self, pos):
        return self._card_rect().adjusted(-6, -6, 6, 6).contains(QPointF(pos))

    def _hit_row(self, pos):
        p = QPointF(pos)
        for i, r in enumerate(self.row_rects):
            if r.contains(p):
                return i
        return -1

    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            if self.expanded:
                return  # 展开时不可拖拽
            self.dragging = True
            self.moved = False
            self.press_global = e.globalPosition()
            self.press_win = QPointF(self.x(), self.y())
            self.setCursor(QCursor(Qt.ClosedHandCursor))
        elif e.button() == Qt.RightButton:
            self._show_menu(e.globalPosition().toPoint())

    def mouseMoveEvent(self, e):
        if self.dragging:
            d = e.globalPosition() - self.press_global
            if abs(d.x()) + abs(d.y()) > 4:
                self.moved = True
            if self.moved:
                self.move(int(self.press_win.x() + d.x()), int(self.press_win.y() + d.y()))
            return
        if self.expanded:
            hv = self._hit_row(e.position())
            if hv != self.hover_row:
                self.hover_row = hv
                self.update()

    def mouseReleaseEvent(self, e):
        if e.button() != Qt.LeftButton:
            return

        if self.expanded:
            idx = self._hit_row(e.position())
            if idx >= 0 and idx < len(self.sessions):
                self._pick_session(idx)
            else:
                self._collapse()
            return

        if not self.dragging:
            return
        self.dragging = False
        self.setCursor(QCursor(Qt.ArrowCursor))
        if self.moved:
            corner, mode, _geo = self._corner()
            pos = self._current_collapsed_pos()
            self.offsets[mode] = {"dx": pos.x() - corner.x(), "dy": pos.y() - corner.y()}
            self._save_offsets()
            dbg("offsets saved:", self.offsets)
        elif self._hit_card(e.position()):
            self._on_main_click()

    def _show_menu(self, gpos):
        menu = QMenu(self)
        act_reset = QAction("重置位置", menu)
        act_reset.triggered.connect(lambda: self._reset_position())
        act_quit = QAction("退出挂件", menu)
        act_quit.triggered.connect(self._quit)
        menu.addAction(act_reset)
        menu.addSeparator()
        menu.addAction(act_quit)
        menu.exec(gpos)

    def _reset_position(self):
        self.offsets = json.loads(json.dumps(DEFAULT_OFFSETS))
        self._save_offsets()
        self._apply_geometry(False)
        self._place_initial()
        self._bubble("位置已重置")

    def _quit(self):
        dbg("quit requested")
        try:
            PID_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        QApplication.quit()

    # ------------------------------------------------ 会话选择 / 发送
    def _on_main_click(self):
        fresh = scan_sessions()
        if fresh is not None:
            self.sessions = fresh

        if len(self.sessions) >= 2:
            self._expand_picker()
            return
        if len(self.sessions) == 1:
            self._inject_to(self.sessions[0])
            return

        # 没有正在活动的会话
        if fresh is None:
            self._bubble("暂时读取不到 ZCode 会话，稍后再试")
        else:
            self._bubble("没有正在活动的会话；AI 停下来时直接在对话框输入即可")

    def _expand_picker(self):
        self._rebuild_row_rects()
        self._apply_geometry(True, len(self.sessions))
        dbg("picker opened with", len(self.sessions), "sessions")

    def _collapse(self):
        self.hover_row = -1
        self._apply_geometry(False)

    def _pick_session(self, idx):
        s = self.sessions[idx]
        self._collapse()
        self._inject_to(s)

    def _inject_to(self, s):
        now = time.time() * 1000
        if now - self.last_sent < COOLDOWN_MS:
            self._bubble("刚刚已经通知过啦，稍等一下～")
            return
        try:
            write_pending(session_hint=s.get("id"))
        except Exception as e:
            dbg("write_pending failed:", e)
            self._bubble("通知失败：" + str(e)[:40])
            return
        self.last_sent = now
        self.hop_start = time.time()
        self.status = "waiting"
        self.seq_index = 0
        title = (s.get("title") or "").strip()
        short = (title[:10] + "…") if len(title) > 10 else title
        self._bubble("已通知「%s」" % short if short else CLICK_SEQ[0])
        QTimer.singleShot(2200, lambda: self._bubble(CLICK_SEQ[1]))
        QTimer.singleShot(4400, lambda: self._bubble(CLICK_SEQ[2]))
        QTimer.singleShot(RESET_MS, self._reset_status)

    def _reset_status(self):
        if self.status == "waiting":
            self.status = "idle"
            self.seq_index = -1

    def _bubble(self, text, ms=2400):
        self.bubble_text = text
        self.bubble_until = time.time() + ms / 1000.0
        self.update()

    def _tick(self):
        self.t += 0.05
        self.update()

    # ------------------------------------------------ 绘制
    def paintEvent(self, _ev):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        p.setRenderHint(QPainter.TextAntialiasing, True)

        now = time.time()
        card = self._card_rect()

        # ---- 展开态：会话列表 ----
        if self.expanded:
            p.setFont(make_font(8.6))
            p.setPen(QPen(QColor(100, 112, 128)))
            p.drawText(QRectF(12, 4, self.width() - 24, HEADER_H),
                       Qt.AlignLeft | Qt.AlignVCenter, "要通知哪个会话？")

            self._rebuild_row_rects()
            p.setFont(make_font(8.8))
            fm = p.fontMetrics()
            for i, r in enumerate(self.row_rects):
                if i >= len(self.sessions):
                    break
                s = self.sessions[i]
                hover = (i == self.hover_row)
                path = QPainterPath()
                path.addRoundedRect(r, 9, 9)
                p.fillPath(path, QColor(238, 244, 255, 252) if hover else QColor(255, 255, 255, 252))
                p.setBrush(Qt.NoBrush)
                p.setPen(QPen(QColor(190, 212, 245) if hover else QColor(228, 234, 244), 1))
                p.drawPath(path)
                p.setPen(Qt.NoPen)

                # 右侧：最近活跃时间
                right = rel_time(s.get("at"))
                rw = fm.horizontalAdvance(right)
                p.setPen(QPen(QColor(150, 162, 178)))
                p.drawText(QRectF(r.right() - rw - 12, r.top(), rw, r.height()),
                           Qt.AlignRight | Qt.AlignVCenter, right)

                # 左侧：蓝点 + 标题
                p.setBrush(QBrush(QColor(59, 130, 246)))
                p.setPen(Qt.NoPen)
                p.drawEllipse(QPointF(r.left() + 15, r.center().y()), 3.5, 3.5)
                p.setPen(QPen(QColor(26, 34, 48)))
                tw = r.width() - rw - 44
                title = fm.elidedText(s.get("title") or "(未命名)", Qt.ElideRight, int(tw))
                p.drawText(QRectF(r.left() + 26, r.top(), tw, r.height()),
                           Qt.AlignLeft | Qt.AlignVCenter, title)

        # ---- 主卡片阴影 + 底 ----
        shadow = QPainterPath()
        shadow.addRoundedRect(card.adjusted(0, 3, 0, 3), 20, 20)
        p.fillPath(shadow, QColor(15, 40, 80, 26))

        cardp = QPainterPath()
        cardp.addRoundedRect(card, 20, 20)
        p.fillPath(cardp, QColor(255, 255, 255, 246))
        p.setBrush(Qt.NoBrush)
        p.setPen(QPen(QColor(226, 232, 240), 1))
        p.drawPath(cardp)
        p.setPen(Qt.NoPen)

        # ---- 鲸鱼 ----
        whale_x = 18
        whale_y = card.top() + 12
        hop_prog = min(1.0, (now - self.hop_start) / 0.62) if self.hop_start else 1.0
        hop_dy = 0.0
        if hop_prog < 1.0:
            hop_dy = -8 * math.sin(math.pi * hop_prog) * (1 - hop_prog * 0.4)
        bob = math.sin(self.t) * 1.6 if hop_prog >= 1.0 else 0.0
        whale_rect = QRectF(whale_x, whale_y + bob + hop_dy, 52, 52)
        if self.whale and self.whale.isValid():
            self.whale.render(p, "whale", whale_rect)
            if hop_prog < 1.0:
                p.save()
                p.setOpacity(1.0 - abs(hop_prog - 0.4) / 0.6)
                self.whale.render(p, "spout", whale_rect)
                p.restore()
        else:
            p.setBrush(QBrush(QColor(111, 182, 255)))
            p.drawEllipse(whale_rect)

        # ---- 文本 ----
        base_y = card.top()
        p.setFont(make_font(10.2, bold=True))
        p.setPen(QPen(QColor(26, 34, 48)))
        p.drawText(QRectF(84, base_y + 16, self.width() - 96, 22), Qt.AlignLeft | Qt.AlignVCenter, "补充提示挂件")

        p.setFont(make_font(8.6))
        p.setPen(QPen(QColor(100, 112, 128)))
        status_text = "已通知 AI，等它来提问…" if self.status == "waiting" else "点我，AI 马上来问你"
        p.drawText(QRectF(96, base_y + 39, self.width() - 110, 20), Qt.AlignLeft | Qt.AlignVCenter, status_text)

        dot_x, dot_y, dot_r = 88.0, base_y + 49.0, 4.0
        if self.status == "waiting":
            pulse = 0.55 + 0.45 * (0.5 + 0.5 * math.sin(now * 4.2))
            p.setBrush(QBrush(QColor(232, 147, 12, int(255 * pulse))))
        else:
            p.setBrush(QBrush(QColor(154, 164, 178)))
        p.drawEllipse(QPointF(dot_x, dot_y), dot_r, dot_r)

        # ---- 多会话角标（收起态）：卡片右上角小圆点 ----
        if not self.expanded and len(self.sessions) >= 2:
            bc = QPointF(card.right() - 11, card.top() + 11)
            p.setBrush(QBrush(QColor(59, 130, 246)))
            p.setPen(Qt.NoPen)
            p.drawEllipse(bc, 10, 10)
            p.setFont(make_font(7.5, bold=True))
            p.setPen(QPen(QColor(255, 255, 255)))
            label = str(len(self.sessions)) if len(self.sessions) <= 9 else "9+"
            p.drawText(QRectF(bc.x() - 10, bc.y() - 10, 20, 20), Qt.AlignCenter, label)

        # ---- 气泡（仅收起态） ----
        if not self.expanded and self.bubble_text and now < self.bubble_until:
            p.setFont(make_font(8.8))
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(self.bubble_text)
            bw = min(self.width() - 20.0, tw + 26)
            bh = 30.0
            bx = (self.width() - bw) / 2.0
            by = 8.0
            bpath = QPainterPath()
            bpath.addRoundedRect(QRectF(bx, by, bw, bh), 12, 12)
            p.fillPath(bpath, QColor(255, 255, 255, 250))
            p.setBrush(Qt.NoBrush)
            p.setPen(QPen(QColor(226, 232, 240), 1))
            p.drawPath(bpath)
            p.setPen(Qt.NoPen)
            tail = QPainterPath()
            tail.moveTo(self.width() / 2 - 6, by + bh - 1)
            tail.lineTo(self.width() / 2, by + bh + 7)
            tail.lineTo(self.width() / 2 + 6, by + bh - 1)
            p.fillPath(tail, QColor(255, 255, 255, 250))
            p.setPen(QPen(QColor(72, 84, 100)))
            p.drawText(QRectF(bx, by, bw, bh), Qt.AlignCenter, self.bubble_text)

        p.end()


# ---------------------------------------------------------------- 测试渲染

def run_render_test(path, state="idle"):
    app = QApplication(sys.argv[:1])
    w = Overlay(test_mode=True)
    if state == "clicked":
        w.last_sent = time.time() * 1000
        w.status = "waiting"
        w.bubble_text = CLICK_SEQ[0]
        w.bubble_until = time.time() + 60
        w.hop_start = 0
    elif state == "sessions":
        w.sessions = [
            {"id": "s1", "title": "做 ZCode 版补充提示挂件", "at": time.time() * 1000 - 60_000, "status": "running"},
            {"id": "s2", "title": "优化手写输入法项目", "at": time.time() * 1000 - 3 * 60_000, "status": "active"},
            {"id": "s3", "title": "查找 ShaderToy 网站", "at": time.time() * 1000 - 100 * 60_000, "status": "active"},
        ]
        w._apply_geometry(True, 3)
    elif state == "badge":
        w.sessions = [
            {"id": "s1", "title": "做 ZCode 版补充提示挂件", "at": time.time() * 1000, "status": "running"},
            {"id": "s2", "title": "优化手写输入法项目", "at": time.time() * 1000 - 3 * 60_000, "status": "active"},
        ]
    img = QPixmap(w.width() * 3, w.height() * 3)
    img.setDevicePixelRatio(3.0)
    img.fill(Qt.transparent)
    w.render(img)
    img.save(path)
    print("saved", path, w.width(), "x", w.height())


def main():
    if "--stop" in sys.argv:
        stop_running()
        return

    if "--render-test" in sys.argv:
        i = sys.argv.index("--render-test")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else "overlay.png"
        state = "idle"
        if "--state" in sys.argv:
            j = sys.argv.index("--state")
            if len(sys.argv) > j + 1:
                state = sys.argv[j + 1]
        run_render_test(out, state)
        return

    mutex = acquire_single_instance()
    if mutex is None:
        dbg("another instance is running, exit")
        return

    # 清理上次残留的命令文件（避免旧的 quit 指令导致刚启动就退出）
    try:
        CMD_FILE.unlink(missing_ok=True)
    except Exception:
        pass

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)

    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        PID_FILE.write_text(str(os.getpid()), encoding="utf-8")
    except Exception as e:
        dbg("pid file error:", e)

    w = Overlay()
    w.show()
    dbg("overlay started, pid", os.getpid())
    app.exec()

    try:
        PID_FILE.unlink(missing_ok=True)
    except Exception:
        pass


if __name__ == "__main__":
    main()
