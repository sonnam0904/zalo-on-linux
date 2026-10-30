// Package tray ports scripts/tray-linux.mjs: it adds a "Kiểm tra cập nhật"
// entry to Zalo's tray menu by patching the main-process bundle
// (main-dist/main.js), the only reliable place because Electron 22 exposes Tray
// as a non-configurable getter.
//
// Fidelity note: the injected menu handler runs inside Electron (it stays
// JavaScript). The original ran `node scripts/update-native.mjs --check`; this
// port reads the pinned launcher binary from launch-installed.sh
// (ZALO_INSTALLED_BIN) and runs `<bin> update --check` instead.
package tray

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"zalo-linux-native/internal/install"
	"zalo-linux-native/internal/pathutil"
)

// Label is the menu entry text; MARKER detects an already-patched bundle.
const Label = "Kiểm tra cập nhật"

var marker = `label: "` + Label + `"`

// anchor is the "Mở Zalo" menu block that both templates (logged-in and
// logged-out) contain; the new entry is inserted directly after it.
var anchor = strings.Join([]string{
	`                                    label: "Mở Zalo",`,
	`                                    click: en`,
	`                                },`,
}, "\n")

// item is the injected menu entry. Kept as a string so patchBundle stays pure.
var item = buildItem()

func buildItem() string {
	// This JavaScript runs inside the Electron main process.
	return `{
    label: "Kiểm tra cập nhật",
    click: () => {
        try {
            const cp = require("child_process"),
                fs = require("fs"),
                p = require("path"),
                root = p.join(__dirname, ".."),
                {Notification} = require("electron");
            const done = (body) => {
                try { new Notification({title: "Kiểm tra cập nhật", body}).show(); }
                catch (e) { console.log("[update] " + body); }
            };
            // launch-installed.sh pins the compiled launcher binary; process.execPath
            // here is Electron, not the launcher.
            let bin = null;
            try {
                const launcher = fs.readFileSync(p.join(root, "launch-installed.sh"), "utf8");
                const match = launcher.match(/^` + install.LauncherBinVar + `='([^']+)'/m);
                if (match && fs.existsSync(match[1])) bin = match[1];
            } catch (_) {}
            if (!bin) {
                done("Không tìm thấy Zalo launcher của bản cài đặt; hãy cài lại Zalo.");
                return;
            }
            done("Đang kiểm tra...");
            cp.execFile(bin, ["update", "--check", "--app-dir", root],
                {timeout: 180000}, (error, stdout, stderr) => {
                    if (error && error.code === 10)
                        return done("Có bản mới. Thoát hẳn Zalo rồi mở lại để cập nhật.");
                    if (error && error.code === 3)
                        return done("Có bản mới nhưng Zalo đang chạy. Thoát hẳn rồi mở lại.");
                    if (error)
                        return done("Kiểm tra thất bại: " + String(stderr || error.message || "").trim().split("\n").pop());
                    done("Bạn đang dùng bản mới nhất.");
                });
        } catch (error) {
            console.log("[update] tray check failed: " + (error && error.message));
        }
    }
}`
}

// PatchResult reports the patched text and whether it changed.
type PatchResult struct {
	Text    string
	Changed bool
}

// PatchBundle ports patchBundle(): insert the entry after both "Mở Zalo" anchors.
func PatchBundle(text string) (*PatchResult, error) {
	if strings.Contains(text, marker) {
		return &PatchResult{Text: text, Changed: false}, nil
	}
	count := strings.Count(text, anchor)
	if count != 2 {
		return nil, fmt.Errorf("Expected 2 \"Mở Zalo\" anchors, found %d", count)
	}
	return &PatchResult{Text: strings.ReplaceAll(text, anchor, anchor+" "+item+","), Changed: true}, nil
}

// UnpatchBundle ports unpatchBundle().
func UnpatchBundle(text string) (*PatchResult, error) {
	if !strings.Contains(text, marker) {
		return &PatchResult{Text: text, Changed: false}, nil
	}
	withItem := anchor + " " + item + ","
	count := strings.Count(text, withItem)
	if count != 2 {
		return nil, fmt.Errorf("Expected 2 patched anchors, found %d", count)
	}
	return &PatchResult{Text: strings.ReplaceAll(text, withItem, anchor), Changed: true}, nil
}

// refreshManifestHash ports refreshManifestHash(): keep INSTALL-COMPLETE.json
// consistent with the edited bundle. Source checkouts have no manifest (no-op).
func refreshManifestHash(root, relative string, content []byte) error {
	marker := filepath.Join(root, "INSTALL-COMPLETE.json")
	raw, err := os.ReadFile(marker)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	files, ok := m["files"].([]any)
	if !ok {
		return nil
	}
	for _, f := range files {
		entry, ok := f.(map[string]any)
		if !ok {
			continue
		}
		if entry["file"] == relative {
			sum := pathutil.HashBytes(content)
			if entry["sha256"] == sum {
				return nil
			}
			entry["sha256"] = sum
			out, merr := json.MarshalIndent(m, "", "  ")
			if merr != nil {
				return merr
			}
			return os.WriteFile(marker, append(out, '\n'), 0o600)
		}
	}
	return nil
}

func mainBundlePath(root string) string { return filepath.Join(root, "main-dist/main.js") }

// Apply patches the bundle and refreshes the manifest. Returns nil on success.
func Apply(root string) error {
	return edit(root, PatchBundle)
}

// Remove unpatches the bundle and refreshes the manifest.
func Remove(root string) error {
	return edit(root, UnpatchBundle)
}

func edit(root string, fn func(string) (*PatchResult, error)) error {
	file := mainBundlePath(root)
	before, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	result, err := fn(string(before))
	if err != nil {
		return err
	}
	if result.Changed {
		if err := os.WriteFile(file, []byte(result.Text), 0o644); err != nil {
			return err
		}
		if err := refreshManifestHash(root, "main-dist/main.js", []byte(result.Text)); err != nil {
			return err
		}
	}
	return nil
}

// Status prints whether the entry is present.
func Status(root string) error {
	before, err := os.ReadFile(mainBundlePath(root))
	if err != nil {
		return err
	}
	if strings.Contains(string(before), marker) {
		fmt.Println("tray update entry: present")
	} else {
		fmt.Println("tray update entry: absent")
	}
	return nil
}

// Run ports the tray-linux.mjs main().
func Run(binDir string, args []string) error {
	if len(args) < 1 {
		return errors.New("Usage: zalo tray apply|remove|status [appDir]")
	}
	action := args[0]
	dir := ""
	if len(args) > 1 {
		dir = args[1]
	}
	root := binDir
	if dir != "" {
		root, _ = filepath.Abs(dir)
	}
	switch action {
	case "status":
		return Status(root)
	case "apply":
		file := mainBundlePath(root)
		before, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		result, err := PatchBundle(string(before))
		if err != nil {
			return err
		}
		if result.Changed {
			if err := os.WriteFile(file, []byte(result.Text), 0o644); err != nil {
				return err
			}
			if err := refreshManifestHash(root, "main-dist/main.js", []byte(result.Text)); err != nil {
				return err
			}
		}
		fmt.Printf("Added tray update entry: %s\n", changedWord(result.Changed))
		return nil
	case "remove":
		file := mainBundlePath(root)
		before, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		result, err := UnpatchBundle(string(before))
		if err != nil {
			return err
		}
		if result.Changed {
			if err := os.WriteFile(file, []byte(result.Text), 0o644); err != nil {
				return err
			}
			if err := refreshManifestHash(root, "main-dist/main.js", []byte(result.Text)); err != nil {
				return err
			}
		}
		fmt.Printf("Removed tray update entry: %s\n", changedWord(result.Changed))
		return nil
	default:
		return errors.New("Usage: zalo tray apply|remove|status [appDir]")
	}
}

func changedWord(changed bool) string {
	if changed {
		return "changed"
	}
	return "no change"
}
