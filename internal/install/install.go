// Package install ports scripts/install-native.mjs: it copies the tracked
// application payload into a new user-local directory with hash-verified copies,
// writes a pinned launcher and an integrity manifest, and never overwrites,
// migrates profiles, downloads dependencies, or touches global desktop files.
//
// Fidelity note: the original generated a bash launcher that pinned the Node
// binary and ran scripts/*.mjs. This Go port pins the compiled `zalo` binary
// (LauncherBinVar) and calls its subcommands, so the installed copy is driven by
// Go instead of Node. The byte layout of the manifest and the per-file integrity
// contract are preserved.
package install

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"zalo-linux-native/internal/config"
	"zalo-linux-native/internal/launcher"
	"zalo-linux-native/internal/pathutil"
	"zalo-linux-native/internal/payload"
)

// LauncherBinVar is the shell variable in launch-installed.sh that pins the
// compiled launcher binary. tray.go reads it back to drive update checks.
const LauncherBinVar = "ZALO_INSTALLED_BIN"

// Plan is the validated installation plan.
type Plan struct {
	Source          string
	Destination     string
	InstalledAppDir string
	Home            string
	Files           []string
	Config          *config.Config
}

type checkedFile struct {
	File   string
	Source string
	Mode   os.FileMode
	SHA256 string
}

// InstallPlan ports installPlan().
func InstallPlan(source, destination, installedAppDir, home string, c *config.Config, files []string) (*Plan, error) {
	for _, value := range []string{source, home} {
		if !pathutil.IsCanonicalAbsolute(value) {
			return nil, errors.New("Source and home must be canonical absolute paths")
		}
	}
	badDest := func(dir string) bool {
		return !pathutil.IsCanonicalAbsolute(dir) || !pathutil.Under(home, dir) || dir == source ||
			pathutil.Under(source, dir) || pathutil.Under(dir, source)
	}
	if badDest(destination) || badDest(installedAppDir) {
		return nil, errors.New("Choose a new installation directory inside home and outside the source checkout")
	}
	if len(files) == 0 {
		return nil, errors.New("Invalid tracked payload paths")
	}
	for _, f := range files {
		if !pathutil.ValidRelative(f) {
			return nil, errors.New("Invalid tracked payload paths")
		}
	}
	selected := payload.Select(files)
	seen := map[string]bool{}
	for _, f := range selected {
		if seen[f] {
			return nil, errors.New("Duplicate payload path")
		}
		seen[f] = true
	}
	for _, required := range []string{"bootstrap.js", "package.json", "scripts/native-launch.mjs",
		"scripts/verify-installation.mjs", "native/qt-call-cap-linux/zcall-agent.js"} {
		if !seen[required] {
			return nil, errors.New("Incomplete application payload")
		}
	}
	finalConfig := c.Clone()
	finalConfig.AppDir = installedAppDir
	return &Plan{
		Source: source, Destination: destination, InstalledAppDir: installedAppDir,
		Home: home, Files: selected, Config: finalConfig,
	}, nil
}

// InspectInstallation ports inspectInstallation(): validate the destination does
// not yet exist and every payload file is a canonical regular file, hashing each.
func InspectInstallation(plan *Plan) ([]checkedFile, error) {
	parentDir := filepath.Dir(plan.Destination)
	if real, err := pathutil.Realpath(parentDir); err != nil || real != parentDir {
		return nil, errors.New("Installation parent must not contain symlinks")
	}
	if _, err := os.Lstat(plan.Destination); err == nil {
		return nil, errors.New("Installation destination already exists")
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	var checked []checkedFile
	for _, file := range plan.Files {
		src := filepath.Join(plan.Source, file)
		resolved, err := pathutil.Realpath(src)
		if err != nil {
			return nil, errors.New("Payload must contain regular files without symlink traversal")
		}
		info, err := os.Lstat(src)
		if err != nil || resolved != src || !info.Mode().IsRegular() {
			return nil, errors.New("Payload must contain regular files without symlink traversal")
		}
		sum, err := pathutil.HashFile(src)
		if err != nil {
			return nil, err
		}
		checked = append(checked, checkedFile{File: file, Source: src, Mode: info.Mode().Perm(), SHA256: sum})
	}
	return checked, nil
}

// CopyInstallation ports copyInstallation().
func CopyInstallation(plan *Plan) error {
	checked, err := InspectInstallation(plan)
	if err != nil {
		return err
	}
	if err := os.Mkdir(plan.Destination, 0o700); err != nil {
		return err
	}
	if err := copyPayload(plan, checked); err != nil {
		return fmt.Errorf("Installation incomplete; destination retained for inspection: %w", err)
	}
	return nil
}

func copyPayload(plan *Plan, checked []checkedFile) error {
	for _, item := range checked {
		target := filepath.Join(plan.Destination, item.File)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := copyFileExcl(item.Source, target, item.Mode); err != nil {
			return err
		}
		if sum, err := pathutil.HashFile(target); err != nil || sum != item.SHA256 {
			return errors.New("Payload changed during installation")
		}
	}
	configText, err := plan.Config.MarshalIndent()
	if err != nil {
		return err
	}
	configText = append(configText, '\n')

	binPath, err := os.Executable()
	if err != nil {
		return errors.New("Launcher binary is unavailable")
	}
	binPath, _ = filepath.Abs(binPath)
	if !pathutil.IsAbsoluteNoControl(binPath) {
		return errors.New("Launcher binary is unavailable")
	}
	if info, serr := os.Lstat(binPath); serr != nil || !info.Mode().IsRegular() {
		return errors.New("Launcher binary is unavailable")
	}
	launcherText := BuildInstalledLauncher(binPath)

	if err := writeFileExcl(filepath.Join(plan.Destination, "launch.json"), configText, 0o600); err != nil {
		return err
	}
	if err := writeFileExcl(filepath.Join(plan.Destination, "launch-installed.sh"), []byte(launcherText), 0o755); err != nil {
		return err
	}
	type manifestEntry struct {
		File   string `json:"file"`
		Mode   int    `json:"mode"`
		SHA256 string `json:"sha256"`
	}
	entries := make([]manifestEntry, 0, len(checked)+2)
	for _, c := range checked {
		entries = append(entries, manifestEntry{File: c.File, Mode: int(c.Mode), SHA256: c.SHA256})
	}
	entries = append(entries,
		manifestEntry{File: "launch.json", Mode: 0o600, SHA256: pathutil.HashBytes(configText)},
		manifestEntry{File: "launch-installed.sh", Mode: 0o755, SHA256: pathutil.HashBytes([]byte(launcherText))},
	)
	marker := map[string]any{
		"format":             1,
		"fileCount":          len(entries),
		"externalRuntime":    true,
		"generatedIntegrity": true,
		"files":              entries,
	}
	markerBytes, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return err
	}
	return writeFileExcl(filepath.Join(plan.Destination, "INSTALL-COMPLETE.json"), append(markerBytes, '\n'), 0o600)
}

// BuildInstalledLauncher renders launch-installed.sh pinning the compiled
// launcher binary. The update pass runs before exec so "quit and reopen Zalo"
// applies a pending update; it is best effort and never blocks launch (|| true).
func BuildInstalledLauncher(binPath string) string {
	quoted := "'" + strings.ReplaceAll(binPath, "'", "'\\''") + "'"
	var b strings.Builder
	b.WriteString("#!/bin/bash\n")
	b.WriteString("set -euo pipefail\n")
	b.WriteString("ZALO_INSTALLED_DIR=\"$(cd -- \"${BASH_SOURCE[0]%/*}\" && pwd -P)\"\n")
	b.WriteString(LauncherBinVar + "=" + quoted + "\n")
	b.WriteString("if [[ ! -x \"$" + LauncherBinVar + "\" ]]; then\n")
	b.WriteString("    echo 'Installed Zalo launcher binary is unavailable; recreate this installation.' >&2\n")
	b.WriteString("    exit 1\n")
	b.WriteString("fi\n")
	b.WriteString("\"$" + LauncherBinVar + "\" verify-install \"$ZALO_INSTALLED_DIR\" --require-generated\n")
	b.WriteString("\"$" + LauncherBinVar + "\" apply-update --app-dir \"$ZALO_INSTALLED_DIR\" --quiet || true\n")
	b.WriteString("exec \"$" + LauncherBinVar + "\" launch \"$ZALO_INSTALLED_DIR/launch.json\" \"$@\"\n")
	return b.String()
}

func copyFileExcl(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
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
	return os.Chmod(dst, mode)
}

func writeFileExcl(path string, data []byte, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// Run ports the install-native.mjs main(): parse args, read config, list the
// tracked payload with git, build the plan, preflight, and copy.
func Run(root string, args []string) error {
	var pos []string
	check := false
	deviceCheck := true
	installedAppDir := ""
	appDirSet := false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--check":
			if check {
				return errors.New("Duplicate --check")
			}
			check = true
		case "--no-device-check":
			deviceCheck = false
		case "--app-dir":
			if appDirSet || i+1 >= len(args) || strings.HasPrefix(args[i+1], "--") {
				return errors.New("Invalid --app-dir")
			}
			installedAppDir = args[i+1]
			appDirSet = true
			i++
		default:
			pos = append(pos, args[i])
		}
	}
	if len(pos) != 2 {
		return errors.New("Usage: zalo install CONFIG_JSON NEW_HOME_DIRECTORY [--app-dir FINAL_HOME_DIRECTORY] [--check] [--no-device-check]")
	}
	for _, a := range pos {
		if strings.HasPrefix(a, "--") {
			return errors.New("Usage: zalo install CONFIG_JSON NEW_HOME_DIRECTORY [--app-dir FINAL_HOME_DIRECTORY] [--check] [--no-device-check]")
		}
	}
	data, err := os.ReadFile(pos[0])
	if err != nil {
		return err
	}
	c, err := config.Parse(data)
	if err != nil {
		return err
	}
	source, err := pathutil.Realpath(root)
	if err != nil {
		return err
	}
	files, err := gitTrackedPayload(source)
	if err != nil {
		return err
	}
	if !appDirSet {
		installedAppDir = pos[1]
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	plan, err := InstallPlan(source, pos[1], installedAppDir, home, c, files)
	if err != nil {
		return err
	}
	if _, err := InspectInstallation(plan); err != nil {
		return err
	}
	// Preflight against the source tree (appDir=source) with the requested device policy.
	preflightCfg := c.Clone()
	preflightCfg.AppDir = source
	if _, err := launcher.Preflight(preflightCfg, deviceCheck); err != nil {
		return err
	}
	if check {
		fmt.Printf("PASS install preflight: %d tracked files; no files changed\n", len(plan.Files))
		return nil
	}
	if err := CopyInstallation(plan); err != nil {
		return err
	}
	fmt.Println("Native development installation copied. Launch with launch-installed.sh inside the new directory.")
	fmt.Println("Runtime and Electron remain external; this is not a self-contained release.")
	return nil
}

// gitTrackedPayload runs `git ls-files -z -- <roots>` in source.
func gitTrackedPayload(source string) ([]string, error) {
	args := append([]string{"ls-files", "-z", "--"}, payload.Roots...)
	cmd := exec.Command("git", args...)
	cmd.Dir = source
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return splitNul(out), nil
}

func splitNul(b []byte) []string {
	var out []string
	for _, s := range strings.Split(string(b), "\x00") {
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}
