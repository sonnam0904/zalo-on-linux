// Package desktop ports scripts/register-desktop.mjs: it writes a
// ~/.local/share/applications/zalo.desktop menu entry for a verified installed
// copy. No shell is invoked; the Exec line is quoted then desktop-escaped.
package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"zalo-linux-native/internal/pathutil"
	"zalo-linux-native/internal/verify"
)

var desktopUnsafeRe = regexp.MustCompile(`[\x00-\x1f\x7f%=]`)

// DesktopEntry ports desktopEntry().
func DesktopEntry(installation string) (string, error) {
	if !filepath.IsAbs(installation) || filepath.Clean(installation) != installation || desktopUnsafeRe.MatchString(installation) {
		return "", errors.New("Unsupported desktop installation path")
	}
	// Exec quoting, followed by desktop string escaping. No shell is invoked.
	executable := filepath.Join(installation, "launch-installed.sh")
	quoted := regexp.MustCompile("[\"`$\\\\]").ReplaceAllString(executable, `\$0`)
	quoted = strings.ReplaceAll(quoted, `\`, `\\`)
	icon := filepath.Join(installation, "pc-dist/zalo.png")
	return "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Zalo\nComment=Zalo Messenger\nExec=\"" +
		quoted + "\"\nIcon=" + icon + "\nTerminal=false\nCategories=Network;InstantMessaging;\nStartupNotify=true\nStartupWMClass=Zalo\n", nil
}

// RegisterDesktop ports registerDesktop().
func RegisterDesktop(installation, home string, check bool) (string, error) {
	contents, err := DesktopEntry(installation)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(home, installation)
	if err != nil || rel == "" || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", errors.New("Installation must be inside home")
	}
	if real, rerr := pathutil.Realpath(installation); rerr != nil || real != installation {
		return "", errors.New("Installation must not traverse symlinks")
	}
	if _, err := verify.VerifyInstallation(installation, true); err != nil {
		return "", err
	}
	directory := filepath.Join(home, ".local/share/applications")
	if real, rerr := pathutil.Realpath(directory); rerr != nil || real != directory {
		return "", errors.New("Applications directory must exist without symlink traversal")
	}
	target := filepath.Join(directory, "zalo.desktop")
	if info, serr := os.Lstat(target); serr == nil {
		if check && info.Mode().IsRegular() {
			if real, rerr := pathutil.Realpath(target); rerr == nil && real == target {
				if existing, rferr := os.ReadFile(target); rferr == nil && string(existing) == contents {
					return target, nil
				}
			}
		}
		return "", errors.New("Menu entry already exists; preserve or remove it explicitly before registering")
	} else if !os.IsNotExist(serr) {
		return "", serr
	}
	if !check {
		f, oerr := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if oerr != nil {
			return "", oerr
		}
		if _, werr := f.WriteString(contents); werr != nil {
			f.Close()
			return "", werr
		}
		if cerr := f.Close(); cerr != nil {
			return "", cerr
		}
	}
	return target, nil
}

// Run ports the register-desktop.mjs main().
func Run(args []string) error {
	check := false
	var pos []string
	for _, a := range args {
		if a == "--check" {
			check = true
		} else {
			pos = append(pos, a)
		}
	}
	if len(pos) != 1 || strings.HasPrefix(pos[0], "--") {
		return errors.New("Usage: zalo register-desktop INSTALLED_HOME_DIRECTORY [--check]")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	target, err := RegisterDesktop(pos[0], home, check)
	if err != nil {
		return err
	}
	if check {
		fmt.Println("PASS menu registration preflight; no files changed")
	} else {
		fmt.Printf("Registered %s; app not launched\n", target)
	}
	return nil
}
