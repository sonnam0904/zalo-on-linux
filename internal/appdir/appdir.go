// Package appdir ports scripts/build-native-appdir.mjs and
// scripts/verify-native-appdir.mjs: it assembles a self-contained AppDir that
// bundles the application payload, the pinned Electron 22.3.27 runtime, the
// native ZRTC runtime and FFmpeg, then verifies it against a PACKAGE-COMPLETE
// manifest. Local validation only; redistribution gates remain open.
package appdir

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"zalo-linux-native/internal/pathutil"
	"zalo-linux-native/internal/payload"
)

const zrtcHash = "c7e5f005fd5c12dc64d72008a1871638246899a9cf6b034dc13981c014caeefe"

var sha256Re = regexp.MustCompile(`^[a-f0-9]{64}$`)

var requiredRuntimeDirectories = [][2]string{
	{"bionic", "runtime/bionic"},
	{"apk/lib/x86_64", "runtime/apk/lib/x86_64"},
	{"results/platform", "runtime/results/platform"},
}
var requiredRuntimeFiles = [][2]string{
	{"results/zrtc-worker", "runtime/results/zrtc-worker"},
	{"results/pcm-host", "runtime/results/pcm-host"},
}
var requiredAppFiles = []string{
	"bootstrap.js", "package.json", "scripts/native-launch.mjs", "scripts/packaged-launch.mjs",
	"scripts/verify-native-appdir.mjs", "native/qt-call-cap-linux/zcall-agent.js",
}

// BuildConfig is the validated build configuration (electronDir, runtimeDir, ffmpeg).
type BuildConfig struct {
	ElectronDir string `json:"electronDir"`
	RuntimeDir  string `json:"runtimeDir"`
	FFmpeg      string `json:"ffmpeg"`
}

// ValidateBuildConfig ports validateBuildConfig().
func ValidateBuildConfig(data []byte) (*BuildConfig, error) {
	var raw map[string]json.RawMessage
	if json.Unmarshal(data, &raw) != nil {
		return nil, errors.New("Invalid native package build configuration")
	}
	keys := make([]string, 0, len(raw))
	for k := range raw {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "electronDir,ffmpeg,runtimeDir" {
		return nil, errors.New("Invalid native package build configuration")
	}
	var c BuildConfig
	if json.Unmarshal(data, &c) != nil {
		return nil, errors.New("Invalid native package build configuration")
	}
	for name, v := range map[string]string{"electronDir": c.ElectronDir, "runtimeDir": c.RuntimeDir, "ffmpeg": c.FFmpeg} {
		if !pathutil.IsCanonicalAbsolute(v) {
			return nil, fmt.Errorf("Expected canonical absolute path: %s", name)
		}
	}
	return &c, nil
}

type copyItem struct {
	Source string
	File   string
	Mode   int // -1 means inherit from the source file
}
type checkedItem struct {
	Source string
	File   string
	Mode   int
	Size   int64
	SHA256 string
}
type genItem struct {
	File     string
	Contents string
	Mode     int
	Size     int64
	SHA256   string
}

// Plan is the inspected build plan.
type Plan struct {
	Source          string
	Destination     string
	Config          *BuildConfig
	ElectronVersion string
	Checked         []checkedItem
	Generated       []genItem
}

func walkRegularFiles(directory, prefix string) ([]copyItem, error) {
	var files []copyItem
	var visit func(current, relative string) error
	visit = func(current, relative string) error {
		entries, err := os.ReadDir(current)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			child := filepath.Join(current, entry.Name())
			childRelative := entry.Name()
			if relative != "" {
				childRelative = filepath.Join(relative, entry.Name())
			}
			info, lerr := os.Lstat(child)
			if lerr != nil {
				return lerr
			}
			switch {
			case info.IsDir():
				if err := visit(child, childRelative); err != nil {
					return err
				}
			case info.Mode().IsRegular():
				files = append(files, copyItem{Source: child, File: filepath.Join(prefix, childRelative), Mode: -1})
			case info.Mode()&os.ModeSymlink != 0:
				resolved, rerr := pathutil.Realpath(child)
				if rerr != nil {
					return fmt.Errorf("Package input symlink leaves its component: %s", filepath.Join(prefix, childRelative))
				}
				rinfo, serr := os.Lstat(resolved)
				if serr != nil || !pathutil.Under(directory, resolved) || !rinfo.Mode().IsRegular() {
					return fmt.Errorf("Package input symlink leaves its component: %s", filepath.Join(prefix, childRelative))
				}
				files = append(files, copyItem{Source: resolved, File: filepath.Join(prefix, childRelative), Mode: -1})
			default:
				return fmt.Errorf("Package input contains unsupported entry: %s", filepath.Join(prefix, childRelative))
			}
		}
		return nil
	}
	if err := visit(directory, ""); err != nil {
		return nil, err
	}
	return files, nil
}

func inspectCopyItem(item copyItem) (*checkedItem, error) {
	if !pathutil.ValidRelative(item.File) {
		return nil, errors.New("Invalid native package payload path")
	}
	info, err := os.Lstat(item.Source)
	if err != nil {
		return nil, fmt.Errorf("Package input must be a canonical regular file: %s", item.File)
	}
	resolved, rerr := pathutil.Realpath(item.Source)
	if rerr != nil || !info.Mode().IsRegular() || resolved != item.Source {
		return nil, fmt.Errorf("Package input must be a canonical regular file: %s", item.File)
	}
	mode := item.Mode
	if mode < 0 {
		mode = int(info.Mode().Perm())
	}
	if mode < 0 || mode > 0o777 {
		return nil, errors.New("Invalid native package file mode")
	}
	sum, herr := pathutil.HashFile(item.Source)
	if herr != nil {
		return nil, herr
	}
	return &checkedItem{Source: item.Source, File: item.File, Mode: mode, Size: info.Size(), SHA256: sum}, nil
}

// InspectNativeAppDir ports inspectNativeAppDir().
func InspectNativeAppDir(config *BuildConfig, destination, home, source string, trackedFiles []string) (*Plan, error) {
	if !pathutil.IsCanonicalAbsolute(source) {
		return nil, errors.New("Source checkout must be canonical")
	}
	if real, err := pathutil.Realpath(source); err != nil || real != source {
		return nil, errors.New("Source checkout must be canonical")
	}
	if !pathutil.IsCanonicalAbsolute(home) || !pathutil.IsCanonicalAbsolute(destination) ||
		!pathutil.Under(home, destination) || destination == source ||
		pathutil.Under(source, destination) || pathutil.Under(destination, source) {
		return nil, errors.New("Choose a new package directory inside home and outside the source checkout")
	}
	parent := filepath.Dir(destination)
	if real, err := pathutil.Realpath(parent); err != nil || real != parent {
		return nil, errors.New("Package parent must not contain symlinks")
	}
	if _, err := os.Lstat(destination); err == nil {
		return nil, errors.New("Package destination already exists")
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	electronDir, err := pathutil.Realpath(config.ElectronDir)
	if err != nil {
		return nil, errors.New("Electron directory must be canonical")
	}
	if info, serr := os.Lstat(electronDir); electronDir != config.ElectronDir || serr != nil || !info.IsDir() {
		return nil, errors.New("Electron directory must be canonical")
	}
	versionBytes, err := os.ReadFile(filepath.Join(electronDir, "version"))
	if err != nil {
		return nil, err
	}
	electronVersion := strings.TrimSpace(string(versionBytes))
	if electronVersion != "22.3.27" {
		return nil, errors.New("Only the pinned Electron 22.3.27 runtime is supported")
	}
	for _, required := range []string{"electron", "LICENSE", "LICENSES.chromium.html"} {
		if info, serr := os.Lstat(filepath.Join(electronDir, required)); serr != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("Incomplete Electron runtime: %s", required)
		}
	}

	runtimeDir, err := pathutil.Realpath(config.RuntimeDir)
	if err != nil {
		return nil, errors.New("Native runtime directory must be canonical")
	}
	if info, serr := os.Lstat(runtimeDir); runtimeDir != config.RuntimeDir || serr != nil || !info.IsDir() {
		return nil, errors.New("Native runtime directory must be canonical")
	}
	ffmpeg, err := pathutil.Realpath(config.FFmpeg)
	if err != nil {
		return nil, errors.New("FFmpeg must resolve to an executable regular file")
	}
	if info, serr := os.Lstat(ffmpeg); serr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return nil, errors.New("FFmpeg must resolve to an executable regular file")
	}

	listed := trackedFiles
	if listed == nil {
		out, gerr := gitLsFiles(source)
		if gerr != nil {
			return nil, gerr
		}
		listed = out
	}
	for _, f := range listed {
		if !pathutil.ValidRelative(f) {
			return nil, errors.New("Invalid tracked application payload")
		}
	}
	selected := payload.Select(listed)
	selectedSet := map[string]bool{}
	for _, f := range selected {
		selectedSet[f] = true
	}
	for _, required := range requiredAppFiles {
		if !selectedSet[required] {
			return nil, fmt.Errorf("Incomplete application payload: %s", required)
		}
	}

	var items []copyItem
	for _, file := range selected {
		items = append(items, copyItem{Source: filepath.Join(source, file), File: filepath.Join("app", file), Mode: -1})
	}
	electronFiles, err := walkRegularFiles(electronDir, "electron")
	if err != nil {
		return nil, err
	}
	items = append(items, electronFiles...)
	for _, pair := range requiredRuntimeDirectories {
		dir, derr := pathutil.Realpath(filepath.Join(runtimeDir, pair[0]))
		if derr != nil {
			return nil, fmt.Errorf("Incomplete native runtime: %s", pair[0])
		}
		if info, serr := os.Lstat(dir); serr != nil || !info.IsDir() {
			return nil, fmt.Errorf("Incomplete native runtime: %s", pair[0])
		}
		more, werr := walkRegularFiles(dir, pair[1])
		if werr != nil {
			return nil, werr
		}
		items = append(items, more...)
	}
	for _, pair := range requiredRuntimeFiles {
		sourceFile, serr := pathutil.Realpath(filepath.Join(runtimeDir, pair[0]))
		if serr != nil {
			return nil, fmt.Errorf("Incomplete native runtime: %s", pair[0])
		}
		if info, lerr := os.Lstat(sourceFile); lerr != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("Incomplete native runtime: %s", pair[0])
		}
		items = append(items, copyItem{Source: sourceFile, File: pair[1], Mode: 0o755})
	}
	items = append(items, copyItem{Source: ffmpeg, File: "tools/ffmpeg", Mode: 0o755})
	items = append(items, copyItem{Source: filepath.Join(source, "pc-dist/zalo.png"), File: "zalo.png", Mode: 0o644})

	seen := map[string]bool{}
	for _, item := range items {
		if seen[item.File] {
			return nil, errors.New("Duplicate native package path")
		}
		seen[item.File] = true
	}
	var checked []checkedItem
	for _, item := range items {
		ci, cerr := inspectCopyItem(item)
		if cerr != nil {
			return nil, cerr
		}
		checked = append(checked, *ci)
	}
	zrtcOK := false
	for _, c := range checked {
		if c.File == "runtime/apk/lib/x86_64/libzrtc.so" {
			if c.SHA256 != zrtcHash {
				return nil, errors.New("Unsupported native ZRTC library hash")
			}
			zrtcOK = true
		}
	}
	if !zrtcOK {
		return nil, errors.New("Unsupported native ZRTC library hash")
	}
	for _, required := range []string{"electron/electron", "runtime/bionic/linker64", "runtime/results/zrtc-worker", "runtime/results/pcm-host", "tools/ffmpeg"} {
		found := false
		for _, c := range checked {
			if c.File == required {
				if c.Mode&0o111 == 0 {
					return nil, fmt.Errorf("Packaged executable is unavailable: %s", required)
				}
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("Packaged executable is unavailable: %s", required)
		}
	}

	appRun := "#!/bin/bash\nset -euo pipefail\nZALO_PACKAGE_ROOT=\"$(cd -- \"${BASH_SOURCE[0]%/*}\" && pwd -P)\"\nexport ELECTRON_RUN_AS_NODE=1\nexec \"$ZALO_PACKAGE_ROOT/electron/electron\" \"$ZALO_PACKAGE_ROOT/app/scripts/packaged-launch.mjs\" \"$ZALO_PACKAGE_ROOT\" \"$@\"\n"
	desktop := "[Desktop Entry]\nName=Zalo\nComment=Zalo Messenger\nExec=AppRun\nIcon=zalo\nTerminal=false\nType=Application\nCategories=Network;InstantMessaging;\nStartupWMClass=Zalo\n"
	generated := []genItem{
		{File: "AppRun", Contents: appRun, Mode: 0o755, Size: int64(len(appRun)), SHA256: pathutil.HashBytes([]byte(appRun))},
		{File: "zalo.desktop", Contents: desktop, Mode: 0o644, Size: int64(len(desktop)), SHA256: pathutil.HashBytes([]byte(desktop))},
	}
	return &Plan{Source: source, Destination: destination, Config: config, ElectronVersion: electronVersion, Checked: checked, Generated: generated}, nil
}

// BuildNativeAppDir ports buildNativeAppDir().
func BuildNativeAppDir(plan *Plan) (int, string, error) {
	if err := os.Mkdir(plan.Destination, 0o755); err != nil {
		return 0, "", err
	}
	count, err := copyPackage(plan)
	if err != nil {
		return 0, "", fmt.Errorf("Native package build incomplete; destination retained for inspection: %w", err)
	}
	return count, plan.ElectronVersion, nil
}

func copyPackage(plan *Plan) (int, error) {
	for _, item := range plan.Checked {
		target := filepath.Join(plan.Destination, item.File)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return 0, err
		}
		if err := copyFileExcl(item.Source, target, os.FileMode(item.Mode)); err != nil {
			return 0, err
		}
		info, serr := os.Lstat(target)
		if serr != nil || info.Size() != item.Size {
			return 0, fmt.Errorf("Package copy changed: %s", item.File)
		}
		if sum, herr := pathutil.HashFile(target); herr != nil || sum != item.SHA256 {
			return 0, fmt.Errorf("Package copy changed: %s", item.File)
		}
	}
	for _, item := range plan.Generated {
		target := filepath.Join(plan.Destination, item.File)
		if err := writeFileExcl(target, []byte(item.Contents), os.FileMode(item.Mode)); err != nil {
			return 0, err
		}
	}
	type manifestEntry struct {
		File   string `json:"file"`
		Mode   int    `json:"mode"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}
	var entries []manifestEntry
	for _, c := range plan.Checked {
		entries = append(entries, manifestEntry{File: c.File, Mode: c.Mode, Size: c.Size, SHA256: c.SHA256})
	}
	for _, g := range plan.Generated {
		entries = append(entries, manifestEntry{File: g.File, Mode: g.Mode, Size: g.Size, SHA256: g.SHA256})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].File < entries[j].File })
	marker := map[string]any{
		"format":               1,
		"architecture":         "x86_64",
		"electronVersion":      plan.ElectronVersion,
		"bundledElectron":      true,
		"bundledNativeRuntime": true,
		"bundledFfmpeg":        true,
		"fileCount":            len(entries),
		"files":                entries,
	}
	markerBytes, err := json.MarshalIndent(marker, "", "  ")
	if err != nil {
		return 0, err
	}
	if err := writeFileExcl(filepath.Join(plan.Destination, "PACKAGE-COMPLETE.json"), append(markerBytes, '\n'), 0o644); err != nil {
		return 0, err
	}
	if _, _, err := VerifyNativeAppDir(plan.Destination); err != nil {
		return 0, err
	}
	return len(entries), nil
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

// VerifyNativeAppDir ports verifyNativeAppDir().
func VerifyNativeAppDir(packageRoot string) (int, string, error) {
	if !pathutil.IsCanonicalAbsolute(packageRoot) {
		return 0, "", errors.New("Package path must be canonical and absolute")
	}
	if real, err := pathutil.Realpath(packageRoot); err != nil || real != packageRoot {
		return 0, "", errors.New("Package path must not traverse symlinks")
	}
	markerPath := filepath.Join(packageRoot, "PACKAGE-COMPLETE.json")
	info, err := os.Lstat(markerPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > 32*1024*1024 {
		return 0, "", errors.New("Invalid native package marker")
	}
	if real, rerr := pathutil.Realpath(markerPath); rerr != nil || real != markerPath {
		return 0, "", errors.New("Invalid native package marker")
	}
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return 0, "", errors.New("Invalid native package marker")
	}
	var m struct {
		Format               *int              `json:"format"`
		Architecture         string            `json:"architecture"`
		ElectronVersion      string            `json:"electronVersion"`
		BundledElectron      *bool             `json:"bundledElectron"`
		BundledNativeRuntime *bool             `json:"bundledNativeRuntime"`
		BundledFfmpeg        *bool             `json:"bundledFfmpeg"`
		FileCount            *int              `json:"fileCount"`
		Files                []json.RawMessage `json:"files"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return 0, "", errors.New("Invalid native package marker")
	}
	if m.Format == nil || *m.Format != 1 || m.Architecture != "x86_64" || m.ElectronVersion != "22.3.27" ||
		!boolTrue(m.BundledElectron) || !boolTrue(m.BundledNativeRuntime) || !boolTrue(m.BundledFfmpeg) ||
		m.Files == nil || m.FileCount == nil || *m.FileCount != len(m.Files) || *m.FileCount < 1 {
		return 0, "", errors.New("Invalid native package manifest")
	}
	type entry struct {
		File   string `json:"file"`
		Mode   int    `json:"mode"`
		Size   int64  `json:"size"`
		SHA256 string `json:"sha256"`
	}
	seen := map[string]bool{}
	entries := make([]entry, 0, len(m.Files))
	for _, rawEntry := range m.Files {
		var keys map[string]json.RawMessage
		if json.Unmarshal(rawEntry, &keys) != nil {
			return 0, "", errors.New("Invalid native package manifest entry")
		}
		names := make([]string, 0, len(keys))
		for k := range keys {
			names = append(names, k)
		}
		sort.Strings(names)
		var e entry
		if strings.Join(names, ",") != "file,mode,sha256,size" || json.Unmarshal(rawEntry, &e) != nil ||
			!pathutil.ValidRelative(e.File) || !sha256Re.MatchString(e.SHA256) || e.Size < 0 ||
			e.Mode < 0 || e.Mode > 0o777 || seen[e.File] {
			return 0, "", errors.New("Invalid native package manifest entry")
		}
		seen[e.File] = true
		entries = append(entries, e)
	}
	for _, required := range []string{"AppRun", "zalo.desktop", "zalo.png", "electron/electron", "electron/LICENSE",
		"runtime/bionic/linker64", "runtime/apk/lib/x86_64/libzrtc.so", "runtime/results/zrtc-worker", "runtime/results/pcm-host",
		"tools/ffmpeg", "app/bootstrap.js", "app/package.json", "app/scripts/packaged-launch.mjs", "app/scripts/native-launch.mjs"} {
		if !seen[required] {
			return 0, "", errors.New("Incomplete native package manifest")
		}
	}
	for _, e := range entries {
		target := filepath.Join(packageRoot, e.File)
		info, serr := os.Lstat(target)
		if serr != nil || !info.Mode().IsRegular() || info.Size() != e.Size || int(info.Mode().Perm()) != e.Mode {
			return 0, "", fmt.Errorf("Native package integrity check failed: %s", e.File)
		}
		if real, rerr := pathutil.Realpath(target); rerr != nil || real != target {
			return 0, "", fmt.Errorf("Native package integrity check failed: %s", e.File)
		}
		if sum, herr := pathutil.HashFile(target); herr != nil || sum != e.SHA256 {
			return 0, "", fmt.Errorf("Native package integrity check failed: %s", e.File)
		}
	}
	return *m.FileCount, m.ElectronVersion, nil
}

func boolTrue(p *bool) bool { return p != nil && *p }

func gitLsFiles(source string) ([]string, error) {
	args := append([]string{"ls-files", "-z", "--"}, payload.Roots...)
	cmd := exec.Command("git", args...)
	cmd.Dir = source
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var files []string
	for _, s := range strings.Split(string(out), "\x00") {
		if s != "" {
			files = append(files, s)
		}
	}
	return files, nil
}

// RunBuild ports the build-native-appdir.mjs main().
func RunBuild(args []string) error {
	check := false
	var pos []string
	for _, a := range args {
		if a == "--check" {
			check = true
		} else {
			pos = append(pos, a)
		}
	}
	if len(pos) != 2 || strings.HasPrefix(pos[0], "--") || strings.HasPrefix(pos[1], "--") {
		return errors.New("Usage: zalo build-appdir BUILD_CONFIG_JSON NEW_HOME_APPDIR [--check]")
	}
	data, err := os.ReadFile(pos[0])
	if err != nil {
		return err
	}
	config, err := ValidateBuildConfig(data)
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	source, err := pathutil.Realpath(sourceRoot())
	if err != nil {
		return err
	}
	plan, err := InspectNativeAppDir(config, pos[1], home, source, nil)
	if err != nil {
		return err
	}
	if check {
		fmt.Printf("PASS native AppDir preflight: %d files; Electron %s; no files changed\n", len(plan.Checked)+len(plan.Generated), plan.ElectronVersion)
		return nil
	}
	count, version, err := BuildNativeAppDir(plan)
	if err != nil {
		return err
	}
	fmt.Printf("PASS native AppDir build: %d files; Electron %s\n", count, version)
	fmt.Println("Local validation only: redistribution and clean-machine release gates remain open.")
	return nil
}

// RunVerify ports the verify-native-appdir.mjs main().
func RunVerify(args []string) error {
	if len(args) != 1 {
		return errors.New("Usage: zalo verify-appdir ABSOLUTE_APPDIR")
	}
	count, version, err := VerifyNativeAppDir(args[0])
	if err != nil {
		return err
	}
	fmt.Printf("PASS native AppDir integrity: %d files; Electron %s\n", count, version)
	return nil
}

// sourceRoot is overridden by the CLI to point at the project checkout.
var sourceRootValue string

func sourceRoot() string {
	if sourceRootValue != "" {
		return sourceRootValue
	}
	wd, _ := os.Getwd()
	return wd
}

// SetSourceRoot lets the CLI pin the project root for build operations.
func SetSourceRoot(root string) { sourceRootValue = root }
