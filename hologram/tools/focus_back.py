#!/usr/bin/env python3
"""Hand the keyboard back after the glass opens.

The glass page takes the keyboard focus when its window opens, so a relaunch while Donny was typing in
his terminal sent his next keystroke to the glass: a space paused her particles, Optic's scan line and
Aloy's orbs for hours (2026-10-15). launch.sh notes which window had the focus before it starts Chrome
and runs this with that window and the glass's Chrome profile; once the glass has taken the focus
(within 20 seconds), this asks the window manager to give it back.

    focus_back.py <window id> <chrome profile dir>
"""
import ctypes
import ctypes.util
import subprocess
import sys
import time


def active_window():
    out = subprocess.run(["xprop", "-root", "_NET_ACTIVE_WINDOW"], capture_output=True, text=True).stdout
    return out.split()[-1] if out.strip() else ""


def window_class(win):
    return subprocess.run(["xprop", "-id", win, "WM_CLASS"], capture_output=True, text=True).stdout


class XClientMessageEvent(ctypes.Structure):
    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),
                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong), ("message_type", ctypes.c_ulong),
                ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]


class XEvent(ctypes.Union):
    _fields_ = [("xclient", XClientMessageEvent), ("pad", ctypes.c_long * 24)]


def activate(win):
    """_NET_ACTIVE_WINDOW from a pager (source 2): the window manager raises and focuses it."""
    x11 = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11"))
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.POINTER(XEvent)]
    x11.XFlush.argtypes = x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    dpy = x11.XOpenDisplay(None)
    if not dpy:
        return False
    root = x11.XDefaultRootWindow(dpy)
    ev = XEvent()
    ev.xclient.type = 33  # ClientMessage
    ev.xclient.send_event = 1
    ev.xclient.window = int(win, 16)
    ev.xclient.message_type = x11.XInternAtom(dpy, b"_NET_ACTIVE_WINDOW", 0)
    ev.xclient.format = 32
    ev.xclient.l[0] = 2  # source: a pager, so focus-stealing prevention doesn't refuse it
    x11.XSendEvent(dpy, root, 0, (1 << 19) | (1 << 20), ctypes.byref(ev))  # SubstructureNotify|Redirect
    x11.XFlush(dpy)
    x11.XCloseDisplay(dpy)
    return True


def main():
    win, profile = sys.argv[1], sys.argv[2]
    if not window_class(win).strip() or profile in window_class(win):
        return  # gone, or it was the old glass itself
    deadline = time.time() + 20
    while time.time() < deadline:
        now = active_window()
        if now and now != win and profile in window_class(now):
            time.sleep(0.5)  # let the glass finish mapping before taking the focus back
            if window_class(win).strip():
                activate(win)
            return
        time.sleep(0.2)


if __name__ == "__main__":
    main()
