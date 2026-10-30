package debugreport

import (
	"encoding/binary"
	"strings"
	"testing"
	"time"
)

// Vectors produced by lz-string 1.5.0 (the library bundled in the client).
func TestLZDecompressFromBase64(t *testing.T) {
	cases := map[string]string{
		"KIJxHsQLgAgNwKYgM4EtwDsYAMDiAZASQCEBhAfQCYA6AZgA4ByGDcAFxgDNwBXDAExgAKNqkD9eBgDmMAGqpA43gdAyOQxAvBuAAPYCUQA=": "Error: version `GLIBC_2.38' not found (tiếng Việt ✓ 😀)",
		"IYI17SOkg===": "ababababababababababab",
		"Q===":         "",
	}
	for in, want := range cases {
		got, ok := LZDecompressFromBase64(in)
		if !ok || got != want {
			t.Errorf("LZDecompressFromBase64(%q) = %q, %v; want %q", in, got, ok, want)
		}
	}
	if _, ok := LZDecompressFromBase64("not*base64"); ok {
		t.Error("expected failure for invalid base64 input")
	}
}

func TestLZDecompress(t *testing.T) {
	in := "㊄倲ठ⨊⁴Đႜà✂順샶аӈ\u0000"
	if got, ok := LZDecompress(in); !ok || got != "SQLITE.DB.preload" {
		t.Errorf("LZDecompress = %q, %v", got, ok)
	}
}

func TestVersionLess(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"2.35", "2.38", true}, {"2.38", "2.35", false}, {"2.4", "2.38", true}, {"2.38", "2.38", false}, {"2", "2.1", true}} {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%s, %s) = %v", c.a, c.b, got)
		}
	}
}

func cborText(s string) []byte {
	if len(s) < 24 {
		return append([]byte{0x60 | byte(len(s))}, s...)
	}
	return append([]byte{0x78, byte(len(s))}, s...)
}

func zlogRecord(tick int64, level byte, tags string, tmpl string, args ...string) []byte {
	payload := []byte{0xa4}
	payload = append(payload, cborText("$1")...)
	payload = append(payload, 0x05)
	payload = append(payload, cborText("$2")...)
	payload = append(payload, cborText(tags)...)
	payload = append(payload, cborText("$3")...)
	payload = append(payload, 0x80|byte(len(args)))
	for _, a := range args {
		payload = append(payload, cborText(a)...)
	}
	payload = append(payload, cborText("$4")...)
	payload = append(payload, cborText(tmpl)...)

	rec := []byte{17, 127, 0, 0}
	rec = binary.BigEndian.AppendUint64(rec, uint64(tick))
	rec = append(rec, zlogEncoderVersion, level, 8)
	rec = append(rec, "0dpdMc2R"...)
	rec = append(rec, payload...)
	binary.BigEndian.PutUint16(rec[2:], uint16(len(rec)))
	if len(rec)%2 == 1 {
		rec = append(rec, 0)
	}
	return rec
}

func TestParseZlog(t *testing.T) {
	t1 := time.Date(2026, 10, 30, 13, 53, 19, 0, time.UTC)
	t0 := t1.Add(-time.Second)
	// Ring buffer: the newer record sits before the older one in the file.
	data := make([]byte, 8)
	data = append(data, zlogRecord(t1.UnixMilli(), 1, "", "do migrate err {}", "IYI17SOkg===")...)
	data = append(data, 0xff, 0xff, 0xff) // garbage left over from an earlier wrap
	data = append(data, zlogRecord(t0.UnixMilli(), 0, "㊄倲ठ⨊⁴Đႜà✂順샶аӈ\u0000", "", "Q===")...)

	entries := ParseZlog(data)
	if len(entries) != 2 {
		t.Fatalf("got %d entries, want 2: %+v", len(entries), entries)
	}
	if e := entries[0]; e.Level != "INFO" || e.Tags != "SQLITE.DB.preload" || e.Message != "" || !e.Time.Equal(t0) {
		t.Errorf("entry 0 = %+v", e)
	}
	if e := entries[1]; e.Level != "ERROR" || !e.IsError() || e.Message != "do migrate err ababababababababababab" || !e.Time.Equal(t1) {
		t.Errorf("entry 1 = %+v", e)
	}
	if s := entries[1].String(); !strings.Contains(s, "ERROR") || !strings.Contains(s, "do migrate err") {
		t.Errorf("String() = %q", s)
	}
}
