package config

import "testing"

func mustParse(t *testing.T, s string) *Config {
	t.Helper()
	c, err := Parse([]byte(s))
	if err != nil {
		t.Fatalf("Parse(%s) unexpected error: %v", s, err)
	}
	return c
}

func parseErr(t *testing.T, s string) {
	t.Helper()
	if _, err := Parse([]byte(s)); err == nil {
		t.Fatalf("Parse(%s) expected error, got nil", s)
	}
}

const minimal = `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk"}`

func TestParseMinimal(t *testing.T) {
	c := mustParse(t, minimal)
	if c.AppDir != "/a" || c.Electron != "/e" || c.Runtime != "/r" || c.Source != "mic" || c.Sink != "spk" {
		t.Fatalf("fields mismatch: %+v", c)
	}
	if c.NoSandbox != nil || c.Log != nil {
		t.Fatalf("absent optionals should be nil")
	}
}

func TestParseRejectsUnknownKey(t *testing.T) {
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","bogus":1}`)
}

func TestParseRejectsRelativePath(t *testing.T) {
	parseErr(t, `{"appDir":"a","electron":"/e","runtime":"/r","source":"mic","sink":"spk"}`)
}

func TestParseRejectsMonitorSource(t *testing.T) {
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"x.monitor","sink":"spk"}`)
}

func TestVideoDeviceRequiresOptIn(t *testing.T) {
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","videoDevice":"/dev/video0"}`)
}

func TestExperimentalVideoRequiresDevice(t *testing.T) {
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","experimentalVideo":true}`)
	c := mustParse(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","experimentalVideo":true,"videoDevice":"/dev/video2"}`)
	if c.VideoDevice == nil || *c.VideoDevice != "/dev/video2" {
		t.Fatalf("videoDevice mismatch")
	}
}

func TestCdpPortBounds(t *testing.T) {
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","cdpPort":1023}`)
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","cdpPort":70000}`)
	parseErr(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","cdpPort":1234.5}`)
	c := mustParse(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","cdpPort":9222}`)
	if c.CDPPort == nil || *c.CDPPort != 9222 {
		t.Fatalf("cdpPort mismatch")
	}
}

func TestMarshalRoundTrip(t *testing.T) {
	c := mustParse(t, `{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk","noSandbox":true,"log":false}`)
	out, err := c.MarshalIndent()
	if err != nil {
		t.Fatal(err)
	}
	c2 := mustParse(t, string(out))
	if c2.NoSandbox == nil || !*c2.NoSandbox || c2.Log == nil || *c2.Log {
		t.Fatalf("round trip lost optional booleans: %s", out)
	}
}
