// Package applyupdate ports scripts/apply-update-on-launch.mjs: it applies a
// pending update before Zalo starts, so "quit and reopen Zalo" is enough to move
// to the new version. Everything is best effort — a network failure, a missing
// git, or a read-only state directory must never stop Zalo from opening.
package applyupdate

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Exit codes mirror the JS EXIT map.
const (
	ExitOK              = 0
	ExitUpdateAvailable = 10
	ExitRunning         = 3
	ExitUsage           = 2
	ExitFailed          = 1
)

// defaultTimeout is a hard ceiling for launch; the updater has its own git timeouts.
const defaultTimeout = 120 * time.Second

// Options is the parsed apply-update command line.
type Options struct {
	AppDir  string
	Timeout time.Duration
	Quiet   bool
	Strict  bool
}

// Result mirrors the resolved {code,stdout,stderr,skipped}.
type Result struct {
	Code    int
	HasCode bool
	Skipped bool
	Stdout  string
	Stderr  string
}

// ParseArgs ports parseArgs().
func ParseArgs(argv []string) (*Options, error) {
	opts := &Options{Timeout: defaultTimeout}
	value := func(i *int, a string) (string, error) {
		*i++
		if *i >= len(argv) || strings.HasPrefix(argv[*i], "--") {
			return "", fmt.Errorf("Missing value for %s", a)
		}
		return argv[*i], nil
	}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		switch a {
		case "--app-dir":
			v, err := value(&i, a)
			if err != nil {
				return nil, err
			}
			opts.AppDir = v
		case "--timeout-ms":
			v, err := value(&i, a)
			if err != nil {
				return nil, err
			}
			var n int
			if _, serr := fmt.Sscanf(v, "%d", &n); serr != nil || n < 1000 || n > 600000 || fmt.Sprintf("%d", n) != v {
				return nil, errors.New("timeout-ms must be 1000..600000")
			}
			opts.Timeout = time.Duration(n) * time.Millisecond
		case "--quiet":
			opts.Quiet = true
		case "--strict":
			opts.Strict = true
		default:
			return nil, fmt.Errorf("Unknown option: %s", a)
		}
	}
	return opts, nil
}

// ResolveAppDir ports resolveAppDir(): a source checkout has no
// INSTALL-COMPLETE.json, so it never tries to replace itself.
func ResolveAppDir(appDir string) string {
	if appDir == "" || !filepath.IsAbs(appDir) {
		return ""
	}
	if _, err := os.Stat(filepath.Join(appDir, "INSTALL-COMPLETE.json")); err != nil {
		return ""
	}
	if _, err := os.Stat(filepath.Join(appDir, "scripts/update-native.mjs")); err != nil {
		return ""
	}
	return appDir
}

// ApplyUpdate ports applyUpdate(): runs one update pass as a subprocess with a
// timeout; never returns an error.
func ApplyUpdate(binPath, appDir string, timeout time.Duration) Result {
	dir := ResolveAppDir(appDir)
	if dir == "" {
		return Result{Skipped: true}
	}
	cmd := exec.Command(binPath, "update", "--app-dir", dir)
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Start(); err != nil {
		return Result{Code: ExitFailed, HasCode: true, Stderr: err.Error()}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		code := 0
		if err != nil {
			if ee, ok := err.(*exec.ExitError); ok {
				code = ee.ExitCode()
			} else {
				code = ExitFailed
			}
		}
		return Result{Code: code, HasCode: true, Stdout: stdout.String(), Stderr: stderr.String()}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
		return Result{Code: ExitFailed, HasCode: true, Stdout: stdout.String(), Stderr: stderr.String() + "\n[update] timed out"}
	}
}

// WriteStamp ports writeStamp(): records the last attempt advisory-only.
func WriteStamp(stateDir string, r Result) {
	file := filepath.Join(stateDir, "last-launch-check.json")
	msg := r.Stderr
	if msg == "" {
		msg = r.Stdout
	}
	lines := []string{}
	for _, l := range strings.Split(strings.TrimSpace(msg), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > 3 {
		lines = lines[len(lines)-3:]
	}
	var code any
	if r.HasCode {
		code = r.Code
	}
	payload := map[string]any{
		"at":      time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"code":    code,
		"skipped": r.Skipped,
		"message": strings.Join(lines, " | "),
	}
	body, _ := json.MarshalIndent(payload, "", "  ")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		stampFallback(r)
		return
	}
	if err := os.WriteFile(file, append(body, '\n'), 0o600); err != nil {
		stampFallback(r)
	}
}

// stampFallback writes one advisory line on stderr when the stamp cannot be recorded.
func stampFallback(r Result) {
	if r.HasCode && r.Code != 0 && r.Code != ExitUpdateAvailable && r.Code != ExitRunning {
		msg := r.Stderr
		if msg == "" {
			msg = r.Stdout
		}
		lines := strings.Split(strings.TrimSpace(msg), "\n")
		last := "check failed"
		if n := len(lines); n > 0 && lines[n-1] != "" {
			last = lines[n-1]
		}
		fmt.Fprintln(os.Stderr, "[update] "+last)
	}
}

func stateDir() string {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, _ := os.UserHomeDir()
		base = filepath.Join(home, ".local/state")
	}
	return filepath.Join(base, "zalo-native-update")
}

// Run ports the apply-update-on-launch.mjs main() and returns a process exit code.
func Run(binPath, fallbackAppDir string, args []string) (int, error) {
	opts, err := ParseArgs(args)
	if err != nil {
		return ExitUsage, err
	}
	appDir := opts.AppDir
	if appDir == "" {
		appDir = fallbackAppDir
	}
	result := ApplyUpdate(binPath, appDir, opts.Timeout)
	if !result.Skipped {
		WriteStamp(stateDir(), result)
	}
	if !opts.Quiet && !result.Skipped {
		switch result.Code {
		case ExitOK:
			fmt.Fprintln(os.Stdout, "[update] up to date or updated before launch")
		case ExitUpdateAvailable:
			fmt.Fprintln(os.Stdout, "[update] update available; quitting and reopening Zalo installs it")
		case ExitRunning:
			fmt.Fprintln(os.Stdout, "[update] Zalo is still running; skipped")
		default:
			fmt.Fprintln(os.Stderr, "[update] check failed: "+strings.TrimSpace(result.Stderr))
		}
	}
	failed := !result.Skipped && result.Code != ExitOK && result.Code != ExitUpdateAvailable && result.Code != ExitRunning
	if opts.Strict && failed {
		return ExitFailed, nil
	}
	return ExitOK, nil
}
