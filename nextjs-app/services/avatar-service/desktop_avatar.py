#!/usr/bin/env python3
"""
Desktop Floating Avatar — draggable, always-on-top, semi-transparent
avatar window on the desktop. Right-click for opacity and close.

Usage:
  python3 desktop_avatar.py [--choom NAME] [--opacity 0.85] [--size 300]
  python3 desktop_avatar.py --image /path/to/photo.png  # test mode
"""

import sys
import os
import argparse
import base64
import json
import sqlite3

import numpy as np
from PIL import Image as PILImage
from io import BytesIO

from PyQt6.QtWidgets import QApplication, QWidget, QLabel, QMenu
from PyQt6.QtCore import Qt, QTimer, QPoint
from PyQt6.QtGui import QPixmap, QAction, QCursor, QBitmap, QImage, QRegion


DB_PATH = os.path.expanduser("~/projects/Choom/nextjs-app/prisma/dev.db")

# Background colors to detect and make transparent
BG_COLORS = [
    (0x15, 0x0d, 0x21),  # Choom dark purple
    (0x0f, 0x0a, 0x1a),  # Choom darker variant
    (0x00, 0x00, 0x00),  # Pure black
    (0x1a, 0x10, 0x25),  # Another dark purple variant
]
BG_TOLERANCE = 40  # color distance threshold


def create_mask_from_image(pixmap: QPixmap) -> QBitmap:
    """Create a window mask using flood-fill from corners to find background.

    Detects background color from corner pixels, flood-fills from edges,
    then erodes to remove dark fringe and smooths for clean edges.
    """
    from scipy.ndimage import binary_dilation, binary_erosion, binary_fill_holes, gaussian_filter
    from PIL import Image as PILImg

    # Convert QPixmap to numpy
    qimg = pixmap.toImage().convertToFormat(QImage.Format.Format_RGBA8888)
    w, h = qimg.width(), qimg.height()
    ptr = qimg.bits()
    ptr.setsize(w * h * 4)
    arr = np.frombuffer(ptr, dtype=np.uint8).reshape(h, w, 4).copy()
    rgb = arr[:, :, :3].astype(float)

    # Sample background color from corner regions
    cs = max(5, min(w, h) // 20)
    corners = [rgb[:cs, :cs], rgb[:cs, -cs:], rgb[-cs:, :cs], rgb[-cs:, -cs:]]
    bg_color = np.mean([c.reshape(-1, 3).mean(axis=0) for c in corners], axis=0)
    print(f"[DesktopAvatar] BG color: RGB({bg_color[0]:.0f},{bg_color[1]:.0f},{bg_color[2]:.0f})")

    # Find pixels similar to background (tolerance 30)
    dist = np.sqrt(np.sum((rgb - bg_color) ** 2, axis=2))
    is_bg = dist < 30

    # Flood-fill from border pixels
    border = np.zeros((h, w), dtype=bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    bg_mask = border & is_bg
    for _ in range(max(w, h)):
        grown = binary_dilation(bg_mask) & is_bg
        new = grown | bg_mask
        if np.array_equal(new, bg_mask):
            break
        bg_mask = new

    # Foreground with holes filled
    fg = binary_fill_holes(~bg_mask)

    # Erode to trim dark fringe, minimal dilation back
    fg = binary_erosion(fg, iterations=2)
    fg = binary_dilation(fg, iterations=1)

    # Smooth edges
    fg_float = gaussian_filter(fg.astype(float), sigma=2.5)
    fg_smooth = fg_float > 0.4

    fg_pct = fg_smooth.sum() / (h * w) * 100
    print(f"[DesktopAvatar] Mask: {fg_pct:.0f}% foreground")

    # QBitmap: BLACK=visible, WHITE=invisible
    mask_gray = np.where(fg_smooth, 0, 255).astype(np.uint8)
    PILImg.fromarray(mask_gray, mode='L').save('/tmp/_avatar_mask.bmp')
    return QBitmap('/tmp/_avatar_mask.bmp')


class AvatarWindow(QWidget):
    def __init__(self, opacity: float = 0.85, size: int = 300):
        super().__init__()
        self._drag_pos = None
        self._original_pixmap = None
        self._size = size

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.WindowStaysOnTopHint |
            Qt.WindowType.Tool
        )
        self.setWindowOpacity(opacity)
        self.setStyleSheet("background-color: black;")
        self.resize(size, int(size * 1.33))

        self.label = QLabel(self)
        self.label.setAlignment(Qt.AlignmentFlag.AlignCenter)

        # Position bottom-right
        screen = QApplication.primaryScreen()
        if screen:
            geo = screen.availableGeometry()
            self.move(geo.right() - size - 30, geo.bottom() - int(size * 1.33) - 30)

        # Right-click menu
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._context_menu)

    def set_image(self, pixmap: QPixmap):
        self._original_pixmap = pixmap
        self._update_display()

    def set_image_from_file(self, path: str):
        pixmap = QPixmap(path)
        if not pixmap.isNull():
            self.set_image(pixmap)
            print(f"[DesktopAvatar] Loaded: {pixmap.width()}x{pixmap.height()}")

    def set_image_from_base64(self, data_uri: str):
        b64 = data_uri.split(",", 1)[1] if "," in data_uri else data_uri
        raw = base64.b64decode(b64)
        pixmap = QPixmap()
        pixmap.loadFromData(raw)
        if not pixmap.isNull():
            self.set_image(pixmap)

    def _update_display(self):
        if self._original_pixmap:
            scaled = self._original_pixmap.scaled(
                self.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            self.label.setPixmap(scaled)
            self.label.resize(self.size())
            self._update_mask()

    def _update_mask(self):
        """Apply window mask to cut out background pixels."""
        if self._original_pixmap:
            scaled = self._original_pixmap.scaled(
                self.size(),
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            try:
                mask = create_mask_from_image(scaled)
                self.setMask(QRegion(mask))
            except Exception as e:
                print(f"[DesktopAvatar] Mask error: {e}")

    def resizeEvent(self, event):
        super().resizeEvent(event)
        self._update_display()

    # --- Dragging ---
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self._drag_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()

    def mouseMoveEvent(self, event):
        if self._drag_pos and event.buttons() == Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self._drag_pos)
            event.accept()

    def mouseReleaseEvent(self, event):
        self._drag_pos = None

    # --- Resize with scroll wheel ---
    def wheelEvent(self, event):
        event.accept()
        delta = event.angleDelta().y()
        scale = 1.08 if delta > 0 else 0.92
        w = max(100, min(800, int(self.width() * scale)))
        h = max(133, min(1066, int(self.height() * scale)))
        self.resize(w, h)

    # --- Right-click menu ---
    def _context_menu(self, pos):
        menu = QMenu(self)

        opacity_menu = menu.addMenu("Opacity")
        for pct in [100, 85, 70, 50, 30]:
            action = opacity_menu.addAction(f"{pct}%")
            action.triggered.connect(lambda _, v=pct: self.setWindowOpacity(v / 100))

        menu.addSeparator()

        reset = menu.addAction("Reset Position")
        reset.triggered.connect(self._reset_pos)

        menu.addSeparator()

        close = menu.addAction("Close Avatar")
        close.triggered.connect(self.close)

        menu.exec(self.mapToGlobal(pos))

    def _reset_pos(self):
        screen = QApplication.primaryScreen()
        if screen:
            geo = screen.availableGeometry()
            self.move(geo.right() - self.width() - 30, geo.bottom() - self.height() - 30)


def load_choom_avatar(name: str) -> str | None:
    """Load a Choom's avatar from the database."""
    try:
        db = sqlite3.connect(DB_PATH)
        row = db.execute("SELECT avatarUrl FROM Choom WHERE name = ? COLLATE NOCASE", (name,)).fetchone()
        db.close()
        if row and row[0]:
            return row[0]
    except Exception as e:
        print(f"[DesktopAvatar] DB error: {e}")
    return None


def main():
    parser = argparse.ArgumentParser(description="Choom Desktop Avatar")
    parser.add_argument("--choom", type=str, help="Choom name to display")
    parser.add_argument("--image", type=str, help="Image file path (test mode)")
    parser.add_argument("--opacity", type=float, default=0.85)
    parser.add_argument("--size", type=int, default=300)
    args = parser.parse_args()

    app = QApplication(sys.argv)
    app.setApplicationName("Choom Desktop Avatar")

    window = AvatarWindow(opacity=args.opacity, size=args.size)

    if args.image:
        window.set_image_from_file(args.image)
    elif args.choom:
        avatar_data = load_choom_avatar(args.choom)
        if avatar_data:
            window.set_image_from_base64(avatar_data)
            print(f"[DesktopAvatar] Loaded {args.choom}'s avatar from database")
        else:
            print(f"[DesktopAvatar] No avatar found for '{args.choom}'")
            sys.exit(1)
    else:
        # Default: load first Choom with an avatar
        try:
            db = sqlite3.connect(DB_PATH)
            row = db.execute("SELECT name, avatarUrl FROM Choom WHERE avatarUrl IS NOT NULL LIMIT 1").fetchone()
            db.close()
            if row:
                window.set_image_from_base64(row[1])
                print(f"[DesktopAvatar] Loaded {row[0]}'s avatar")
        except Exception as e:
            print(f"[DesktopAvatar] Error: {e}")
            sys.exit(1)

    window.show()
    print(f"[DesktopAvatar] Window open ({args.size}px, {args.opacity*100:.0f}% opacity)")
    print(f"  Drag: left-click")
    print(f"  Resize: scroll wheel")
    print(f"  Menu: right-click")

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
