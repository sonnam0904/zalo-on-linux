package zadark

import (
	"strings"
	"testing"
)

const sampleIndex = `<html lang="vi"><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head><body class="app"><div id="root"></div></body></html>`

func TestPatchPageRoundTrip(t *testing.T) {
	p := pages[0] // index.html
	patched, err := patchPage(sampleIndex, p, true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(patched, `data-zadark-version="`+Version+`"`) {
		t.Error("missing html data attributes")
	}
	if !strings.Contains(patched, "theme-lock.js") {
		t.Error("theme lock not injected")
	}
	if !strings.Contains(patched, `class="app zadark zadark-pc zadark-linux"`) {
		t.Errorf("body classes not added: %s", patched)
	}
	if !strings.Contains(patched, "js/zadark.min.js") {
		t.Error("zadark script not injected")
	}
	// strip() must restore the original.
	restored := strip(patched)
	if restored != sampleIndex {
		t.Errorf("strip did not restore original:\n got: %s\nwant: %s", restored, sampleIndex)
	}
}

func TestPatchBootstrapRoundTrip(t *testing.T) {
	src := "function bootstrap(){\n    return require('./main-dist/main');\n}"
	patched, err := patchBootstrap(src)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(patched, mainLine) {
		t.Error("main line not injected")
	}
	// Idempotent.
	again, _ := patchBootstrap(patched)
	if again != patched {
		t.Error("patchBootstrap not idempotent")
	}
	restored, _ := unpatchBootstrap(patched)
	if restored != src {
		t.Errorf("unpatch did not restore: %q", restored)
	}
}

func TestLockLightIdempotent(t *testing.T) {
	src := "foo updateThemeSetting(e) { return e; } bar"
	locked, _ := lockLight(src)
	if !strings.Contains(locked, lightPatched) {
		t.Error("lockLight did not patch")
	}
	again, _ := lockLight(locked)
	if again != locked {
		t.Error("lockLight not idempotent")
	}
	unlocked, _ := unlockLight(locked)
	if unlocked != src {
		t.Errorf("unlockLight did not restore: %q", unlocked)
	}
}
