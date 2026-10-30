package launcher

import (
	"testing"

	"zalo-linux-native/internal/config"
)

func mustCfg(t *testing.T) *config.Config {
	t.Helper()
	c, err := config.Parse([]byte(`{"appDir":"/a","electron":"/e","runtime":"/r","source":"mic","sink":"spk"}`))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestIsRunningApp(t *testing.T) {
	appDir := "/home/u/.local/share/zalo"
	exe := "/opt/electron-v22.3.27/electron"
	cases := []struct {
		name    string
		cmdline string
		exe     string
		want    bool
	}{
		{"multi-arg match", "electron\x00--no-sandbox\x00" + appDir + "\x00", exe, true},
		{"renderer type rejected", "electron\x00--type=renderer\x00" + appDir + "\x00", exe, false},
		{"wrong basename", "node\x00" + appDir + "\x00", "/usr/bin/node", false},
		{"multi-arg no appdir", "electron\x00--no-sandbox\x00/other\x00", exe, false},
		{"title form match", exe + " --no-sandbox " + appDir, exe, true},
		{"title form wrong tail", exe + " --no-sandbox /other", exe, false},
		{"title form type rejected", exe + " --type=gpu " + appDir, exe, false},
	}
	for _, tc := range cases {
		if got := IsRunningApp(tc.cmdline, tc.exe, appDir); got != tc.want {
			t.Errorf("%s: IsRunningApp=%v want %v", tc.name, got, tc.want)
		}
	}
}

func TestParseKdeWindowMatch(t *testing.T) {
	good := `[["0_{12345678-1234-1234-1234-1234567890ab}", "Zalo", "zalo"]]`
	if id := ParseKdeWindowMatch(good); id != "0_{12345678-1234-1234-1234-1234567890ab}" {
		t.Errorf("expected match id, got %q", id)
	}
	if id := ParseKdeWindowMatch(`"x", "Terminal", "zalo"`); id != "" {
		t.Errorf("expected no match, got %q", id)
	}
}

func TestBuildLaunchSpecStripsAndAssigns(t *testing.T) {
	c := mustCfg(t)
	spec := BuildLaunchSpec(c, "/root", []string{"LD_PRELOAD=/evil.so", "HOME=/home/u", "ZALO_ZCALL_LOG=bogus"})
	envMap := map[string]string{}
	for _, kv := range spec.Env {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				envMap[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	if _, present := envMap["LD_PRELOAD"]; present {
		t.Error("LD_PRELOAD should be stripped")
	}
	if envMap["ZALO_ZCALL_NATIVE_SETUP"] != "1" {
		t.Error("ZALO_ZCALL_NATIVE_SETUP should be 1")
	}
	if envMap["ZALO_ZCALL_LOG"] != "0" {
		t.Errorf("ZALO_ZCALL_LOG should be forced to 0, got %q", envMap["ZALO_ZCALL_LOG"])
	}
	if spec.Executable != "/e" {
		t.Errorf("executable mismatch: %q", spec.Executable)
	}
	if spec.Args[len(spec.Args)-1] != "/a" {
		t.Errorf("last arg should be appDir, got %q", spec.Args[len(spec.Args)-1])
	}
	if spec.Args[len(spec.Args)-2] != "--enable-logging=stderr" {
		t.Errorf("Chromium logging should be enabled, args %q", spec.Args)
	}
}
