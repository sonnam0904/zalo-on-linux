// Package update ports scripts/update-native.mjs: it updates a user-local native
// installation from the project's git repository. Nothing is changed until every
// earlier step succeeds; a failed post-swap check rolls back automatically.
//
// Fidelity note: the original spawned Node to run install-native.mjs,
// tray-linux.mjs and native-launch.mjs from the freshly cloned tree. This Go
// port calls the equivalent Go functions directly: the compiled binary is the
// tool, and it installs the newly cloned payload.
package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"zalo-linux-native/internal/config"
	"zalo-linux-native/internal/install"
	"zalo-linux-native/internal/launcher"
	"zalo-linux-native/internal/tray"
)

// DefaultRepo is the project's upstream repository.
const DefaultRepo = "https://github.com/RuriMeiko/zalo-linux-native.git"

// Exit codes mirror the JS EXIT map.
const (
	ExitOK              = 0
	ExitUpdateAvailable = 10
	ExitUsage           = 2
	ExitRunning         = 3
	ExitFailed          = 1
)

// Options is the parsed update command line.
type Options struct {
	Check        bool
	Rollback     bool
	InstallTimer bool
	RemoveTimer  bool
	AppDir       string
	Repo         string
	Ref          string
}

var refRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,100}$`)
var repoRe = regexp.MustCompile(`^(https://|file:///|/)[^\s\x00]+$`)
var shaRe = regexp.MustCompile(`^[0-9a-f]{40}$`)
var deviceWarningRe = regexp.MustCompile(`Selected (source|sink|camera) is unavailable|Unable to check selected`)

func home() string {
	h, _ := os.UserHomeDir()
	return h
}
func envDir(envKey, fallback string) string {
	if v := os.Getenv(envKey); v != "" {
		return v
	}
	return filepath.Join(home(), fallback)
}
func stateDir() string {
	return filepath.Join(envDir("XDG_STATE_HOME", ".local/state"), "zalo-native-update")
}
func cacheDir() string {
	return filepath.Join(envDir("XDG_CACHE_HOME", ".cache"), "zalo-native-update")
}
func runtimeRoot() string {
	return filepath.Join(envDir("XDG_DATA_HOME", ".local/share"), "zalo-runtime")
}
func unitDir() string { return filepath.Join(envDir("XDG_CONFIG_HOME", ".config"), "systemd/user") }

// ParseArgs ports parseArgs().
func ParseArgs(argv []string) (*Options, error) {
	opts := &Options{Repo: DefaultRepo, Ref: "main"}
	value := func(i *int, a string) (string, error) {
		*i++
		if *i >= len(argv) || strings.HasPrefix(argv[*i], "--") {
			return "", fmt.Errorf("Missing value for %s", a)
		}
		return argv[*i], nil
	}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		var err error
		switch a {
		case "--check":
			opts.Check = true
		case "--rollback":
			opts.Rollback = true
		case "--install-timer":
			opts.InstallTimer = true
		case "--remove-timer":
			opts.RemoveTimer = true
		case "--app-dir":
			opts.AppDir, err = value(&i, a)
		case "--repo":
			opts.Repo, err = value(&i, a)
		case "--ref":
			opts.Ref, err = value(&i, a)
		default:
			return nil, fmt.Errorf("Unknown option: %s", a)
		}
		if err != nil {
			return nil, err
		}
	}
	modes := 0
	for _, b := range []bool{opts.Check, opts.Rollback, opts.InstallTimer, opts.RemoveTimer} {
		if b {
			modes++
		}
	}
	if modes > 1 {
		return nil, errors.New("Choose at most one of --check, --rollback, --install-timer, --remove-timer")
	}
	if !refRe.MatchString(opts.Ref) || strings.HasPrefix(opts.Ref, "-") {
		return nil, errors.New("Invalid --ref")
	}
	if !repoRe.MatchString(opts.Repo) {
		return nil, errors.New("Invalid --repo")
	}
	return opts, nil
}

// RuntimeArch ports runtimeArch(): the native runtime is only packaged for x86_64.
func RuntimeArch() (string, error) {
	if runtime.GOARCH == "amd64" {
		return "x86_64", nil
	}
	return "", fmt.Errorf("Native runtime is only packaged for x86_64 (this machine: %s); see ARM-PORT-NOTES.md", runtime.GOARCH)
}

// State is the recorded installation state.
type State struct {
	Commit    string `json:"commit"`
	Runtime   string `json:"runtime,omitempty"`
	Previous  *State `json:"previous"`
	UpdatedAt string `json:"updatedAt,omitempty"`
}

func isUpToDate(state *State, remote string) bool {
	return state != nil && state.Commit == remote
}

// pickStale ports pickStale(): keep the newest `keep`, return the rest.
func pickStale(names []string, keep int) []string {
	sorted := append([]string(nil), names...)
	sort.Strings(sorted)
	drop := len(sorted) - keep
	if drop < 0 {
		drop = 0
	}
	return sorted[:drop]
}

// TimerUnits ports timerUnits().
func TimerUnits(binPath, appDir string) (service, timer string) {
	quote := func(v string) string {
		return `"` + regexp.MustCompile(`(["\\$])`).ReplaceAllString(v, `\$1`) + `"`
	}
	service = "[Unit]\nDescription=Update Zalo native from GitHub\n\n[Service]\nType=oneshot\nExecStart=" +
		quote(binPath) + " update --app-dir " + quote(appDir) + "\nSuccessExitStatus=3 10\n"
	timer = "[Unit]\nDescription=Check for Zalo native updates\n\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=6h\nRandomizedDelaySec=15min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
	return
}

func defaultAppDir(binDir string) string {
	parent := filepath.Dir(binDir)
	if exists(filepath.Join(parent, "INSTALL-COMPLETE.json")) {
		return parent
	}
	return filepath.Join(home(), ".local/share/zalo")
}

func exists(p string) bool { _, err := os.Lstat(p); return err == nil }

func readState(p string) *State {
	data, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	var s State
	if json.Unmarshal(data, &s) != nil {
		return nil
	}
	return &s
}

func sha7(sha string) string {
	if len(sha) < 7 {
		return sha
	}
	return sha[:7]
}
func stamp() string {
	return regexp.MustCompile(`[-:T]`).ReplaceAllString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00"), "")[:14]
}
func logf(format string, a ...any) { fmt.Printf("[update] "+format+"\n", a...) }

func git(args ...string) (string, error) {
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func remoteHead(opts *Options) (string, error) {
	out, err := git("ls-remote", "--exit-code", opts.Repo, "refs/heads/"+opts.Ref)
	if err != nil {
		return "", err
	}
	sha := strings.Fields(out)
	if len(sha) == 0 || !shaRe.MatchString(sha[0]) {
		return "", errors.New("Unexpected ls-remote output")
	}
	return sha[0], nil
}

func zaloRunning(appDir string) bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}
	for _, e := range entries {
		name := e.Name()
		if !isDigits(name) {
			continue
		}
		cmd, err := os.ReadFile("/proc/" + name + "/cmdline")
		if err != nil {
			continue
		}
		exe, err := os.Readlink("/proc/" + name + "/exe")
		if err != nil {
			continue
		}
		if launcher.IsRunningApp(string(cmd), exe, appDir) {
			return true
		}
	}
	return false
}

func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func loadConfig(appDir string) (*config.Config, error) {
	data, err := os.ReadFile(filepath.Join(appDir, "launch.json"))
	if err != nil {
		return nil, err
	}
	return config.Parse(data)
}

// CheckOnly ports checkOnly().
func CheckOnly(opts *Options) (int, error) {
	state := readState(filepath.Join(stateDir(), "state.json"))
	remote, err := remoteHead(opts)
	if err != nil {
		return ExitFailed, err
	}
	if isUpToDate(state, remote) {
		logf("up to date (%s)", sha7(remote))
		return ExitOK, nil
	}
	from := "unknown"
	if state != nil {
		from = sha7(state.Commit)
	}
	logf("update available: %s -> %s", from, sha7(remote))
	return ExitUpdateAvailable, nil
}

// Update ports update().
func Update(opts *Options, appDir string) (int, error) {
	cfg, err := loadConfig(appDir)
	if err != nil {
		return ExitFailed, err
	}
	if cfg.AppDir != appDir {
		return ExitFailed, errors.New("launch.json does not belong to this installation")
	}
	archName, err := RuntimeArch()
	if err != nil {
		return ExitFailed, err
	}
	state := readState(filepath.Join(stateDir(), "state.json"))
	remote, err := remoteHead(opts)
	if err != nil {
		return ExitFailed, err
	}
	if isUpToDate(state, remote) {
		logf("up to date (%s)", sha7(remote))
		return ExitOK, nil
	}
	if zaloRunning(appDir) {
		logf("Zalo is running from this installation; close it, then run the update again.")
		return ExitRunning, nil
	}
	work := filepath.Join(cacheDir(), sha7(remote)+"-"+stamp())
	src := filepath.Join(work, "src")
	staging := appDir + ".next"
	runtimeDir := filepath.Join(runtimeRoot(), sha7(remote)+"-"+archName)
	if exists(staging) {
		return ExitFailed, fmt.Errorf("Leftover %s; remove it and retry", staging)
	}
	if err := os.MkdirAll(work, 0o700); err != nil {
		return ExitFailed, err
	}
	defer func() {
		os.RemoveAll(work)
		if exists(staging) {
			os.RemoveAll(staging)
		}
	}()

	logf("fetching %s", sha7(remote))
	if _, err := git("clone", "--quiet", "--depth", "1", "--branch", opts.Ref, opts.Repo, src); err != nil {
		return ExitFailed, err
	}
	head, err := git("-C", src, "rev-parse", "HEAD")
	if err != nil {
		return ExitFailed, err
	}
	if head != remote {
		return ExitFailed, errors.New("Remote moved during download; run the update again")
	}

	if !exists(runtimeDir) {
		logf("preparing runtime %s", filepath.Base(runtimeDir))
		if err := os.MkdirAll(filepath.Join(runtimeDir, "apk/lib"), 0o755); err != nil {
			return ExitFailed, err
		}
		for _, part := range []string{"bionic", "results"} {
			if err := copyTree(filepath.Join(src, "runtime", part), filepath.Join(runtimeDir, part)); err != nil {
				return ExitFailed, err
			}
		}
		if err := copyTree(filepath.Join(src, "runtime/apk/lib", archName), filepath.Join(runtimeDir, "apk/lib", archName)); err != nil {
			return ExitFailed, err
		}
	}

	next := cfg.Clone()
	next.Runtime = runtimeDir
	nextBytes, err := next.MarshalIndent()
	if err != nil {
		return ExitFailed, err
	}
	nextConfig := filepath.Join(work, "launch.json")
	if err := os.WriteFile(nextConfig, append(nextBytes, '\n'), 0o600); err != nil {
		return ExitFailed, err
	}

	logf("installing into staging directory")
	if err := install.Run(src, []string{nextConfig, staging, "--app-dir", appDir, "--no-device-check"}); err != nil {
		return ExitFailed, err
	}

	logf("switching to the new version")
	previous := fmt.Sprintf("%s.prev-%s", appDir, stamp())
	if err := os.Rename(appDir, previous); err != nil {
		return ExitFailed, err
	}
	if err := swapAndCheck(staging, appDir, previous); err != nil {
		return ExitFailed, err
	}

	if err := os.MkdirAll(stateDir(), 0o700); err != nil {
		return ExitFailed, err
	}
	newState := State{Commit: remote, Runtime: runtimeDir, Previous: state, UpdatedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	nb, _ := json.MarshalIndent(newState, "", "  ")
	if err := os.WriteFile(filepath.Join(stateDir(), "state.json"), append(nb, '\n'), 0o600); err != nil {
		return ExitFailed, err
	}
	var prevRuntime string
	if state != nil {
		prevRuntime = state.Runtime
	}
	prune(appDir, runtimeDir, prevRuntime)
	logf("updated to %s. Start Zalo again to use it.", sha7(remote))
	return ExitOK, nil
}

// swapAndCheck renames staging into place, re-applies the tray entry and runs the
// installed --check, restoring the previous copy if the check fails.
func swapAndCheck(staging, appDir, previous string) error {
	if err := os.Rename(staging, appDir); err != nil {
		restore(appDir, previous)
		return err
	}
	// The tray entry lives in the main-process bundle, replaced wholesale by every
	// update. Re-apply it before the check so the new version launches with it present.
	if err := tray.Apply(appDir); err != nil {
		logf("warning: could not add the tray update entry: %s", strings.TrimSpace(err.Error()))
	}
	cfg, err := loadConfig(appDir)
	if err == nil {
		err = launcher.RunNativeLaunch(cfg, appDir, true)
	}
	if err != nil {
		// Only a missing audio/camera device is acceptable here; anything else rolls back.
		if !deviceWarningRe.MatchString(err.Error()) {
			logf("new version failed its check; restoring the previous one")
			restore(appDir, previous)
			return err
		}
		logf("warning: configured audio/camera device is not present right now")
	}
	// The previous copy is only needed until the new one passes its check. Delete
	// it immediately: keeping one backup per update filled the disk with tens of
	// gigabytes of near-identical copies. The git history is the source of truth.
	os.RemoveAll(previous)
	return nil
}

func restore(appDir, previous string) {
	os.RemoveAll(appDir)
	os.Rename(previous, appDir)
}

func prune(appDir, currentRuntime, previousRuntime string) {
	parent := filepath.Dir(appDir)
	base := filepath.Base(appDir) + ".prev-"
	if entries, err := os.ReadDir(parent); err == nil {
		var olds []string
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), base) {
				olds = append(olds, e.Name())
			}
		}
		for _, name := range pickStale(olds, 1) {
			os.RemoveAll(filepath.Join(parent, name))
		}
	}
	entries, err := os.ReadDir(runtimeRoot())
	if err != nil {
		return
	}
	keep := map[string]bool{filepath.Base(currentRuntime): true}
	if previousRuntime != "" {
		keep[filepath.Base(previousRuntime)] = true
	}
	for _, e := range entries {
		if !keep[e.Name()] {
			os.RemoveAll(filepath.Join(runtimeRoot(), e.Name()))
		}
	}
}

// Rollback ports rollback().
func Rollback(appDir string) (int, error) {
	if zaloRunning(appDir) {
		logf("Close Zalo first.")
		return ExitRunning, nil
	}
	parent := filepath.Dir(appDir)
	base := filepath.Base(appDir) + ".prev-"
	entries, err := os.ReadDir(parent)
	if err != nil {
		return ExitFailed, err
	}
	var olds []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), base) {
			olds = append(olds, e.Name())
		}
	}
	sort.Strings(olds)
	if len(olds) == 0 {
		return ExitFailed, errors.New("No previous version to restore")
	}
	previous := filepath.Join(parent, olds[len(olds)-1])
	failed := fmt.Sprintf("%s.failed-%s", appDir, stamp())
	if err := os.Rename(appDir, failed); err != nil {
		return ExitFailed, err
	}
	if err := os.Rename(previous, appDir); err != nil {
		return ExitFailed, err
	}
	os.RemoveAll(failed)
	state := readState(filepath.Join(stateDir(), "state.json"))
	if err := os.MkdirAll(stateDir(), 0o700); err != nil {
		return ExitFailed, err
	}
	var out []byte
	if state != nil && state.Previous != nil {
		out, _ = json.MarshalIndent(*state.Previous, "", "  ")
	} else {
		out = []byte("{}")
	}
	if err := os.WriteFile(filepath.Join(stateDir(), "state.json"), append(out, '\n'), 0o600); err != nil {
		return ExitFailed, err
	}
	logf("restored the previous version")
	return ExitOK, nil
}

// InstallTimer ports installTimer().
func InstallTimer(appDir string) (int, error) {
	binPath, err := os.Executable()
	if err != nil {
		return ExitFailed, err
	}
	if !exists(filepath.Join(appDir, "INSTALL-COMPLETE.json")) {
		return ExitFailed, errors.New("Run this against an installed copy (INSTALL-COMPLETE.json missing)")
	}
	service, timer := TimerUnits(binPath, appDir)
	if err := os.MkdirAll(unitDir(), 0o755); err != nil {
		return ExitFailed, err
	}
	if err := os.WriteFile(filepath.Join(unitDir(), "zalo-native-update.service"), []byte(service), 0o644); err != nil {
		return ExitFailed, err
	}
	if err := os.WriteFile(filepath.Join(unitDir(), "zalo-native-update.timer"), []byte(timer), 0o644); err != nil {
		return ExitFailed, err
	}
	if err := exec.Command("systemctl", "--user", "daemon-reload").Run(); err != nil {
		return ExitFailed, err
	}
	if err := exec.Command("systemctl", "--user", "enable", "--now", "zalo-native-update.timer").Run(); err != nil {
		return ExitFailed, err
	}
	logf("automatic update check enabled (every 6 hours; it waits while Zalo is open)")
	return ExitOK, nil
}

// RemoveTimer ports removeTimer().
func RemoveTimer() (int, error) {
	exec.Command("systemctl", "--user", "disable", "--now", "zalo-native-update.timer").Run()
	os.Remove(filepath.Join(unitDir(), "zalo-native-update.timer"))
	os.Remove(filepath.Join(unitDir(), "zalo-native-update.service"))
	exec.Command("systemctl", "--user", "daemon-reload").Run()
	logf("automatic update check disabled")
	return ExitOK, nil
}

// Run ports the update-native.mjs main() and returns a process exit code.
func Run(binDir string, args []string) int {
	opts, err := ParseArgs(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		fmt.Fprintln(os.Stderr, "Usage: zalo update [--check|--rollback|--install-timer|--remove-timer] [--app-dir DIR] [--repo URL] [--ref BRANCH]")
		return ExitUsage
	}
	appDir := opts.AppDir
	if appDir == "" {
		appDir = defaultAppDir(binDir)
	}
	appDir, _ = filepath.Abs(appDir)
	var code int
	switch {
	case opts.Check:
		code, err = CheckOnly(opts)
	case opts.Rollback:
		code, err = Rollback(appDir)
	case opts.InstallTimer:
		code, err = InstallTimer(appDir)
	case opts.RemoveTimer:
		code, err = RemoveTimer()
	default:
		code, err = Update(opts, appDir)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "[update] failed: "+err.Error())
		return ExitFailed
	}
	return code
}

// copyTree recursively copies src into dst, preserving regular file modes and
// timestamps and recreating symlinks verbatim.
func copyTree(src, dst string) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, lerr := os.Readlink(src)
		if lerr != nil {
			return lerr
		}
		return os.Symlink(target, dst)
	case info.IsDir():
		if err := os.MkdirAll(dst, info.Mode().Perm()); err != nil {
			return err
		}
		entries, rerr := os.ReadDir(src)
		if rerr != nil {
			return rerr
		}
		for _, e := range entries {
			if err := copyTree(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return os.Chtimes(dst, info.ModTime(), info.ModTime())
	default:
		if err := copyFilePreserve(src, dst, info); err != nil {
			return err
		}
		return nil
	}
}

func copyFilePreserve(src, dst string, info os.FileInfo) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	_ = os.Chmod(dst, info.Mode().Perm())
	return os.Chtimes(dst, info.ModTime(), info.ModTime())
}
