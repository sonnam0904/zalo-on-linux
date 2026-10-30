package debugreport

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"
)

const (
	launcherLogMaxBytes = 5 << 20
	launcherLogMaxLine  = 4 << 10
)

// LauncherLogPath is where `zalo launch` keeps the output of the launcher and
// Electron: $XDG_STATE_HOME/zalo-on-linux/launcher.log.
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

// RedirectOutputToLog routes stdout/stderr (inherited by Electron, which runs
// with --enable-logging=stderr) through a pipe that is copied to the launcher
// log and, when started from a terminal, to the terminal as well, so
// `zalo debug` can collect it either way. It returns a function that flushes
// the log; call it before exiting. Any setup failure leaves the original
// streams untouched.
func RedirectOutputToLog() (flush func()) {
	noop := func() {}
	path := LauncherLogPath()
	if path == "" || os.MkdirAll(filepath.Dir(path), 0o700) != nil {
		return noop
	}
	lw, err := openRotatingLog(path)
	if err != nil {
		return noop
	}
	fmt.Fprintf(lw, "\n==== %s zalo %v (pid %d) ====\n", time.Now().Format(time.RFC3339), os.Args[1:], os.Getpid())

	var term *os.File
	if isTerminal(1) {
		if fd, err := syscall.Dup(1); err == nil {
			term = os.NewFile(uintptr(fd), "terminal")
		}
	}
	r, w, err := os.Pipe()
	if err != nil {
		lw.Close()
		return noop
	}
	if syscall.Dup3(int(w.Fd()), 1, 0) != nil || syscall.Dup3(int(w.Fd()), 2, 0) != nil {
		r.Close()
		w.Close()
		lw.Close()
		return noop
	}
	w.Close() // fds 1 and 2 keep the write end open

	done := make(chan struct{})
	go func() {
		defer close(done)
		br := bufio.NewReaderSize(r, 64<<10)
		for {
			line, err := br.ReadSlice('\n')
			if err == bufio.ErrBufferFull {
				// Overlong line: emit what we have, the rest follows.
				err = nil
			}
			if len(line) > 0 {
				if term != nil {
					_, _ = term.Write(line)
				}
				lw.WriteLine(line)
			}
			if err != nil {
				break
			}
		}
		lw.Close()
	}()

	return func() {
		// Point 1/2 away from the pipe so the reader sees EOF once Electron
		// (if it outlived us) is gone too; then wait briefly for the copy.
		if devnull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0); err == nil {
			_ = syscall.Dup3(int(devnull.Fd()), 1, 0)
			_ = syscall.Dup3(int(devnull.Fd()), 2, 0)
			devnull.Close()
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

// rotatingLog appends to path, moving it to path.old once it grows past
// launcherLogMaxBytes, and truncates very long lines (data: URLs, dumps).
type rotatingLog struct {
	path string
	f    *os.File
	size int64
}

func openRotatingLog(path string) (*rotatingLog, error) {
	l := &rotatingLog{path: path}
	if st, err := os.Stat(path); err == nil && st.Size() > launcherLogMaxBytes {
		_ = os.Rename(path, path+".old")
	}
	return l, l.open()
}

func (l *rotatingLog) open() error {
	f, err := os.OpenFile(l.path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	st, _ := f.Stat()
	l.f, l.size = f, 0
	if st != nil {
		l.size = st.Size()
	}
	return nil
}

func (l *rotatingLog) Write(p []byte) (int, error) {
	l.WriteLine(p)
	return len(p), nil
}

func (l *rotatingLog) WriteLine(line []byte) {
	if l.f == nil {
		return
	}
	if len(line) > launcherLogMaxLine {
		line = append(append([]byte(nil), line[:launcherLogMaxLine]...), " …[cắt bớt]\n"...)
	}
	if l.size+int64(len(line)) > launcherLogMaxBytes {
		l.f.Close()
		_ = os.Rename(l.path, l.path+".old")
		if l.open() != nil {
			l.f = nil
			return
		}
	}
	n, _ := l.f.Write(line)
	l.size += int64(n)
}

func (l *rotatingLog) Close() {
	if l.f != nil {
		l.f.Close()
		l.f = nil
	}
}

var _ io.Writer = (*rotatingLog)(nil)

// isTerminal is isatty(3): /dev/null is a character device too, so the file
// mode alone cannot tell a terminal apart.
func isTerminal(fd int) bool {
	var t syscall.Termios
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, uintptr(fd), syscall.TCGETS, uintptr(unsafe.Pointer(&t)))
	return errno == 0
}
