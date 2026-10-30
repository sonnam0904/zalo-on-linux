// Command zalo is the Go port of the Zalo Linux native toolkit (scripts/*.mjs).
// Each subcommand corresponds to one of the original Node scripts; see the
// package-level documentation of each internal package for the mapping.
//
// Usage:
//
//	zalo launch [config.json] [--check]                     native-launch.mjs
//	zalo autoconfig [projectDir]                            auto-config.mjs
//	zalo install CONFIG DEST [--app-dir DIR] [--check] [--no-device-check]
//	zalo update [--check|--rollback|--install-timer|--remove-timer] [--app-dir DIR] [--repo URL] [--ref BRANCH]
//	zalo apply-update [--app-dir DIR] [--timeout-ms N] [--quiet] [--strict]
//	zalo build-appdir CONFIG DEST [--check]                 build-native-appdir.mjs
//	zalo verify-appdir APPDIR                               verify-native-appdir.mjs
//	zalo verify-install DIR [--require-generated]           verify-installation.mjs
//	zalo packaged-launch ROOT [--config JSON] [--check]     packaged-launch.mjs
//	zalo register-desktop DIR [--check]                     register-desktop.mjs
//	zalo tray apply|remove|status [appDir]                  tray-linux.mjs
//	zalo zadark apply|remove [appDir]                       zadark.mjs
//	zalo audit [--staged]                                   audit-publication.mjs
//	zalo debug [-o FILE] [--config JSON] [--app-dir DIR]    (Go only) write a debug report
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"zalo-linux-native/internal/appdir"
	"zalo-linux-native/internal/applyupdate"
	"zalo-linux-native/internal/audit"
	"zalo-linux-native/internal/autoconfig"
	"zalo-linux-native/internal/config"
	"zalo-linux-native/internal/debugreport"
	"zalo-linux-native/internal/desktop"
	"zalo-linux-native/internal/install"
	"zalo-linux-native/internal/launcher"
	"zalo-linux-native/internal/packaged"
	"zalo-linux-native/internal/tray"
	"zalo-linux-native/internal/update"
	"zalo-linux-native/internal/verify"
	"zalo-linux-native/internal/zadark"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	cwd, _ := os.Getwd()
	cmd := os.Args[1]
	args := os.Args[2:]

	switch cmd {
	case "launch":
		cmdLaunch(args)
	case "autoconfig":
		cmdAutoconfig(cwd, args)
	case "install":
		fatal(install.Run(cwd, args))
	case "update":
		os.Exit(update.Run(cwd, args))
	case "apply-update":
		cmdApplyUpdate(cwd, args)
	case "build-appdir":
		appdir.SetSourceRoot(cwd)
		fatal(appdir.RunBuild(args))
	case "verify-appdir":
		fatal(appdir.RunVerify(args))
	case "verify-install":
		cmdVerifyInstall(args)
	case "packaged-launch":
		cmdPackagedLaunch(args)
	case "register-desktop":
		fatal(desktop.Run(args))
	case "tray":
		fatal(tray.Run(cwd, args))
	case "zadark":
		fatal(zadark.Run(cwd, args))
	case "audit":
		os.Exit(audit.Run(cwd, args))
	case "debug":
		fatal(debugreport.Run(args))
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		usage()
		os.Exit(2)
	}
}

func cmdLaunch(args []string) {
	// Keep launcher + Electron output for `zalo debug`, terminal or not.
	flushLaunchLog = debugreport.RedirectOutputToLog()
	// Mirror native-launch.mjs main(): only --check is an accepted flag, and at
	// most one positional config path is allowed.
	nonCheck := 0
	for _, a := range args {
		if strings.HasPrefix(a, "--") && a != "--check" {
			launchFail("Usage: zalo launch [config.json] [--check]")
		}
		if a != "--check" {
			nonCheck++
		}
	}
	if nonCheck > 1 {
		launchFail("Usage: zalo launch [config.json] [--check]")
	}
	configPath := ""
	for _, a := range args {
		if a != "--check" {
			configPath = a
			break
		}
	}
	if configPath == "" {
		base := os.Getenv("XDG_CONFIG_HOME")
		if base == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				launchFail(err.Error())
			}
			base = filepath.Join(home, ".config")
		}
		configPath = filepath.Join(base, "zalo-native-linux", "launch.json")
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		launchFail(err.Error())
	}
	cfg, err := config.Parse(data)
	if err != nil {
		launchFail(err.Error())
	}
	check := false
	for _, a := range args {
		if a == "--check" {
			check = true
		}
	}
	if err := launcher.RunNativeLaunch(cfg, cfg.AppDir, check); err != nil {
		if ee, ok := err.(launcher.ExitError); ok {
			flushLaunchLog()
			os.Exit(ee.Code)
		}
		launchFail(err.Error())
	}
	flushLaunchLog()
}

func cmdAutoconfig(cwd string, args []string) {
	root := cwd
	if len(args) > 0 {
		root, _ = filepath.Abs(args[0])
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fatal(err)
	}
	fatal(autoconfig.Run(root, home))
}

func cmdApplyUpdate(cwd string, args []string) {
	binPath, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "[update] "+err.Error())
		os.Exit(applyupdate.ExitFailed)
	}
	code, err := applyupdate.Run(binPath, cwd, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
	}
	os.Exit(code)
}

func cmdVerifyInstall(args []string) {
	requireGenerated := false
	var pos []string
	for _, a := range args {
		if a == "--require-generated" {
			requireGenerated = true
		} else {
			pos = append(pos, a)
		}
	}
	if len(pos) != 1 || strings.HasPrefix(pos[0], "--") {
		fatal(fmt.Errorf("Usage: zalo verify-install ABSOLUTE_INSTALLATION [--require-generated]"))
	}
	result, err := verify.VerifyInstallation(pos[0], requireGenerated)
	if err != nil {
		fatal(err)
	}
	fmt.Printf("PASS installed payload integrity: %d files\n", result.FileCount)
}

func cmdPackagedLaunch(args []string) {
	if err := packaged.Run(args); err != nil {
		if ee, ok := err.(launcher.ExitError); ok {
			os.Exit(ee.Code)
		}
		fmt.Fprintf(os.Stderr, "%s\n", err.Error())
		os.Exit(1)
	}
}

// flushLaunchLog drains the launcher log pipe; set by cmdLaunch.
var flushLaunchLog = func() {}

func launchFail(msg string) {
	fmt.Fprintf(os.Stderr, "Native launch failed: %s\n", msg)
	flushLaunchLog()
	os.Exit(1)
}

func fatal(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `zalo — Zalo Linux native toolkit (Go port)

Commands:
  launch [config.json] [--check]        Launch Zalo (native voice/video)
  autoconfig [projectDir]               Detect hardware and write launch.json
  install CONFIG DEST [...]             Install a user-local copy
  update [--check|--rollback|...]       Update from the git repository
  apply-update [--app-dir DIR] [...]    Apply a pending update before launch
  build-appdir CONFIG DEST [--check]    Build a self-contained AppDir
  verify-appdir APPDIR                  Verify an AppDir manifest
  verify-install DIR [--require-generated]
  packaged-launch ROOT [--config JSON] [--check]
  register-desktop DIR [--check]        Register the .desktop menu entry
  tray apply|remove|status [appDir]     Toggle the tray update entry
  zadark apply|remove [appDir]          Toggle the ZaDark dark theme
  audit [--staged]                      Scan the publication tree for secrets
  debug [-o FILE] [--config JSON]       Write a debug report (logs, glibc, native modules)
`)
}
