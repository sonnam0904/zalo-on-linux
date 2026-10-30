// Package launcher ports the runtime side of scripts/native-launch.mjs: the
// launch specification, device preflight, running-instance detection, KDE window
// activation and the top-level launch flow. No downloads, upstream updates, or
// silent Wine fallbacks happen here.
package launcher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"zalo-linux-native/internal/config"
)

// zrtcHash is the supported sha256 of runtime/apk/lib/x86_64/libzrtc.so.
const zrtcHash = "c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe"

// LaunchSpec is the resolved command for spawning Electron.
type LaunchSpec struct {
	Executable string
	Args       []string
	Env        []string
}

// envNamesToDelete are leaked by a parent shell/profile and would reconfigure
// the native call path; they are stripped before each launch.
var envNamesToDelete = []string{
	"ELECTRON_RUN_AS_NODE", "LD_PRELOAD", "LD_AUDIT", "ZALO_ZCALL_CAPTURE",
	"ZALO_ZCALL_SCHEMA_LOG", "ZRTC_DEBUG_BACKTRACE", "ZRTC_PCM_HOST", "ZRTC_PCM_SOURCE", "ZRTC_PCM_SINK",
	"ZALO_ZCALL_NATIVE_VIDEO", "ZALO_ZCALL_VIDEO_DEVICE", "ZALO_ZCALL_NATIVE_INCOMING",
	"ZALO_ZCALL_UI_PIPE", "ZALO_ZCALL_VIDEO_PIPE", "ZALO_ZCALL_PREVIEW_PIPE",
}

// BuildLaunchSpec ports launchSpec(). root is the resolved project root used to
// locate the bundled zcall-agent.
func BuildLaunchSpec(c *config.Config, root string, inherited []string) LaunchSpec {
	env := map[string]string{}
	var order []string
	for _, kv := range inherited {
		i := strings.IndexByte(kv, '=')
		if i < 0 {
			continue
		}
		k := kv[:i]
		if _, seen := env[k]; !seen {
			order = append(order, k)
		}
		env[k] = kv[i+1:]
	}
	for _, name := range envNamesToDelete {
		delete(env, name)
	}
	logFlag := "0"
	if c.Log != nil && *c.Log {
		logFlag = "1"
	}
	assign := func(k, v string) {
		if _, seen := env[k]; !seen {
			order = append(order, k)
		}
		env[k] = v
	}
	assign("ZCALL_USE_PROXY", "0")
	assign("ZCALL_PROXY_AUTOSTART", "0")
	assign("ZALO_ZCALL_LOG", logFlag)
	assign("ZALO_ZCALL_NATIVE_SETUP", "1")
	assign("ZALO_ZCALL_NATIVE_NETWORK", "1")
	assign("ZALO_ZCALL_NATIVE_MEDIA", "1")
	assign("ZALO_ZRTC_RUNTIME", c.Runtime)
	assign("ZALO_ZCALL_PCM_SOURCE", c.Source)
	assign("ZALO_ZCALL_PCM_SINK", c.Sink)
	assign("ZALO_ZCALL_AGENT_PATH", filepath.Join(root, "native/qt-call-cap-linux/zcall-agent.js"))
	if c.ExperimentalVideo != nil && *c.ExperimentalVideo {
		assign("ZALO_ZCALL_NATIVE_VIDEO", "1")
		if c.VideoDevice != nil {
			assign("ZALO_ZCALL_VIDEO_DEVICE", *c.VideoDevice)
		}
	}
	if c.ExperimentalIncoming != nil && *c.ExperimentalIncoming {
		assign("ZALO_ZCALL_NATIVE_INCOMING", "1")
	}

	var args []string
	if c.NoSandbox != nil && *c.NoSandbox {
		args = append(args, "--no-sandbox")
	}
	if c.CDPPort != nil {
		args = append(args, "--remote-debugging-address=127.0.0.1", fmt.Sprintf("--remote-debugging-port=%d", *c.CDPPort))
	}
	// Chromium logging puts every renderer/worker console message and uncaught
	// error on stderr, which the launcher keeps for `zalo debug`.
	args = append(args, "--enable-logging=stderr")
	args = append(args, c.AppDir)

	envSlice := make([]string, 0, len(order))
	for _, k := range order {
		v, ok := env[k]
		if !ok {
			continue // stripped by envNamesToDelete
		}
		envSlice = append(envSlice, k+"="+v)
	}
	return LaunchSpec{Executable: c.Electron, Args: args, Env: envSlice}
}

// InspectCallDevices ports inspectCallDevices(). Devices can disappear while the
// app is closed; this reports warnings without changing the selection.
func InspectCallDevices(c *config.Config) []string {
	var warnings []string
	if c.ExperimentalVideo != nil && *c.ExperimentalVideo && c.VideoDevice != nil {
		info, err := os.Stat(*c.VideoDevice)
		if err != nil || info.Mode()&os.ModeCharDevice == 0 {
			warnings = append(warnings, "Selected camera is unavailable")
		}
	}
	for _, pair := range [][2]string{{"source", "sources"}, {"sink", "sinks"}} {
		field, kind := pair[0], pair[1]
		want := c.Source
		if field == "sink" {
			want = c.Sink
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		out, err := exec.CommandContext(ctx, "pactl", "--format=json", "list", kind).Output()
		cancel()
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("Unable to check selected %s", field))
			continue
		}
		var rows []struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(out, &rows) != nil {
			warnings = append(warnings, fmt.Sprintf("Unable to check selected %s", field))
			continue
		}
		found := false
		for _, r := range rows {
			if r.Name == want {
				found = true
				break
			}
		}
		if !found {
			warnings = append(warnings, fmt.Sprintf("Selected %s is unavailable", field))
		}
	}
	return warnings
}

// Preflight ports preflight(): it verifies that every required runtime component
// is a regular file, the ZRTC library matches the supported hash, and (when
// requireDevices) that the configured devices are present.
func Preflight(c *config.Config, requireDevices bool) ([]string, error) {
	required := []string{
		c.Electron,
		filepath.Join(c.AppDir, "bootstrap.js"),
		filepath.Join(c.Runtime, "bionic/linker64"),
		filepath.Join(c.Runtime, "results/zrtc-worker"),
		filepath.Join(c.Runtime, "results/pcm-host"),
	}
	for _, file := range required {
		info, err := os.Stat(file)
		if err != nil || !info.Mode().IsRegular() {
			return nil, errors.New("Required runtime component is not a file")
		}
	}
	data, err := os.ReadFile(filepath.Join(c.Runtime, "apk/lib/x86_64/libzrtc.so"))
	if err != nil {
		return nil, errors.New("Required runtime component is not a file")
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != zrtcHash {
		return nil, errors.New("Unsupported native library hash")
	}
	warnings := InspectCallDevices(c)
	if requireDevices && len(warnings) > 0 {
		return nil, errors.New(strings.Join(warnings, "; "))
	}
	return warnings, nil
}

// IsRunningApp ports isRunningApp(): it decides whether a /proc cmdline belongs
// to our Electron app, matching the exact executable and final app path and
// never a substring or shell.
func IsRunningApp(cmdline, executable, appDir string) bool {
	if filepath.Base(executable) != "electron" {
		return false
	}
	var argv []string
	for _, a := range strings.Split(cmdline, "\x00") {
		if a != "" {
			argv = append(argv, a)
		}
	}
	for _, a := range argv {
		if strings.HasPrefix(a, "--type=") {
			return false
		}
	}
	if len(argv) > 1 {
		for _, a := range argv {
			if a == appDir {
				return true
			}
		}
		return false
	}
	// Electron process.title can replace the original NUL-separated argv. Match
	// the exact executable and final app path, never a substring or shell.
	title := ""
	if len(argv) > 0 {
		title = argv[0]
	}
	if !strings.HasPrefix(title, executable+" ") || !strings.HasSuffix(title, " "+appDir) {
		return false
	}
	options := title[len(executable)+1 : len(title)-len(appDir)-1]
	if options == "" {
		return true
	}
	for _, a := range strings.Split(options, " ") {
		if !electronOptionRe.MatchString(a) || strings.HasPrefix(a, "--type=") {
			return false
		}
	}
	return true
}

var electronOptionRe = regexp.MustCompile(`^--[A-Za-z0-9-]+(?:=[^\s]+)?$`)

// FindRunningApp ports findRunningApp(): scans /proc for a live instance.
func FindRunningApp(appDir string) (int, bool) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	for _, entry := range entries {
		pid := entry.Name()
		if !isAllDigits(pid) {
			continue
		}
		cmdline, err := os.ReadFile("/proc/" + pid + "/cmdline")
		if err != nil {
			continue
		}
		executable, err := os.Readlink("/proc/" + pid + "/exe")
		if err != nil {
			continue
		}
		if IsRunningApp(string(cmdline), executable, appDir) {
			n := 0
			fmt.Sscanf(pid, "%d", &n)
			return n, true
		}
	}
	return 0, false
}

func isAllDigits(s string) bool {
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

var kdeWindowRe = regexp.MustCompile(`"(0_\{[0-9a-fA-F-]{36}\})",\s*"Zalo",\s*"zalo"`)

// ParseKdeWindowMatch ports parseKdeWindowMatch(): accept only the exact Zalo
// window tuple from KWin's runner output.
func ParseKdeWindowMatch(output string) string {
	m := kdeWindowRe.FindStringSubmatch(output)
	if m == nil {
		return ""
	}
	return m[1]
}

// ActivateKdeWindow ports activateKdeWindow(): a best-effort KDE supplement that
// de-minimizes/focuses the existing window via KWin's runner.
func ActivateKdeWindow(desktop string) bool {
	if !regexp.MustCompile(`(?:^|:)KDE(?:$|:)`).MatchString(desktop) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	out, err := exec.CommandContext(ctx, "qdbus6", "--literal", "org.kde.KWin", "/WindowsRunner",
		"org.kde.krunner1.Match", "Zalo").Output()
	if err != nil {
		return false
	}
	matchID := ParseKdeWindowMatch(string(out))
	if matchID == "" {
		return false
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel2()
	if exec.CommandContext(ctx2, "qdbus6", "org.kde.KWin", "/WindowsRunner",
		"org.kde.krunner1.Run", matchID, "").Run() != nil {
		return false
	}
	return true
}

// ActivateExistingApp ports activateExistingApp(): rely on Electron's
// single-instance event to restore/focus the existing window, with a
// best-effort KDE supplement.
func ActivateExistingApp(c *config.Config, root string, settle time.Duration) bool {
	spec := BuildLaunchSpec(c, root, os.Environ())
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Env = spec.Env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = nil, nil, nil
	if err := cmd.Start(); err != nil {
		return false
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	notified := false
	select {
	case <-done:
		notified = true
	case <-time.After(settle):
		// If the previous owner exited between detection and launch, this child
		// becomes the replacement app; never kill it. Detach it instead.
		_ = cmd.Process.Release()
		notified = true
	}
	if !notified {
		return false
	}
	// Electron 22 can deliver `second-instance` yet leave a minimized Wayland
	// surface minimized; KWin's runner reliably de-minimizes/focuses it.
	ActivateKdeWindow(os.Getenv("XDG_CURRENT_DESKTOP"))
	return true
}

// RunNativeLaunch ports runNativeLaunch(): the top-level flow for `launch`.
func RunNativeLaunch(c *config.Config, root string, check bool) error {
	// Menu activation must not wait for runtime hashing or Pulse/V4L2 probes.
	if !check {
		if _, ok := FindRunningApp(c.AppDir); ok {
			if !ActivateExistingApp(c, root, 750*time.Millisecond) {
				return errors.New("Unable to activate the running Zalo window")
			}
			fmt.Println("Zalo is already running; activated existing window.")
			return nil
		}
	}
	warnings, err := Preflight(c, check)
	if err != nil {
		return err
	}
	if check {
		fmt.Println("PASS native runtime and configured device presence; no call or camera capture started")
		return nil
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "Call device warning: %s. Reconnect the configured device before calling; selection unchanged.\n", w)
	}
	spec := BuildLaunchSpec(c, root, os.Environ())
	if c.ExperimentalVideo != nil && *c.ExperimentalVideo {
		fmt.Println("Starting experimental native voice/video; end-to-end video acceptance remains unverified.")
	} else {
		fmt.Println("Starting experimental native voice; video is disabled.")
	}
	if c.NoSandbox != nil && *c.NoSandbox {
		fmt.Fprintln(os.Stderr, "Warning: Electron sandbox explicitly disabled by configuration.")
	}
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Env = spec.Env
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "Unable to start Electron")
		return errExit(1)
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		for s := range sigs {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(s)
			}
		}
	}()
	err = cmd.Wait()
	signal.Stop(sigs)
	if err == nil {
		return nil
	}
	if ee, ok := err.(*exec.ExitError); ok {
		if code := ee.ExitCode(); code >= 0 {
			return errExit(code)
		}
		return errExit(1)
	}
	return errExit(1)
}

// ExitError carries a process exit code up to the CLI dispatcher.
type ExitError struct{ Code int }

func (e ExitError) Error() string { return fmt.Sprintf("exit status %d", e.Code) }

func errExit(code int) error { return ExitError{Code: code} }
