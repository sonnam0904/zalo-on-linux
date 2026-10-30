package debugreport

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const launcherLogMaxBytes = 2 << 20

// LauncherLogPath is where `zalo launch` keeps the output of the launcher and
// Electron when there is no terminal: $XDG_STATE_HOME/zalo-on-linux/launcher.log.
func LauncherLogPath() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return ""
		}
		base = filepath.Join(home, ".local", "state")
	}
	return filepath.Join(base, "zalo-on-linux", "launcher.log")
}

// RedirectOutputToLog points stdout/stderr (inherited by Electron) at the
// launcher log when the app was started from the menu rather than a terminal,
// so failures on other machines leave a trace `zalo debug` can collect.
// It is best-effort: any failure leaves the original streams untouched.
func RedirectOutputToLog() {
	if isTerminal(1) {
		return
	}
	path := LauncherLogPath()
	if path == "" || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return
	}
	if st, err := os.Stat(path); err == nil && st.Size() > launcherLogMaxBytes {
		_ = os.Rename(path, path+".old")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "\n==== %s zalo %v (pid %d) ====\n", time.Now().Format(time.RFC3339), os.Args[1:], os.Getpid())
	_ = syscall.Dup3(int(f.Fd()), 1, 0)
	_ = syscall.Dup3(int(f.Fd()), 2, 0)
}

// isTerminal is isatty(3): /dev/null is a character device too, so the file
// mode alone cannot tell a terminal apart.
func isTerminal(fd int) bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.TCGETS, uintptr(unsafe.Pointer(&t)))
	return errno == 0
}
