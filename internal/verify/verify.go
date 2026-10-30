// Package verify ports scripts/verify-installation.mjs: it checks that an
// installed copy matches its INSTALL-COMPLETE.json manifest, byte for byte,
// before the launcher is allowed to run it.
package verify

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"zalo-linux-native/internal/pathutil"
)

var sha256Re = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Result summarizes a successful verification.
type Result struct {
	FileCount          int
	GeneratedIntegrity bool
}

type entry struct {
	File   string `json:"file"`
	Mode   int    `json:"mode"`
	SHA256 string `json:"sha256"`
}

type manifest struct {
	Format             *int              `json:"format"`
	ExternalRuntime    *bool             `json:"externalRuntime"`
	GeneratedIntegrity bool              `json:"generatedIntegrity"`
	FileCount          *int              `json:"fileCount"`
	Files              []json.RawMessage `json:"files"`
}

// VerifyInstallation ports verifyInstallation().
func VerifyInstallation(installation string, requireGenerated bool) (*Result, error) {
	if !pathutil.IsCanonicalAbsolute(installation) {
		return nil, errors.New("Installation path must be canonical and absolute")
	}
	if real, err := pathutil.Realpath(installation); err != nil || real != installation {
		return nil, errors.New("Installation must not traverse symlinks")
	}
	markerPath := filepath.Join(installation, "INSTALL-COMPLETE.json")
	info, err := os.Lstat(markerPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 2 || info.Size() > 32*1024*1024 {
		return nil, errors.New("Invalid installation marker")
	}
	if real, rerr := pathutil.Realpath(markerPath); rerr != nil || real != markerPath {
		return nil, errors.New("Invalid installation marker")
	}
	raw, err := os.ReadFile(markerPath)
	if err != nil {
		return nil, errors.New("Invalid installation marker")
	}
	var m manifest
	if json.Unmarshal(raw, &m) != nil {
		return nil, errors.New("Invalid installation marker")
	}
	if m.Format == nil || *m.Format != 1 || m.ExternalRuntime == nil || !*m.ExternalRuntime ||
		m.Files == nil || m.FileCount == nil || *m.FileCount != len(m.Files) || *m.FileCount < 1 {
		return nil, errors.New("Invalid installation manifest")
	}

	seen := map[string]bool{}
	entries := make([]entry, 0, len(m.Files))
	for _, rawEntry := range m.Files {
		e, verr := parseEntry(rawEntry)
		if verr != nil || !pathutil.ValidRelative(e.File) || !sha256Re.MatchString(e.SHA256) ||
			e.Mode < 0 || e.Mode > 0o777 || seen[e.File] {
			return nil, errors.New("Invalid installation manifest entry")
		}
		seen[e.File] = true
		entries = append(entries, *e)
	}
	for _, required := range []string{"bootstrap.js", "package.json", "scripts/native-launch.mjs", "scripts/verify-installation.mjs"} {
		if !seen[required] {
			return nil, errors.New("Incomplete installation manifest")
		}
	}
	if requireGenerated && (!m.GeneratedIntegrity || !seen["launch.json"] || !seen["launch-installed.sh"]) {
		return nil, errors.New("Installation lacks generated-file integrity metadata; reinstall into a new directory")
	}
	for _, e := range entries {
		target := filepath.Join(installation, e.File)
		info, serr := os.Lstat(target)
		if serr != nil || !info.Mode().IsRegular() {
			return nil, fmt.Errorf("Installation integrity check failed: %s", e.File)
		}
		if real, rerr := pathutil.Realpath(target); rerr != nil || real != target {
			return nil, fmt.Errorf("Installation integrity check failed: %s", e.File)
		}
		if int(info.Mode().Perm()) != e.Mode {
			return nil, fmt.Errorf("Installation integrity check failed: %s", e.File)
		}
		if sum, herr := pathutil.HashFile(target); herr != nil || sum != e.SHA256 {
			return nil, fmt.Errorf("Installation integrity check failed: %s", e.File)
		}
	}
	return &Result{FileCount: *m.FileCount, GeneratedIntegrity: m.GeneratedIntegrity}, nil
}

// parseEntry decodes a manifest file entry and enforces that it is an object
// with exactly the keys file, mode and sha256.
func parseEntry(raw json.RawMessage) (*entry, error) {
	var keys map[string]json.RawMessage
	if json.Unmarshal(raw, &keys) != nil {
		return nil, errors.New("invalid entry")
	}
	names := make([]string, 0, len(keys))
	for k := range keys {
		names = append(names, k)
	}
	sort.Strings(names)
	if strings.Join(names, ",") != "file,mode,sha256" {
		return nil, errors.New("invalid entry")
	}
	var e entry
	if json.Unmarshal(raw, &e) != nil {
		return nil, errors.New("invalid entry")
	}
	return &e, nil
}
