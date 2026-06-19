#!/usr/bin/env python3
"""
Native messaging host for Computer Use Chrome Extension.
Implements Chrome Native Messaging protocol: 4-byte uint32 length prefix + JSON payload over stdin/stdout.
Delegates system operations to mac-use.py (cliclick, screencapture, AppleScript).
"""

import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

MAC_USE = os.path.expanduser("~/.local/bin/mac-use")
PROJECT_DIR = Path(__file__).parent.resolve()
OCR_BIN = str(PROJECT_DIR / "ocr")


def read_message():
    """Read one native message from stdin."""
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    msg_len = struct.unpack('=I', raw_len)[0]
    if msg_len > 1024 * 1024:
        raise ValueError(f"Message too large: {msg_len}")
    return json.loads(sys.stdin.buffer.read(msg_len).decode('utf-8'))


def write_message(data):
    """Write one native message to stdout."""
    payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('=I', len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def respond(msg, data):
    """Send a response message."""
    write_message({"id": msg.get("id"), **data})


def run_mac_use(args, timeout=30):
    """Call mac-use.py with args, return stdout, stderr, returncode."""
    result = subprocess.run(
        [MAC_USE] + args,
        capture_output=True, text=True, timeout=timeout
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def run_osa(script, timeout=10):
    """Run AppleScript via osascript. Supports multi-line scripts."""
    lines = [l for l in script.strip().split('\n') if l.strip() and not l.strip().startswith('--')]
    args = ["osascript"]
    for line in lines:
        args.extend(["-e", line.strip()])
    result = subprocess.run(
        args,
        capture_output=True, text=True, timeout=timeout
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


# ── Message Handlers ──────────────────────────────────────────────

def handle_screenshot(msg):
    path = os.path.expanduser("~/.cache/mac-use-screenshots")
    os.makedirs(path, exist_ok=True)
    ts = int(time.time() * 1000)
    out = f"{path}/cu_screenshot_{ts}.png"
    subprocess.run(["screencapture", "-x", out], timeout=10)
    return {"type": "screenshot_response", "path": out, "status": "ok"}


def handle_ocr_screenshot(msg):
    """Run Apple Vision OCR on a screenshot (or specified image path)."""
    path = msg.get("path", "")
    if not path:
        # Take a fresh screenshot
        path = os.path.expanduser("~/.cache/mac-use-screenshots")
        os.makedirs(path, exist_ok=True)
        ts = int(time.time() * 1000)
        path = f"{path}/cu_ocr_{ts}.png"
        subprocess.run(["screencapture", "-x", path], timeout=10)

    if not os.path.exists(path):
        return {"type": "ocr_response", "status": "failed", "error": f"Image not found: {path}"}

    try:
        result = subprocess.run(
            [OCR_BIN, path],
            capture_output=True, text=True, timeout=30
        )
        if result.returncode != 0:
            return {"type": "ocr_response", "status": "failed", "error": result.stderr.strip() or result.stdout.strip()}

        data = json.loads(result.stdout)
        return {
            "type": "ocr_response",
            "path": path,
            "imageWidth": data["imageWidth"],
            "imageHeight": data["imageHeight"],
            "blocks": data["blocks"],
            "status": "ok"
        }
    except json.JSONDecodeError as e:
        return {"type": "ocr_response", "status": "failed", "error": f"JSON parse error: {e}, raw: {result.stdout[:200]}"}
    except subprocess.TimeoutExpired:
        return {"type": "ocr_response", "status": "failed", "error": "OCR timed out"}
    except Exception as e:
        return {"type": "ocr_response", "status": "failed", "error": str(e)}


def handle_accessibility_tree(msg):
    """Get the AX element tree of the frontmost app via System Events."""
    script = '''
tell application "System Events"
    set frontApp to name of first process whose frontmost is true
end tell
tell application "System Events"
    tell process frontApp
        set windowCount to count of windows
        if windowCount = 0 then return "{\\"windows\\":0}"
        set allUI to every UI element of window 1
        set output to ""
        repeat with el in allUI
            try
                set r to role of el
                set d to ""
                try
                    set d to description of el
                end try
                set t to ""
                try
                    set t to title of el
                end try
                set p to position of el
                set sz to size of el
                set output to output & r & "|" & t & "|" & d & "|" & (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of sz) & "x" & (item 2 of sz) & "\\n"
            end try
        end repeat
        return output
    end tell
end tell
'''
    stdout, stderr, rc = run_osa(script)
    if rc != 0:
        return {"type": "accessibility_tree_response", "status": "failed", "error": stderr}

    elements = []
    for line in stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split("|", 3)
        if len(parts) == 4:
            role, title, desc, pos = parts
            # Parse position "x,y,wxh" → {x, y, w, h}
            try:
                pos_parts = pos.replace("x", ",").split(",")
                elements.append({
                    "role": role,
                    "title": title if title != "missing value" else "",
                    "description": desc if desc != "missing value" else "",
                    "x": int(pos_parts[0]),
                    "y": int(pos_parts[1]),
                    "w": int(pos_parts[2]),
                    "h": int(pos_parts[3])
                })
            except (IndexError, ValueError):
                elements.append({"role": role, "title": title, "description": desc, "rawPos": pos})

    return {
        "type": "accessibility_tree_response",
        "app": "frontmost",
        "elements": elements,
        "count": len(elements),
        "status": "ok"
    }


def handle_mouse_move(msg):
    x, y = msg["x"], msg["y"]
    subprocess.run(["/Users/damondeng/.local/bin/cliclick", f"m:{x},{y}"], timeout=5)
    return {"type": "mouse_move_response", "x": x, "y": y, "status": "ok"}


def handle_mouse_click(msg):
    x, y = msg["x"], msg["y"]
    subprocess.run(["/Users/damondeng/.local/bin/cliclick", f"c:{x},{y}"], timeout=5)
    return {"type": "mouse_click_response", "x": x, "y": y, "status": "ok"}


def handle_mouse_double_click(msg):
    x, y = msg["x"], msg["y"]
    subprocess.run(["/Users/damondeng/.local/bin/cliclick", f"dc:{x},{y}"], timeout=5)
    return {"type": "mouse_double_click_response", "x": x, "y": y, "status": "ok"}


def handle_mouse_scroll(msg):
    delta = msg.get("delta", 1)
    x = msg.get("x")
    y = msg.get("y")
    args = [f"w:{delta}"]
    if x is not None and y is not None:
        args = [f"w:{delta}", f"{x},{y}"]
    subprocess.run(["/Users/damondeng/.local/bin/cliclick"] + args, timeout=5)
    return {"type": "mouse_scroll_response", "delta": delta, "status": "ok"}


def handle_mouse_position(msg):
    stdout, _, _ = run_mac_use(["mouse", "position"])
    try:
        pos = json.loads(stdout)
        return {"type": "mouse_position_response", "x": pos["x"], "y": pos["y"], "status": "ok"}
    except Exception:
        out = subprocess.run(["/Users/damondeng/.local/bin/cliclick", "p"], capture_output=True, text=True, timeout=5)
        x, y = out.stdout.strip().split(",")
        return {"type": "mouse_position_response", "x": int(x), "y": int(y), "status": "ok"}


def handle_type_text(msg):
    text = msg["text"]
    # Copy to clipboard then paste (handles Unicode reliably)
    p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
    p.communicate(text.encode("utf-8"))
    time.sleep(0.1)
    subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to keystroke "v" using {command down}'],
        timeout=5
    )
    return {"type": "type_text_response", "length": len(text), "status": "ok"}


def handle_key_press(msg):
    shortcut = msg["shortcut"]
    # Parse shortcut like "cmd+r", "cmd+shift+o", "ctrl+alt+delete"
    parts = shortcut.lower().split("+")
    key = parts[-1]
    modifiers = parts[:-1]

    modifier_map = {
        "cmd": "command down",
        "command": "command down",
        "ctrl": "control down",
        "control": "control down",
        "alt": "option down",
        "option": "option down",
        "shift": "shift down",
    }

    using_clause = ""
    if modifiers:
        mods = ", ".join(modifier_map[m] for m in modifiers if m in modifier_map)
        if mods:
            using_clause = f" using {{{mods}}}"

    # Map common keys to AppleScript key codes / keystroke names
    special_keys = {
        "enter": "return",
        "return": "return",
        "tab": "tab",
        "escape": "escape",
        "esc": "escape",
        "delete": "delete",
        "backspace": "delete",
        "space": "space",
        "up": "up-arrow",
        "down": "down-arrow",
        "left": "left-arrow",
        "right": "right-arrow",
        "home": "home",
        "end": "end",
        "pageup": "page-up",
        "pagedown": "page-down",
        "f1": "f1", "f2": "f2", "f3": "f3", "f4": "f4",
        "f5": "f5", "f6": "f6", "f7": "f7", "f8": "f8",
        "f9": "f9", "f10": "f10", "f11": "f11", "f12": "f12",
    }

    if key in special_keys:
        script = f'tell application "System Events" to keystroke {special_keys[key]}{using_clause}'
    else:
        # Regular character key
        script = f'tell application "System Events" to keystroke "{key}"{using_clause}'

    run_osa(script)
    return {"type": "key_press_response", "shortcut": shortcut, "status": "ok"}


def handle_window_geometry(msg):
    """Get Chrome front window position and size."""
    # Use direct Chrome AppleScript (works without System Events Accessibility)
    stdout, stderr, rc = run_osa(
        'tell application "Google Chrome" to get bounds of window 1'
    )
    if rc != 0:
        return {"type": "window_geometry_response", "status": "failed", "error": stderr}
    # Returns: left, top, right, bottom
    parts = stdout.split(",")
    left = int(parts[0].strip())
    top = int(parts[1].strip())
    right = int(parts[2].strip())
    bottom = int(parts[3].strip())
    return {
        "type": "window_geometry_response",
        "screenX": left,
        "screenY": top,
        "outerW": right - left,
        "outerH": bottom - top,
        "status": "ok"
    }


def handle_file_chooser_select(msg):
    """Open file via Cmd+Shift+G in Finder chooser, type full path, confirm."""
    path = msg["path"]
    # Cmd+Shift+G to open Go to Folder
    subprocess.run(
        ["osascript", "-e",
         'tell application "System Events" to keystroke "g" using {command down, shift down}'],
        timeout=5
    )
    time.sleep(0.5)
    # Type the path via clipboard paste
    p = subprocess.Popen(["pbcopy"], stdin=subprocess.PIPE)
    p.communicate(path.encode("utf-8"))
    time.sleep(0.1)
    subprocess.run(
        ["osascript", "-e",
         'tell application "System Events" to keystroke "v" using {command down}'],
        timeout=5
    )
    time.sleep(0.3)
    # Press Enter (confirm path)
    subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to key code 36'],
        timeout=5
    )
    time.sleep(0.3)
    # Press Enter again (confirm file selection)
    subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to key code 36'],
        timeout=5
    )
    return {"type": "file_chooser_response", "path": path, "status": "ok"}


def handle_app_focus(msg):
    name = msg.get("name", "Google Chrome")
    run_osa(f'tell application "{name}" to activate')
    return {"type": "app_focus_response", "name": name, "status": "ok"}


def handle_ping(msg):
    """Health check — verify cliclick is installed and accessible."""
    try:
        subprocess.run(["which", "/Users/damondeng/.local/bin/cliclick"], capture_output=True, check=True, timeout=5)
        return {"type": "pong", "/Users/damondeng/.local/bin/cliclick": True, "mac_use": os.path.exists(MAC_USE), "status": "ok"}
    except subprocess.CalledProcessError:
        return {"type": "pong", "/Users/damondeng/.local/bin/cliclick": False, "error": "cliclick not found. Install: brew install cliclick", "status": "failed"}


# ── Dispatch ──────────────────────────────────────────────────────

DISPATCH = {
    "screenshot": handle_screenshot,
    "ocr_screenshot": handle_ocr_screenshot,
    "accessibility_tree": handle_accessibility_tree,
    "mouse_move": handle_mouse_move,
    "mouse_click": handle_mouse_click,
    "mouse_double_click": handle_mouse_double_click,
    "mouse_scroll": handle_mouse_scroll,
    "mouse_position": handle_mouse_position,
    "type_text": handle_type_text,
    "key_press": handle_key_press,
    "window_geometry": handle_window_geometry,
    "file_chooser_select": handle_file_chooser_select,
    "app_focus": handle_app_focus,
    "ping": handle_ping,
}


def main():
    while True:
        msg = read_message()
        if msg is None:
            break

        msg_type = msg.get("type")
        handler = DISPATCH.get(msg_type)

        if handler:
            try:
                response = handler(msg)
                respond(msg, response)
            except Exception as e:
                respond(msg, {
                    "type": "error",
                    "message": str(e),
                    "request_type": msg_type,
                    "status": "failed"
                })
        else:
            respond(msg, {
                "type": "error",
                "message": f"Unknown message type: {msg_type}",
                "status": "failed"
            })


if __name__ == "__main__":
    main()
