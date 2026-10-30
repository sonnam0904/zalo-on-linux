// Package audit ports scripts/audit-publication.mjs: a bounded, value-redacting
// secret scan over the tracked (or staged) publication tree. It is a
// high-confidence local guard, not a replacement for GitHub secret scanning or a
// full history review. Findings print only path, line and rule name.
package audit

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"zalo-linux-native/internal/pathutil"
)

type rule struct {
	name string
	re   *regexp.Regexp
}

var rules = []rule{
	{"private-key", regexp.MustCompile(`-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----`)},
	{"github-token", regexp.MustCompile(`(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{50,255})`)},
	{"gitlab-token", regexp.MustCompile(`glpat-[A-Za-z0-9_-]{20,255}`)},
	{"aws-access-key", regexp.MustCompile(`(?:AKIA|ASIA)[0-9A-Z]{16}`)},
	{"google-api-key", regexp.MustCompile(`AIza[0-9A-Za-z_-]{35}`)},
	{"slack-token", regexp.MustCompile(`xox[baprs]-[0-9A-Za-z-]{20,255}`)},
	{"stripe-live-key", regexp.MustCompile(`(?:sk|rk)_live_[0-9A-Za-z]{20,255}`)},
	{"literal-session-secret", regexp.MustCompile(`(?i)(?:zpw_sek|access[_-]?token|refresh[_-]?token|session[_-]?key)\s*[:=]\s*["'][0-9A-Za-z+/=_-]{20,}["']`)},
	{"developer-home-path", regexp.MustCompile(`/home/rurimeiko/`)},
	{"codex-session-path", regexp.MustCompile(`\.codex/sessions/`)},
	{"bluetooth-hardware-address", regexp.MustCompile(`bluez_(?:input|output)\.[0-9A-Fa-f]{2}(?:[:_][0-9A-Fa-f]{2}){5}`)},
	{"usb-device-serial", regexp.MustCompile(`alsa_(?:input|output)\.usb-[^\s"']*_[0-9A-Fa-f]{8,}-`)},
}

var forbiddenNames = map[string]bool{
	".env": true, ".npmrc": true, ".netrc": true, "credentials": true, "credentials.json": true,
	"cookies": true, "cookies.json": true, "id_rsa": true, "id_ed25519": true,
	"login data": true, "local state": true,
}

var allowSha256Re = regexp.MustCompile(`^[0-9a-f]{64}$`)
var indexModeRe = regexp.MustCompile(`^(\d{6}) [0-9a-f]+ 0\t`)

type finding struct {
	relative string
	line     int
	rule     string
}

// Run ports the audit-publication.mjs script and returns a process exit code.
func Run(root string, args []string) int {
	staged := false
	for _, a := range args {
		if a != "--staged" {
			fmt.Fprintln(os.Stderr, "Usage: zalo audit [--staged]")
			return 2
		}
		staged = true
	}

	var gitArgs []string
	if staged {
		gitArgs = []string{"diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"}
	} else {
		gitArgs = []string{"ls-files", "-z"}
	}
	listed, err := gitBytes(root, gitArgs...)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Unable to enumerate publication files")
		return 2
	}
	files := splitNulSorted(listed)
	if staged && len(files) == 0 {
		fmt.Fprintln(os.Stderr, "No staged publication files to audit")
		return 2
	}
	fileSet := map[string]bool{}
	for _, f := range files {
		fileSet[f] = true
	}

	ruleNames := map[string]bool{}
	for _, r := range rules {
		ruleNames[r.name] = true
	}

	// Load the allowlist.
	var allowBytes []byte
	if staged {
		allowBytes, err = gitBytesLimited(root, "show", ":PUBLICATION-AUDIT-ALLOWLIST.json")
	} else {
		allowBytes, err = os.ReadFile(filepath.Join(root, "PUBLICATION-AUDIT-ALLOWLIST.json"))
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Invalid publication audit allowlist")
		return 2
	}
	var allowDoc struct {
		SchemaVersion *int              `json:"schemaVersion"`
		Entries       []json.RawMessage `json:"entries"`
	}
	if json.Unmarshal(allowBytes, &allowDoc) != nil {
		fmt.Fprintln(os.Stderr, "Invalid publication audit allowlist")
		return 2
	}
	if allowDoc.SchemaVersion == nil || *allowDoc.SchemaVersion != 1 || allowDoc.Entries == nil {
		fmt.Fprintln(os.Stderr, "Invalid publication audit allowlist")
		return 2
	}

	allowUsed := map[string]bool{}
	var allowOrder []string
	for _, rawEntry := range allowDoc.Entries {
		path, reason, ruleName, sha256, ok := parseAllowEntry(rawEntry)
		if !ok || !validAuditPath(path) || (!staged && !fileSet[path]) || !ruleNames[ruleName] ||
			!allowSha256Re.MatchString(sha256) || len(reason) < 20 {
			fmt.Fprintln(os.Stderr, "Invalid publication audit allowlist entry")
			return 2
		}
		key := path + "\x00" + ruleName + "\x00" + sha256
		if _, dup := allowUsed[key]; dup {
			fmt.Fprintln(os.Stderr, "Duplicate publication audit allowlist entry")
			return 2
		}
		allowUsed[key] = false
		allowOrder = append(allowOrder, key)
	}

	var findings []finding
	for _, relative := range files {
		if !validAuditPath(relative) {
			findings = append(findings, finding{relative, 0, "unsafe-path"})
			continue
		}
		base := strings.ToLower(filepath.Base(relative))
		if forbiddenNames[base] || strings.HasPrefix(base, ".env.") {
			findings = append(findings, finding{relative, 0, "sensitive-filename"})
		}
		data, skip, f := readBlob(root, relative, staged)
		if skip {
			if f != nil {
				findings = append(findings, *f)
			}
			continue
		}
		for _, r := range rules {
			for _, loc := range r.re.FindAllIndex(data, -1) {
				matched := data[loc[0]:loc[1]]
				digest := pathutil.HashBytes(matched)
				key := relative + "\x00" + r.name + "\x00" + digest
				if _, ok := allowUsed[key]; ok {
					allowUsed[key] = true
					continue
				}
				line := bytes.Count(data[:loc[0]], []byte{'\n'}) + 1
				findings = append(findings, finding{relative, line, r.name})
			}
		}
	}
	if !staged {
		for _, key := range allowOrder {
			if !allowUsed[key] {
				findings = append(findings, finding{strings.SplitN(key, "\x00", 2)[0], 0, "stale-audit-allowlist"})
			}
		}
	}
	if len(findings) > 0 {
		for _, f := range findings {
			quoted, _ := json.Marshal(f.relative)
			if f.line != 0 {
				fmt.Fprintf(os.Stderr, "%s:%d: %s\n", quoted, f.line, f.rule)
			} else {
				fmt.Fprintf(os.Stderr, "%s: %s\n", quoted, f.rule)
			}
		}
		fmt.Fprintf(os.Stderr, "FAIL publication audit: %d redacted finding(s) in %d file(s)\n", len(findings), len(files))
		return 1
	}
	reviewed := 0
	for _, used := range allowUsed {
		if used {
			reviewed++
		}
	}
	scope := "tracked"
	if staged {
		scope = "staged"
	}
	fmt.Printf("PASS publication audit: %d %s files; %d hash-reviewed match(es); values redacted\n", len(files), scope, reviewed)
	return 0
}

// readBlob returns the file bytes, or (nil, true, finding) when the file should be
// skipped with a finding, or (nil, true, nil) when skipped without one.
func readBlob(root, relative string, staged bool) ([]byte, bool, *finding) {
	const maxSize = 64 * 1024 * 1024
	if staged {
		mode, ok := indexMode(root, relative)
		if !ok {
			return nil, true, &finding{relative, 0, "unreadable-file"}
		}
		if mode != "100644" && mode != "100755" {
			return nil, true, &finding{relative, 0, "unsupported-file-type"}
		}
		sizeOut, serr := gitString(root, "cat-file", "-s", ":"+relative)
		if serr != nil {
			return nil, true, &finding{relative, 0, "unreadable-file"}
		}
		var size int64
		if _, perr := fmt.Sscanf(strings.TrimSpace(sizeOut), "%d", &size); perr != nil || size < 0 {
			return nil, true, &finding{relative, 0, "unreadable-file"}
		}
		if size > maxSize {
			return nil, true, &finding{relative, 0, "unscanned-oversize-file"}
		}
		data, berr := gitBytesLimited(root, "show", ":"+relative)
		if berr != nil {
			return nil, true, &finding{relative, 0, "unreadable-file"}
		}
		return data, false, nil
	}
	absolute := filepath.Join(root, relative)
	info, lerr := os.Lstat(absolute)
	if lerr != nil {
		return nil, true, &finding{relative, 0, "unreadable-file"}
	}
	if !info.Mode().IsRegular() {
		return nil, true, &finding{relative, 0, "unsupported-file-type"}
	}
	if info.Size() > maxSize {
		return nil, true, &finding{relative, 0, "unscanned-oversize-file"}
	}
	data, rerr := os.ReadFile(absolute)
	if rerr != nil {
		return nil, true, &finding{relative, 0, "unreadable-file"}
	}
	return data, false, nil
}

func parseAllowEntry(raw json.RawMessage) (path, reason, ruleName, sha256 string, ok bool) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return "", "", "", "", false
	}
	names := make([]string, 0, len(keys))
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "path,reason,rule,sha256" {
		return "", "", "", "", false
	}
	var e struct {
		Path   string `json:"path"`
		Reason string `json:"reason"`
		Rule   string `json:"rule"`
		SHA256 string `json:"sha256"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return "", "", "", "", false
	}
	return e.Path, e.Reason, e.Rule, e.SHA256, true
}

func validAuditPath(relative string) bool {
	if relative == "" || filepath.IsAbs(relative) || pathutil.HasControlChars(relative) {
		return false
	}
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

func indexMode(root, relative string) (string, bool) {
	out, err := gitBytes(root, "ls-files", "--stage", "-z", "--", relative)
	if err != nil {
		return "", false
	}
	var records []string
	for _, s := range strings.Split(string(out), "\x00") {
		if s != "" {
			records = append(records, s)
		}
	}
	if len(records) != 1 {
		return "", false
	}
	m := indexModeRe.FindStringSubmatch(records[0])
	if m == nil {
		return "", false
	}
	return m[1], true
}

func gitBytes(root string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = root
	return cmd.Output()
}

func gitBytesLimited(root string, args ...string) ([]byte, error) {
	return gitBytes(root, args...)
}

func gitString(root string, args ...string) (string, error) {
	out, err := gitBytes(root, args...)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func splitNulSorted(b []byte) []string {
	var out []string
	for _, s := range strings.Split(string(b), "\x00") {
		if s != "" {
			out = append(out, s)
		}
	}
	sort.Strings(out)
	return out
}
