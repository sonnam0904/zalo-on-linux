// Package debugreport implements `zalo debug`: it gathers everything needed to
// diagnose a broken install on someone else's machine (system and glibc info,
// native modules the loader cannot resolve, launch.json, the launcher log and
// the client's own binary .zlog logs, decoded) into a single text file.
package debugreport

import (
	"bufio"
	"bytes"
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"time"

	"zalo-linux-native/internal/config"
)

const maxErrorSummary = 100

type options struct {
	output     string
	configPath string
	appDir     string
	zaloData   string
	lines      int
}

// Run parses `zalo debug` arguments, writes the report and prints its path.
func Run(args []string) error {
	fs := flag.NewFlagSet("debug", flag.ContinueOnError)
	o := options{}
	fs.StringVar(&o.output, "o", "", "output file (default ~/zalo-debug-<time>.txt)")
	fs.StringVar(&o.configPath, "config", "", "launch.json path")
	fs.StringVar(&o.appDir, "app-dir", "", "Zalo app directory (default: from launch.json)")
	fs.StringVar(&o.zaloData, "zalo-data", "", "Zalo user data directory (default ~/.config/ZaloData)")
	fs.IntVar(&o.lines, "lines", 400, "newest entries to include per Zalo log")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("Usage: zalo debug [-o FILE] [--config launch.json] [--app-dir DIR] [--zalo-data DIR] [--lines N]")
	}
	home, _ := os.UserHomeDir()
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		configHome = filepath.Join(home, ".config")
	}
	if o.configPath == "" {
		o.configPath = filepath.Join(configHome, "zalo-on-linux", "launch.json")
	}
	if o.zaloData == "" {
		o.zaloData = filepath.Join(configHome, "ZaloData")
	}
	if o.output == "" {
		o.output = filepath.Join(home, "zalo-debug-"+time.Now().Format("20060102-150405")+".txt")
	}

	var buf bytes.Buffer
	writeReport(&buf, o)
	if err := os.WriteFile(o.output, buf.Bytes(), 0o600); err != nil {
		return err
	}
	fmt.Printf("Đã ghi báo cáo debug: %s\n", o.output)
	fmt.Println("Hãy gửi file này cho người hỗ trợ (file có thể chứa ID tài khoản Zalo, không chứa mật khẩu/tin nhắn).")
	return nil
}

func writeReport(w io.Writer, o options) {
	fmt.Fprintf(w, "Zalo for Linux — báo cáo debug\nThời điểm: %s\n", time.Now().Format(time.RFC3339))

	section(w, "Hệ thống")
	glibc := SystemGlibc()
	kv(w, "OS", osPrettyName())
	kv(w, "Kernel", kernelRelease())
	kv(w, "Arch", runtime.GOARCH)
	kv(w, "glibc", orUnknown(glibc))
	for _, k := range []string{"XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "WAYLAND_DISPLAY", "DISPLAY", "LANG"} {
		kv(w, k, os.Getenv(k))
	}

	section(w, "Cấu hình")
	kv(w, "launch.json", o.configPath)
	var cfg *config.Config
	if data, err := os.ReadFile(o.configPath); err != nil {
		kv(w, "lỗi", err.Error())
	} else {
		fmt.Fprintf(w, "%s\n", bytes.TrimSpace(data))
		if c, err := config.Parse(data); err != nil {
			kv(w, "launch.json không hợp lệ", err.Error())
		} else {
			cfg = c
		}
	}
	if o.appDir == "" && cfg != nil {
		o.appDir = cfg.AppDir
	}
	if o.appDir == "" {
		if exe, err := os.Executable(); err == nil {
			o.appDir = filepath.Dir(exe)
		}
	}
	kv(w, "appDir", o.appDir)
	kv(w, "version.txt", strings.TrimSpace(readSmall(filepath.Join(o.appDir, "version.txt"))))
	kv(w, "gói .deb", commandLine("dpkg-query", "-W", "-f=${Version}", "zalo-on-linux"))
	if cfg != nil {
		kv(w, "electron", fileState(cfg.Electron))
	}

	section(w, "Native modules")
	issues, checked := CheckNativeModules(filepath.Join(o.appDir, "native"), glibc)
	fmt.Fprintf(w, "Đã kiểm tra %d module ELF, %d module không load được.\n", checked, len(issues))
	for _, is := range issues {
		need := ""
		if is.NeedsGlibc != "" {
			need = " (cần GLIBC_" + is.NeedsGlibc + ")"
		}
		fmt.Fprintf(w, "  ✗ %s%s\n", is.Path, need)
		for _, u := range is.Unresolved {
			fmt.Fprintf(w, "      %s\n", u)
		}
	}

	logs := readZlogs(filepath.Join(o.zaloData, "cal"))
	section(w, "Lỗi trong log Zalo (gộp trùng, theo lần xuất hiện đầu)")
	writeErrorSummary(w, logs)

	section(w, "Launcher log: "+LauncherLogPath())
	fmt.Fprintln(w, orUnknown(tailLines(readSmall(LauncherLogPath()), 200)))

	section(w, "ZaloData: "+o.zaloData)
	for _, name := range []string{"startup.log", "cal/migrate-log.log"} {
		fmt.Fprintf(w, "--- %s\n%s\n", name, tailLines(readSmall(filepath.Join(o.zaloData, name)), 50))
	}
	dumps, _ := filepath.Glob(filepath.Join(o.zaloData, "Crashpad", "completed", "*.dmp"))
	kv(w, "Crash dumps", fmt.Sprint(len(dumps)))

	for _, l := range logs {
		section(w, fmt.Sprintf("Log Zalo: %s (%d dòng, hiện %d dòng mới nhất)", l.name, len(l.entries), min(len(l.entries), o.lines)))
		entries := l.entries
		if len(entries) > o.lines {
			entries = entries[len(entries)-o.lines:]
		}
		for _, e := range entries {
			fmt.Fprintln(w, e.String())
		}
	}
}

type zlogFile struct {
	name    string
	entries []ZlogEntry
}

// writeErrorSummary lists each distinct error once, earliest first, so a root
// cause is not pushed out by errors that repeat on every reconnect.
func writeErrorSummary(w io.Writer, logs []zlogFile) {
	type group struct {
		first ZlogEntry
		proc  string
		count int
	}
	var groups []*group
	byKey := map[string]*group{}
	for _, l := range logs {
		for _, e := range l.entries {
			if !e.IsError() {
				continue
			}
			key := l.name + "\x00" + e.Tags + "\x00" + e.Message
			if g := byKey[key]; g != nil {
				g.count++
				continue
			}
			g := &group{first: e, proc: l.name, count: 1}
			byKey[key] = g
			groups = append(groups, g)
		}
	}
	if len(groups) == 0 {
		fmt.Fprintln(w, "(không có)")
		return
	}
	sort.SliceStable(groups, func(i, j int) bool { return groups[i].first.Time.Before(groups[j].first.Time) })
	for i, g := range groups {
		if i == maxErrorSummary {
			fmt.Fprintf(w, "... và %d lỗi khác\n", len(groups)-i)
			break
		}
		fmt.Fprintf(w, "%s: %s (x%d)\n", g.proc, g.first.String(), g.count)
	}
}

func readZlogs(dir string) []zlogFile {
	paths, _ := filepath.Glob(filepath.Join(dir, "*.zlog"))
	sort.Strings(paths)
	var out []zlogFile
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		out = append(out, zlogFile{name: strings.TrimSuffix(filepath.Base(p), ".zlog"), entries: ParseZlog(data)})
	}
	return out
}

func section(w io.Writer, title string) {
	fmt.Fprintf(w, "\n===== %s =====\n", title)
}

func kv(w io.Writer, k, v string) {
	fmt.Fprintf(w, "%-22s %s\n", k+":", v)
}

func orUnknown(s string) string {
	if strings.TrimSpace(s) == "" {
		return "(không có)"
	}
	return s
}

func readSmall(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return ""
	}
	const limit = 1 << 20
	if st.Size() > limit {
		_, _ = f.Seek(st.Size()-limit, io.SeekStart)
	}
	data, _ := io.ReadAll(io.LimitReader(f, limit))
	return string(data)
}

func tailLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}

func osPrettyName() string {
	sc := bufio.NewScanner(strings.NewReader(readSmall("/etc/os-release")))
	for sc.Scan() {
		if v, ok := strings.CutPrefix(sc.Text(), "PRETTY_NAME="); ok {
			return strings.Trim(v, `"`)
		}
	}
	return "(không rõ)"
}

func kernelRelease() string {
	var u syscall.Utsname
	if syscall.Uname(&u) != nil {
		return "(không rõ)"
	}
	var b []byte
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		b = append(b, byte(c))
	}
	return string(b)
}

func commandLine(name string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	if err != nil {
		return "(không có)"
	}
	return strings.TrimSpace(string(out))
}

func fileState(path string) string {
	st, err := os.Stat(path)
	if err != nil {
		return path + " (THIẾU: " + err.Error() + ")"
	}
	if st.Mode()&0o111 == 0 {
		return path + " (không có quyền thực thi)"
	}
	return path + " (ok)"
}
