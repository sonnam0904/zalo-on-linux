// Package packaged ports scripts/packaged-launch.mjs: it launches a self-
// contained AppDir, verifying the package manifest and the bundled FFmpeg before
// deriving a launch configuration whose paths point inside the package.
package packaged

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"zalo-linux-native/internal/appdir"
	"zalo-linux-native/internal/config"
	"zalo-linux-native/internal/launcher"
	"zalo-linux-native/internal/pathutil"
)

// PackagedConfig ports packagedConfig(): override appDir/electron/runtime to point
// inside the package, then validate.
func PackagedConfig(packageRoot string, saved []byte) (*config.Config, error) {
	if !pathutil.IsCanonicalAbsolute(packageRoot) {
		return nil, errors.New("Package root must be a canonical absolute path")
	}
	var raw map[string]json.RawMessage
	if json.Unmarshal(saved, &raw) != nil || raw == nil {
		return nil, errors.New("Invalid packaged launch configuration")
	}
	set := func(key, value string) {
		b, _ := json.Marshal(value)
		raw[key] = b
	}
	set("appDir", filepath.Join(packageRoot, "app"))
	set("electron", filepath.Join(packageRoot, "electron", "electron"))
	set("runtime", filepath.Join(packageRoot, "runtime"))
	return config.Validate(raw)
}

// Run ports the packaged-launch.mjs main().
func Run(args []string) error {
	check := false
	var filtered []string
	for _, a := range args {
		if a == "--check" {
			check = true
		} else {
			filtered = append(filtered, a)
		}
	}
	usage := errors.New("Usage: zalo packaged-launch ABSOLUTE_PACKAGE_ROOT [--config ABSOLUTE_JSON] [--check]")
	if (len(filtered) != 1 && len(filtered) != 3) || (len(filtered) == 3 && filtered[1] != "--config") {
		return usage
	}
	packageRoot, err := pathutil.Realpath(filtered[0])
	if err != nil || packageRoot != filtered[0] {
		return errors.New("Package root must not traverse symlinks")
	}
	var configPath string
	if len(filtered) == 3 {
		configPath = filtered[2]
	} else {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, herr := os.UserHomeDir()
			if herr != nil {
				return herr
			}
			base = filepath.Join(home, ".config")
		}
		configPath = filepath.Join(base, "zalo-native-linux", "launch.json")
	}
	if !pathutil.IsCanonicalAbsolute(configPath) {
		return errors.New("Packaged configuration path must be canonical and absolute")
	}
	if _, _, err := appdir.VerifyNativeAppDir(packageRoot); err != nil {
		return err
	}
	ffmpeg := filepath.Join(packageRoot, "tools", "ffmpeg")
	info, err := os.Lstat(ffmpeg)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o111 == 0 {
		return errors.New("Packaged FFmpeg is unavailable")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, ffmpeg, "-version").Run(); err != nil {
		return errors.New("Packaged FFmpeg is unavailable")
	}
	os.Setenv("ZALO_FFMPEG", ffmpeg)
	saved, err := os.ReadFile(configPath)
	if err != nil {
		return err
	}
	cfg, err := PackagedConfig(packageRoot, saved)
	if err != nil {
		return err
	}
	if err := launcher.RunNativeLaunch(cfg, cfg.AppDir, check); err != nil {
		if _, ok := err.(launcher.ExitError); ok {
			return err
		}
		return fmt.Errorf("Packaged launch failed: %w", err)
	}
	return nil
}
