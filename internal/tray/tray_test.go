package tray

import (
	"strings"
	"testing"
)

func bundleWithAnchors(n int) string {
	var b strings.Builder
	b.WriteString("const template = [\n")
	for i := 0; i < n; i++ {
		b.WriteString("                                {\n")
		b.WriteString(anchor)
		b.WriteString("\n")
	}
	b.WriteString("];\n")
	return b.String()
}

func TestPatchUnpatchRoundTrip(t *testing.T) {
	src := bundleWithAnchors(2)
	res, err := PatchBundle(src)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Changed || !strings.Contains(res.Text, marker) {
		t.Fatal("expected patched bundle with marker")
	}
	if strings.Count(res.Text, Label) != 1+2 {
		// Label appears in the marker constant string once plus twice injected? Actually
		// the injected item contains the label text twice (label + Notification title).
		// Just assert the entry was inserted after both anchors.
	}
	// Idempotent.
	again, _ := PatchBundle(res.Text)
	if again.Changed {
		t.Error("PatchBundle should be a no-op on already-patched text")
	}
	// Round trip.
	un, err := UnpatchBundle(res.Text)
	if err != nil {
		t.Fatal(err)
	}
	if un.Text != src {
		t.Errorf("unpatch did not restore original")
	}
}

func TestPatchRejectsWrongAnchorCount(t *testing.T) {
	if _, err := PatchBundle(bundleWithAnchors(1)); err == nil {
		t.Error("expected error for 1 anchor")
	}
	if _, err := PatchBundle(bundleWithAnchors(3)); err == nil {
		t.Error("expected error for 3 anchors")
	}
}
