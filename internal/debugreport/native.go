package debugreport

import (
	"context"
	"debug/elf"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// NativeIssue is one native module that cannot be loaded on this machine.
type NativeIssue struct {
	Path       string
	NeedsGlibc string   // highest GLIBC_x.y symbol version required
	Unresolved []string // ldd "not found" lines
}

var glibcVerRe = regexp.MustCompile(`^GLIBC_([0-9]+(?:\.[0-9]+)*)$`)

// SystemGlibc returns the running glibc version ("2.35"), or "" if unknown.
func SystemGlibc() string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "getconf", "GNU_LIBC_VERSION").Output()
	if err != nil {
		return ""
	}
	f := strings.Fields(string(out))
	if len(f) != 2 {
		return ""
	}
	return f[1]
}

// CheckNativeModules walks root for ELF shared objects built for this CPU and
// reports the ones the dynamic loader cannot resolve here, e.g. a .node file
// that needs a newer glibc than the distro ships. It returns the issues and
// how many modules were checked.
func CheckNativeModules(root, systemGlibc string) ([]NativeIssue, int) {
	machine := map[string]elf.Machine{"amd64": elf.EM_X86_64, "arm64": elf.EM_AARCH64}[runtime.GOARCH]
	_, lddErr := exec.LookPath("ldd")

	var issues []NativeIssue
	checked := 0
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !isSharedObjectName(d.Name()) {
			return nil
		}
		f, err := elf.Open(path)
		if err != nil {
			return nil // darwin/windows binaries, scripts, ...
		}
		ok := f.Machine == machine && f.Type == elf.ET_DYN
		need := maxGlibc(f)
		f.Close()
		if !ok {
			return nil
		}
		checked++

		issue := NativeIssue{Path: path, NeedsGlibc: need}
		if lddErr == nil {
			issue.Unresolved = lddUnresolved(path)
		} else {
			if need != "" && systemGlibc != "" && versionLess(systemGlibc, need) {
				issue.Unresolved = []string{"needs GLIBC_" + need + ", system has " + systemGlibc}
			}
		}
		if len(issue.Unresolved) > 0 {
			issues = append(issues, issue)
		}
		return nil
	})
	return issues, checked
}

func isSharedObjectName(name string) bool {
	return strings.HasSuffix(name, ".node") || strings.HasSuffix(name, ".so") || strings.Contains(name, ".so.")
}

func maxGlibc(f *elf.File) string {
	syms, err := f.ImportedSymbols()
	if err != nil {
		return ""
	}
	best := ""
	for _, s := range syms {
		if m := glibcVerRe.FindStringSubmatch(s.Version); m != nil && (best == "" || versionLess(best, m[1])) {
			best = m[1]
		}
	}
	return best
}

// lddUnresolved runs ldd with the module's own directory on the library path
// (sibling .so files are loaded that way at runtime) and returns the lines
// the loader could not satisfy.
func lddUnresolved(path string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ldd", path)
	cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+filepath.Dir(path))
	out, _ := cmd.CombinedOutput()
	var bad []string
	seen := map[string]bool{}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimPrefix(strings.TrimSpace(line), path+": ")
		if strings.Contains(line, "not found") && !seen[line] {
			seen[line] = true
			bad = append(bad, line)
		}
	}
	sort.Strings(bad)
	return bad
}

// versionLess compares dotted numeric versions ("2.35" < "2.38").
func versionLess(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x = atoi(as[i])
		}
		if i < len(bs) {
			y = atoi(bs[i])
		}
		if x != y {
			return x < y
		}
	}
	return false
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}
