"""The tower camera's adjustments (an MX Brio on top of the Portrait), set straight through V4L2: the
standard controls (brightness, exposure, white balance, focus, zoom, pan, tilt, anti-flicker) and the
Brio's field of view, which Logitech keeps in a vendor control unit (GUID 49e40215..., selector 5;
the same one the cameractrls project uses). The camera's light has no control on this model.

Used by tower_eyes.py: values are kept in camera.json in the hologram's config folder and applied
again whenever the camera starts (the camera forgets them when it loses power).
"""
import ctypes
import fcntl
import os
import re
import struct
import subprocess

VIDIOC_G_CTRL, VIDIOC_S_CTRL, VIDIOC_QUERYCTRL = 0xC008561B, 0xC008561C, 0xC0445624
UVCIOC_CTRL_QUERY = 0xC0107521
UVC_SET_CUR, UVC_GET_CUR = 0x01, 0x81
BRIO_XU_GUID = "49e40215-f434-47fe-b158-0e885023e51b"
FOV_SELECTOR, FOV_VALUES = 5, {90: 0, 78: 1, 65: 2}

# The adjustments shown in the Choom app's Camera tab, in order, by V4L2 control id.
CONTROLS = {
    "brightness": 0x980900, "contrast": 0x980901, "saturation": 0x980902, "sharpness": 0x98091B,
    "backlight_compensation": 0x98091C, "gain": 0x980913,
    "white_balance_auto": 0x98090C, "white_balance_temperature": 0x98091A,
    "exposure_auto": 0x9A0901, "exposure": 0x9A0902,
    "focus_auto": 0x9A090C, "focus": 0x9A090A,
    "zoom": 0x9A090D, "pan": 0x9A0908, "tilt": 0x9A0909,
    "power_line_frequency": 0x980918,
}
# Set in this order, so a manual value lands after its automatic switch is turned off.
ORDER = ["white_balance_auto", "exposure_auto", "focus_auto"] + [n for n in CONTROLS if not n.endswith("_auto")]


class _XuQuery(ctypes.Structure):
    _fields_ = [("unit", ctypes.c_uint8), ("selector", ctypes.c_uint8), ("query", ctypes.c_uint8),
                ("size", ctypes.c_uint16), ("data", ctypes.POINTER(ctypes.c_uint8))]


class CameraControls:
    def __init__(self, index, usb_id=None):
        self.path = f"/dev/video{index}"
        self.usb_id = usb_id
        self._xu_unit = None

    def _fd(self):
        return os.open(self.path, os.O_RDWR | os.O_NONBLOCK)

    def describe(self):
        """{name: {value, min, max, step, default}} for every control the camera has."""
        out, fd = {}, self._fd()
        try:
            for name, cid in CONTROLS.items():
                q = bytearray(68)
                struct.pack_into("I", q, 0, cid)
                try:
                    fcntl.ioctl(fd, VIDIOC_QUERYCTRL, q)
                except OSError:
                    continue
                mn, mx, step, default = struct.unpack_from("iiii", q, 40)
                c = bytearray(struct.pack("Ii", cid, 0))
                try:
                    fcntl.ioctl(fd, VIDIOC_G_CTRL, c)
                    value = struct.unpack("Ii", c)[1]
                except OSError:
                    value = default
                out[name] = {"value": value, "min": mn, "max": mx, "step": step, "default": default}
        finally:
            os.close(fd)
        fov = self.get_fov()
        if fov is not None:
            out["field_of_view"] = {"value": fov, "options": sorted(FOV_VALUES)}
        return out

    def set(self, values):
        """Apply {name: value}; returns the names that took (a manual value is refused while its
        automatic switch is on, so the automatic ones go first)."""
        done, fd = [], self._fd()
        try:
            for name in [n for n in ORDER if n in values]:
                c = bytearray(struct.pack("Ii", CONTROLS[name], int(values[name])))
                try:
                    fcntl.ioctl(fd, VIDIOC_S_CTRL, c)
                    done.append(name)
                except OSError:
                    pass
        finally:
            os.close(fd)
        if "field_of_view" in values and self.set_fov(int(values["field_of_view"])):
            done.append("field_of_view")
        return done

    # --- the Brio's field of view, in Logitech's vendor control unit ---------------------------
    def xu_unit(self):
        if self._xu_unit is None and self.usb_id:
            try:
                text = subprocess.run(["lsusb", "-v", "-d", self.usb_id], capture_output=True, text=True, timeout=10).stdout
                units = re.findall(r"bUnitID\s+(\d+)\s+guidExtensionCode\s+\{([0-9a-f-]+)\}", text, re.I)
                self._xu_unit = next((int(u) for u, g in units if g.lower() == BRIO_XU_GUID), 0)
            except Exception:
                self._xu_unit = 0
        return self._xu_unit or None

    def _xu(self, selector, query, data):
        unit = self.xu_unit()
        if unit is None:
            return None
        buf = (ctypes.c_uint8 * len(data))(*data)
        fd = self._fd()
        try:
            fcntl.ioctl(fd, UVCIOC_CTRL_QUERY, _XuQuery(unit, selector, query, len(data), buf))
            return bytes(buf)
        except OSError:
            return None
        finally:
            os.close(fd)

    def get_fov(self):
        raw = self._xu(FOV_SELECTOR, UVC_GET_CUR, [0])
        return None if raw is None else {v: k for k, v in FOV_VALUES.items()}.get(raw[0])

    def set_fov(self, degrees):
        if degrees not in FOV_VALUES:
            return False
        return self._xu(FOV_SELECTOR, UVC_SET_CUR, [FOV_VALUES[degrees]]) is not None
