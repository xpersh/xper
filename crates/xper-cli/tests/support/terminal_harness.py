"""Exercise the actual binary on a POSIX PTY, without host settings or credentials."""

import contextlib
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time


def deadline_expired(_signal, _frame):
    raise TimeoutError("terminal integration exceeded its 60-second deadline")


signal.signal(signal.SIGALRM, deadline_expired)
signal.alarm(60)
binary = sys.argv[1]
version = sys.argv[2]
test_binary = sys.argv[3]
roles = [
    "discovery.explorer", "define.product", "design.designer", "breakdown.slicer",
    "plan.planner", "implementation.driver", "verify.verifier", "judgment_day.judge",
]
node_binary = subprocess.check_output(
    ["node", "-p", "process.execPath"], timeout=3,
    env={key: os.environ[key] for key in ("PATH", "HOME", "PROTO_HOME") if key in os.environ},
    text=True,
).strip()


def environment(root):
    # Keep only executable discovery from the host. No model credentials are inherited.
    home = root / "home"
    home.mkdir(exist_ok=True)
    # Bypass user package-manager shims, which depend on the user's original HOME.
    bin_directory = root / "bin"
    bin_directory.mkdir(exist_ok=True)
    node_link = bin_directory / "node"
    if not node_link.exists():
        node_link.symlink_to(node_binary)
    return {
        "PATH": str(bin_directory) + os.pathsep + os.environ.get("PATH", os.defpath),
        "HOME": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "PI_CODING_AGENT_DIR": str(home / ".pi" / "agent"),
        "XPER_PI_COMMAND": str(root / "pi-does-not-exist"),
        "TERM": "xterm-256color",
        "NO_COLOR": "1",
        "LANG": "C.UTF-8",
    }


def install_fake_adapter(root, pending=False, available=False):
    package = root / "adapters" / "pi"
    entry = package / "dist" / "inspection" / "cli.js"
    entry.parent.mkdir(parents=True)
    (package / "package.json").write_text(json.dumps({
        "name": "@xper/adapter-pi", "version": version, "type": "module",
    }))
    entry.write_text("""
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const version = VERSION;
const pending = PENDING;
const available = __AVAILABLE__;
const roles = ROLES;
const models = [
  {provider: 'example', model: 'synthetic-fast', reasoning: true},
  {provider: 'example', model: 'synthetic-deep', reasoning: true},
];
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  let response;
  if (request.method === 'describe') {
    response = { result: { adapter: 'pi', version, roles: roles.map(id => ({
      id, label: id.split('.')[0], guidance: 'Choose manually.',
    })) } };
  } else {
    writeFileSync('catalog-requested', 'yes');
    if (pending) return;
    response = available
      ? { result: { models: models.filter(model =>
          (!request.params?.provider || model.provider === request.params.provider) &&
          (!request.params?.query || model.model.includes(request.params.query))) } }
      : { error: { code: 'CATALOG_UNAVAILABLE', message: 'Pi executable is missing' } };
  }
  process.stdout.write(JSON.stringify({schemaVersion: 1, id: request.id, ...response}) + '\\n');
});
""".replace("VERSION", json.dumps(version)).replace("PENDING", json.dumps(pending))
       .replace("__AVAILABLE__", json.dumps(available)).replace("ROLES", json.dumps(roles)))
    if available:
        environment(root)
        pi = root / "bin" / "pi"
        pi.write_text("#!/bin/sh\n[ \"$1\" = \"--version\" ] || exit 1\nprintf '0.87.1\\n'\n")
        pi.chmod(0o755)
        extension = root / ".pi" / "extensions" / "xper.ts"
        extension.parent.mkdir(parents=True)
        extension.write_text("// Isolated installation preflight fixture.\n")
        (package / "dist" / "extension.js").write_text("// Isolated adapter fixture.\n")


class Terminal:
    def __init__(self, root, command=None, extra_env=None):
        self.master, self.slave = pty.openpty()
        self.output = bytearray()
        self.before = termios.tcgetattr(self.slave)
        self.set_size(60, 24)

        self.process = subprocess.Popen(
            command or [binary, "--ascii"], cwd=root,
            env={**environment(root), **(extra_env or {})},
            stdin=self.slave, stdout=self.slave, stderr=self.slave,
            start_new_session=True,
        )
        os.set_blocking(self.master, False)

    def set_size(self, columns, rows):
        self.columns, self.rows = columns, rows
        fcntl.ioctl(self.slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        if hasattr(self, "process"):
            os.kill(self.process.pid, signal.SIGWINCH)

    def pump(self, timeout=0.05):
        if select.select([self.master], [], [], timeout)[0]:
            try:
                self.output.extend(os.read(self.master, 65536))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise

    def expect(self, text, since=0, timeout=5):
        limit = time.monotonic() + timeout
        while len(self.output) <= since or text not in self.screen_text():
            self.pump()
            if time.monotonic() > limit or self.process.poll() is not None:
                raise AssertionError(f"Did not render {text!r}: {bytes(self.output[-2500:])!r}")

    def screen_text(self):
        # Ratatui's differential writes position individual words/cells. Interpret
        # its cursor/erase controls instead of assuming contiguous stdout text.
        screen = [[" "] * self.columns for _ in range(self.rows)]
        x = y = index = 0
        text = self.output.decode("utf-8", errors="replace")
        while index < len(text):
            if text[index] == "\x1b":
                control = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", text[index:])
                if not control:
                    index += 1
                    continue
                args, _, command = control.groups()
                values = [int(item or "0") for item in args.split(";")] if not args.startswith("?") else []
                value = values[0] if values else 0
                if command in ("H", "f"):
                    y = max(0, value - 1)
                    x = max(0, (values[1] if len(values) > 1 else 1) - 1)
                elif command == "G":
                    x = max(0, value - 1)
                elif command == "A":
                    y = max(0, y - (value or 1))
                elif command == "B":
                    y += value or 1
                elif command == "C":
                    x += value or 1
                elif command == "D":
                    x = max(0, x - (value or 1))
                elif command == "J" and value in (2, 3):
                    screen = [[" "] * self.columns for _ in range(self.rows)]
                elif command == "K" and y < self.rows:
                    start, end = (0, self.columns) if value == 2 else (0, x + 1) if value == 1 else (x, self.columns)
                    for column in range(start, min(end, self.columns)):
                        screen[y][column] = " "
                index += control.end()
                continue
            char = text[index]
            if char == "\r":
                x = 0
            elif char == "\n":
                y += 1
            elif char >= " ":
                if x < self.columns and y < self.rows:
                    screen[y][x] = char
                x += 1
            index += 1
        return "\n".join("".join(row) for row in screen)

    def send(self, keys):
        offset = len(self.output)
        os.write(self.master, keys)
        return offset

    def enter(self, keys, text):
        self.expect(text, self.send(keys))

    def finish(self, keys, expected_code=0):
        self.send(keys)
        limit = time.monotonic() + 3
        while self.process.poll() is None:
            self.pump()
            assert time.monotonic() < limit, f"Dashboard did not exit: {bytes(self.output[-2500:])!r}"
        code = self.process.returncode
        self.pump(0.1)
        assert code == expected_code, (code, bytes(self.output[-2500:]))
        flags = termios.ECHO | termios.ICANON
        assert self.before[3] & flags == flags, "PTY did not begin in cooked mode"
        assert termios.tcgetattr(self.slave)[3] & flags == self.before[3] & flags, "Terminal mode was not restored"
        assert b"\x1b[?1049h" in self.output, "Dashboard did not enter the alternate screen"
        assert b"\x1b[?1049l" in self.output, "Dashboard did not leave the alternate screen"

    def close(self):
        # Also remove an orphaned fake helper if an assertion interrupts the test.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(self.process.pid, signal.SIGKILL)
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=3)
        os.close(self.master)
        os.close(self.slave)


def check_plain_output(root):
    for args in ([], ["--no-tui"]):
        result = subprocess.run(
            [binary, *args], cwd=root, env=environment(root),
            input=b"", capture_output=True, timeout=3,
        )
        assert result.returncode == 0, result.stderr
        assert b"Usage:" in result.stdout
        assert b"\x1b" not in result.stdout + result.stderr, "Plain CLI emitted terminal controls"


def draft_context(terminal):
    terminal.enter(b"5", "Settings / Contexts")
    terminal.enter(b"n", "Choose destination scope")
    # Project is the initial scope; navigation waits for actual completed frames.
    terminal.enter(b"\r", "New context")
    terminal.enter(b"personal\r", "Allowed providers")
    terminal.expect("[ ] example")
    terminal.enter(b" ", "[x] example")
    terminal.enter(b"\r", "Review configuration")
    terminal.expect("file will change")


def draft_profile(terminal):
    terminal.enter(b"2", "No profiles yet.")
    terminal.enter(b"n", "Choose destination scope")
    terminal.enter(b"\r", "Choose a context")
    terminal.expect("personal")
    terminal.enter(b"\r", "New profile")
    terminal.enter(b"daily\r", "Models by role")
    terminal.enter(b"a", "Choose a model from Pi")
    terminal.expect("example / synthetic-fast")
    terminal.enter(b"\r", "Models by role")
    terminal.expect("example/synthetic-fast")


def config_paths(root):
    return [root / ".xper" / "config.yaml", root / ".xper" / "config.local.yaml",
            root / "home" / ".config" / "xper" / "config.yaml"]


def expected_context_config():
    return 'contexts:\n  personal:\n    allowed_providers:\n      - "example"\n'


def expected_project_config(active=False):
    return (
        expected_context_config()
        + 'profiles:\n  daily:\n    context: "personal"\n    roles:\n'
        + "".join(f'      {role}:\n        provider: "example"\n'
                  '        model: "synthetic-fast"\n        thinking: "off"\n' for role in roles)
        + ('profile: "daily"\n' if active else '')
    )


with tempfile.TemporaryDirectory(prefix="xper-terminal-") as directory:
    root = Path(directory)
    check_plain_output(root)
    install_fake_adapter(root)
    terminal = Terminal(root)
    try:
        terminal.expect("Project overview")  # No input precedes the initial frame.
        flags = termios.ECHO | termios.ICANON
        assert termios.tcgetattr(terminal.slave)[3] & flags == 0, "Dashboard did not enter raw mode"
        assert all(byte < 128 for byte in terminal.output), "ASCII mode emitted a non-ASCII glyph"
        offset = len(terminal.output)
        terminal.set_size(40, 10)
        terminal.expect("Terminal too small", offset)
        terminal.send(b"q2\r")
        deadline = time.monotonic() + 0.2
        while time.monotonic() < deadline:
            terminal.pump(0.02)
        assert terminal.process.poll() is None, "Hidden actions ran below minimum terminal size"
        offset = len(terminal.output)
        terminal.set_size(60, 24)
        terminal.expect("Project overview", offset)
        offset = terminal.send(b"2")
        terminal.expect("No profiles yet.", offset)
        terminal.expect("Pi executable is missing", offset)
        terminal.enter(b"5", "Settings / Contexts")
        terminal.expect("No contexts yet.")
        offset = terminal.send(b"3")
        terminal.expect("Workflows execute in Pi.", offset)
        terminal.finish(b"q")
    finally:
        terminal.close()

with tempfile.TemporaryDirectory(prefix="xper-terminal-pending-") as directory:
    root = Path(directory)
    install_fake_adapter(root, pending=True)
    terminal = Terminal(root)
    try:
        terminal.expect("Project overview")
        offset = terminal.send(b"2")
        terminal.expect("No profiles yet.", offset)
        limit = time.monotonic() + 5
        while not (root / "catalog-requested").exists():
            terminal.pump()
            assert time.monotonic() < limit, "Synthetic catalog request did not start"
        offset = terminal.send(b"1")
        terminal.expect("Project overview", offset, timeout=1)
        terminal.finish(b"\x03")  # Raw-mode Ctrl+C is handled without waiting for the helper.
    finally:
        terminal.close()

with tempfile.TemporaryDirectory(prefix="xper-terminal-cancel-") as directory:
    root = Path(directory)
    install_fake_adapter(root, available=True)
    terminal = Terminal(root)
    try:
        terminal.expect("Effective profile:")
        draft_context(terminal)
        assert not any(path.exists() for path in config_paths(root)), "Draft review wrote a configuration"
        terminal.enter(b"q", "Unsaved configuration")
        terminal.finish(b"y")
        assert not any(path.exists() for path in config_paths(root)), "Discard wrote a configuration"
    finally:
        terminal.close()

with tempfile.TemporaryDirectory(prefix="xper-terminal-save-") as directory:
    root = Path(directory)
    install_fake_adapter(root, available=True)
    terminal = Terminal(root)
    try:
        terminal.expect("Effective profile:")
        draft_context(terminal)
        assert not any(path.exists() for path in config_paths(root)), "Context review wrote a configuration"
        terminal.enter(b"\r", "Context 'personal' saved in Project.")
        terminal.expect("Settings / Contexts")
        project, local, global_config = config_paths(root)
        context_baseline = project.read_bytes()
        assert project.read_text() == expected_context_config(), project.read_text()

        # Cancelling a profile leaves the previously saved standalone context intact.
        draft_profile(terminal)
        terminal.enter(b"v", "Review configuration")
        terminal.expect("file will change")
        assert project.read_bytes() == context_baseline, "Profile review changed the saved context"
        terminal.enter(b"\x1b", "Models by role")
        terminal.enter(b"\x1b", "Unsaved configuration")
        terminal.enter(b"y", "No profiles yet.")
        assert project.read_bytes() == context_baseline, "Discarded profile changed configuration"
        assert not local.exists() and not global_config.exists(), "Discard wrote another scope"

        draft_profile(terminal)
        terminal.enter(b"v", "Review configuration")
        terminal.expect("file will change")
        assert project.read_bytes() == context_baseline, "Profile review changed configuration"
        terminal.enter(b"\r", "Profile 'daily' saved in Project.")
        assert project.read_text() == expected_project_config(), project.read_text()
        assert not local.exists() and not global_config.exists(), "Saving project configuration wrote another scope"
        assert not (root / ".xper" / "active-profile").exists(), "Saving a profile unexpectedly activated it"

        # Activation is a separately reviewed scoped YAML selection, without copying roles.
        terminal.enter(b"\r", "Profile actions")
        terminal.enter(b"\r", "Choose destination scope")
        terminal.enter(b"\r", "Review configuration")
        terminal.expect("file will change")
        assert project.read_text() == expected_project_config(), "Activation wrote before confirmation"
        terminal.enter(b"\r", 'Selection saved in Project.')
        terminal.expect("ACTIVE")
        assert project.read_text() == expected_project_config(active=True), project.read_text()
        assert not (root / ".xper" / "active-profile").exists(), "Activation created a legacy override"
        terminal.finish(b"q")
    finally:
        terminal.close()

    # Editing one inherited role must not copy the other roles or unrelated scopes.
    original = project.read_bytes()
    global_config.parent.mkdir(parents=True)
    global_original = '# Retain user data.\nadapters:\n  pi:\n    custom: "untouched"\n'
    global_config.write_text(global_original)
    terminal = Terminal(root)
    try:
        terminal.expect("Project overview")
        terminal.expect("Effective profile:")
        terminal.enter(b"2", "daily")
        terminal.enter(b"\r", "Profile actions")
        terminal.enter(b"j\r", "Choose destination scope")
        terminal.enter(b"j\r", "Models by role")
        terminal.enter(b"\r", "Choose a model from Pi")
        terminal.expect("example / synthetic-fast")
        terminal.enter(b"deep", "Search: deep_")
        terminal.expect("example / synthetic-deep")
        terminal.enter(b"\r", "Models by role")
        terminal.expect("example/synthetic-deep")
        terminal.enter(b"v", "Review configuration")
        terminal.expect("file will change")
        assert not local.exists(), "Local draft wrote before confirmation"
        terminal.enter(b"\r", "Profile 'daily' saved in Local (private).")
        assert local.read_text() == (
            'profiles:\n  daily:\n    roles:\n      discovery.explorer:\n'
            '        model: "synthetic-deep"\n'
        ), local.read_text()
        assert project.read_bytes() == original, "Local edit changed project configuration"
        assert global_config.read_text() == global_original, "Local edit changed global configuration"
        assert (root / ".gitignore").read_text() == "/.xper/config.local.yaml\n"
        terminal.finish(b"q")
    finally:
        terminal.close()

for mode in ("error", "panic"):
    with tempfile.TemporaryDirectory(prefix=f"xper-terminal-{mode}-") as directory:
        terminal = Terminal(
            Path(directory), [test_binary, "--exact", "lifecycle_probe", "--nocapture"],
            {"XPER_TEST_TERMINAL_EXIT": mode},
        )
        try:
            terminal.expect("Lifecycle probe ready")
            terminal.finish(b"x", expected_code=101)
            assert f"synthetic terminal {mode}".encode() in terminal.output
        finally:
            terminal.close()

print("PTY lifecycle, resize, catalog failures, context/profile save/discard/activation/override, and plain output passed")
