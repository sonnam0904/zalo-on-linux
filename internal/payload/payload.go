// Package payload ports scripts/application-payload.mjs: the fixed set of
// tracked roots that make up the installable application, and the filter that
// selects payload files from a git file listing.
package payload

import "strings"

// Roots is the frozen list of tracked roots that constitute the application
// payload. Order is preserved from the original for parity.
var Roots = []string{
	"bootstrap.js", "package.json", "version.txt", "libs", "main-dist", "pc-dist", "native", "scripts",
	"start.sh", "update.sh", "CREDITS.md", "README.md", "NATIVE-LAUNCH.md", "NATIVE-INSTALL.md", "NATIVE-TESTING.md",
	"NATIVE-PACKAGING.md",
	"INTEGRATION-STATUS.md", "LINUX-DESKTOP-EXTRAS.md", "CALL-LINUX.md", "CALL-SMOKE.md", "CALL-ACCEPTANCE.md", "HEADER-REGRESSION.md",
	"RELEASE-CHECKLIST.md", "PORT-CHECKLIST.md", "PUBLICATION-AUDIT-ALLOWLIST.json",
}

// Select ports selectApplicationPayload(): keep files that are a payload root
// itself or live under one.
func Select(files []string) []string {
	out := make([]string, 0, len(files))
	for _, file := range files {
		for _, root := range Roots {
			if file == root || strings.HasPrefix(file, root+"/") {
				out = append(out, file)
				break
			}
		}
	}
	return out
}
