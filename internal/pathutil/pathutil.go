// Package pathutil mirrors the path and filesystem invariants the original
// Node scripts enforced with node:path and node:fs. The Linux port treats
// configuration as data and never sources shell, so every path that crosses a
// trust boundary is validated the same way it was in JavaScript.
package pathutil

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// HasControlChars reports whether a string contains NUL, CR or LF. The Node
// code rejected these on every path to keep launch.json data from smuggling
// newlines into generated shell launchers.
func HasControlChars(s string) bool {
	return strings.ContainsAny(s, "\x00\r\n")
}

// IsAbsoluteNoControl matches the native-launch path check for appDir, electron
// and runtime: an absolute path free of NUL/CR/LF. Unlike IsCanonicalAbsolute
// it does not require the path to already be normalized.
func IsAbsoluteNoControl(value string) bool {
	return filepath.IsAbs(value) && !HasControlChars(value)
}

// IsCanonicalAbsolute matches the JS `canonicalAbsolute` helper: an absolute
// path that is already normalized (filepath.Clean is a no-op) and free of
// control characters.
func IsCanonicalAbsolute(value string) bool {
	return filepath.IsAbs(value) && filepath.Clean(value) == value && !HasControlChars(value)
}

// ValidRelative matches the JS `validRelative` helper: a non-empty relative
// path with no backslashes, no absolute prefix, no control characters, and no
// empty / "." / ".." components.
func ValidRelative(value string) bool {
	if value == "" || strings.Contains(value, "\\") || filepath.IsAbs(value) || HasControlChars(value) {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Under reports whether child lives strictly inside parent, mirroring the JS
// `under` helper built on path.relative. Equal paths are not "under".
func Under(parent, child string) bool {
	rel, err := filepath.Rel(parent, child)
	if err != nil {
		return false
	}
	return rel != "" && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// Realpath resolves symlinks like node:fs realpath. It returns the cleaned
// absolute path with every symlink component expanded.
func Realpath(p string) (string, error) {
	return filepath.EvalSymlinks(p)
}

// IsFile reports whether p is a regular file (follows symlinks, like fs.stat).
func IsFile(p string) (bool, error) {
	info, err := os.Stat(p)
	if err != nil {
		return false, err
	}
	return info.Mode().IsRegular(), nil
}

// HashFile streams a file through sha256 and returns the lowercase hex digest,
// mirroring the JS hashFile() helpers built on createReadStream.
func HashFile(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// HashBytes returns the lowercase hex sha256 of b.
func HashBytes(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
