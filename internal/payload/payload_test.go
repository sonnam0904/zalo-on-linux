package payload

import (
	"reflect"
	"testing"
)

func TestSelect(t *testing.T) {
	in := []string{
		"bootstrap.js",
		"main-dist/main.js",
		"scripts/native-launch.mjs",
		"random.txt",         // not a root
		"docs/extra.md",      // not under a root
		"nativescript/foo",   // must NOT match "native" prefix (needs native/)
		"native/qt/zcall.js", // under native/
	}
	want := []string{
		"bootstrap.js",
		"main-dist/main.js",
		"scripts/native-launch.mjs",
		"native/qt/zcall.js",
	}
	got := Select(in)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("Select mismatch:\n got %v\nwant %v", got, want)
	}
}
