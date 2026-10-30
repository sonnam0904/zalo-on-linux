// Package config ports the configuration model from scripts/native-launch.mjs.
//
// Configuration is data, never sourced shell. Every field that becomes a path,
// a Pulse device name or an Electron argument is validated here before it can
// reach spawn(). Optional fields use pointers so that "absent" and "present but
// false/zero" stay distinguishable, exactly as `undefined` vs `false` did in
// the original JavaScript.
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"zalo-linux-native/internal/pathutil"
)

// Config is the validated launch.json model. Required string fields are always
// present after validation; optional fields are nil when the key was absent.
type Config struct {
	AppDir   string
	Electron string
	Runtime  string
	Source   string
	Sink     string

	NoSandbox            *bool
	CDPPort              *int
	ExperimentalVideo    *bool
	VideoDevice          *string
	ExperimentalIncoming *bool
	Log                  *bool
}

// allowedKeys is the exact set of launch.json keys; any other key is rejected.
var allowedKeys = map[string]bool{
	"appDir": true, "electron": true, "runtime": true, "source": true,
	"sink": true, "noSandbox": true, "cdpPort": true, "experimentalVideo": true,
	"videoDevice": true, "experimentalIncoming": true, "log": true,
}

var deviceNameRe = regexp.MustCompile(`^[A-Za-z0-9_.:-]+$`)
var videoDeviceRe = regexp.MustCompile(`^/dev/video[0-9]+$`)

func boolPtr(b bool) *bool    { return &b }
func strPtr(s string) *string { return &s }
func intPtr(i int) *int       { return &i }

// Parse decodes and validates a launch.json byte slice.
func Parse(data []byte) (*Config, error) {
	var raw map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(data))
	if err := dec.Decode(&raw); err != nil {
		return nil, fmt.Errorf("invalid native-launch configuration: %w", err)
	}
	return Validate(raw)
}

// Validate ports validateConfig(). It takes the raw key/value map so presence of
// each optional key can be detected the same way `k in config` did in JS.
func Validate(raw map[string]json.RawMessage) (*Config, error) {
	if raw == nil {
		return nil, fmt.Errorf("Invalid native-launch configuration keys")
	}
	for k := range raw {
		if !allowedKeys[k] {
			return nil, fmt.Errorf("Invalid native-launch configuration keys")
		}
	}
	c := &Config{}

	// Required absolute paths.
	for _, key := range []string{"appDir", "electron", "runtime"} {
		var s string
		if err := decodeString(raw, key, &s); err != nil || !pathutil.IsAbsoluteNoControl(s) {
			return nil, fmt.Errorf("Expected absolute path: %s", key)
		}
		switch key {
		case "appDir":
			c.AppDir = s
		case "electron":
			c.Electron = s
		case "runtime":
			c.Runtime = s
		}
	}

	// Required Pulse device names.
	for _, key := range []string{"source", "sink"} {
		var s string
		if err := decodeString(raw, key, &s); err != nil || !deviceNameRe.MatchString(s) {
			return nil, fmt.Errorf("Expected explicit Pulse device name: %s", key)
		}
		if key == "source" {
			c.Source = s
		} else {
			c.Sink = s
		}
	}
	if strings.HasSuffix(c.Source, ".monitor") {
		return nil, fmt.Errorf("Choose a microphone, not a playback monitor")
	}

	// Optional booleans.
	var err error
	if c.ExperimentalVideo, err = optBool(raw, "experimentalVideo"); err != nil {
		return nil, fmt.Errorf("experimentalVideo must be boolean")
	}
	if c.ExperimentalIncoming, err = optBool(raw, "experimentalIncoming"); err != nil {
		return nil, fmt.Errorf("experimentalIncoming must be boolean")
	}
	// Opt-in diagnostics: launch.json boolean only; the environment never selects
	// logging (config-isolation invariant). true leaves a phase trace
	// (~/.config/ZaloData/zcall-agent.log) after a stuck call.
	if c.Log, err = optBool(raw, "log"); err != nil {
		return nil, fmt.Errorf("log must be boolean")
	}

	// Experimental video requires an explicit /dev/videoN device; videoDevice is
	// forbidden without the opt-in.
	if isTrue(c.ExperimentalVideo) {
		var s string
		if derr := decodeString(raw, "videoDevice", &s); derr != nil || !videoDeviceRe.MatchString(s) {
			return nil, fmt.Errorf("Experimental video requires an explicit /dev/videoN device")
		}
		c.VideoDevice = strPtr(s)
	} else if _, ok := raw["videoDevice"]; ok {
		return nil, fmt.Errorf("videoDevice requires experimentalVideo opt-in")
	}

	if c.NoSandbox, err = optBool(raw, "noSandbox"); err != nil {
		return nil, fmt.Errorf("noSandbox must be boolean")
	}

	if v, ok := raw["cdpPort"]; ok {
		var n json.Number
		d := json.NewDecoder(bytes.NewReader(v))
		d.UseNumber()
		if d.Decode(&n) != nil {
			return nil, fmt.Errorf("cdpPort must be 1024..65535")
		}
		i, ierr := n.Int64()
		if ierr != nil || !strings.ContainsAny(string(n), "0123456789") || strings.Contains(string(n), ".") || i < 1024 || i > 65535 {
			return nil, fmt.Errorf("cdpPort must be 1024..65535")
		}
		c.CDPPort = intPtr(int(i))
	}

	return c, nil
}

func decodeString(raw map[string]json.RawMessage, key string, out *string) error {
	v, ok := raw[key]
	if !ok {
		return fmt.Errorf("missing")
	}
	return json.Unmarshal(v, out)
}

func optBool(raw map[string]json.RawMessage, key string) (*bool, error) {
	v, ok := raw[key]
	if !ok {
		return nil, nil
	}
	var b bool
	if err := json.Unmarshal(v, &b); err != nil {
		return nil, err
	}
	return boolPtr(b), nil
}

func isTrue(p *bool) bool { return p != nil && *p }

// Clone returns a deep copy, matching the JS `{...config}` spread.
func (c *Config) Clone() *Config {
	cp := *c
	if c.NoSandbox != nil {
		cp.NoSandbox = boolPtr(*c.NoSandbox)
	}
	if c.CDPPort != nil {
		cp.CDPPort = intPtr(*c.CDPPort)
	}
	if c.ExperimentalVideo != nil {
		cp.ExperimentalVideo = boolPtr(*c.ExperimentalVideo)
	}
	if c.VideoDevice != nil {
		cp.VideoDevice = strPtr(*c.VideoDevice)
	}
	if c.ExperimentalIncoming != nil {
		cp.ExperimentalIncoming = boolPtr(*c.ExperimentalIncoming)
	}
	if c.Log != nil {
		cp.Log = boolPtr(*c.Log)
	}
	return &cp
}

// MarshalJSON emits the config with a stable key order, writing only the keys
// that are present. Required keys are always written. This is used for the
// launch.json the installer and updater generate; because each installation
// hashes the bytes it writes itself, a canonical order (rather than preserving
// the original byte order) is sufficient and deterministic.
func (c *Config) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString("{")
	type kv struct {
		key string
		val any
	}
	items := []kv{
		{"appDir", c.AppDir}, {"electron", c.Electron}, {"runtime", c.Runtime},
		{"source", c.Source}, {"sink", c.Sink},
	}
	if c.NoSandbox != nil {
		items = append(items, kv{"noSandbox", *c.NoSandbox})
	}
	if c.CDPPort != nil {
		items = append(items, kv{"cdpPort", *c.CDPPort})
	}
	if c.ExperimentalVideo != nil {
		items = append(items, kv{"experimentalVideo", *c.ExperimentalVideo})
	}
	if c.VideoDevice != nil {
		items = append(items, kv{"videoDevice", *c.VideoDevice})
	}
	if c.ExperimentalIncoming != nil {
		items = append(items, kv{"experimentalIncoming", *c.ExperimentalIncoming})
	}
	if c.Log != nil {
		items = append(items, kv{"log", *c.Log})
	}
	for i, it := range items {
		if i > 0 {
			buf.WriteByte(',')
		}
		k, _ := json.Marshal(it.key)
		v, err := json.Marshal(it.val)
		if err != nil {
			return nil, err
		}
		buf.Write(k)
		buf.WriteByte(':')
		buf.Write(v)
	}
	buf.WriteString("}")
	return buf.Bytes(), nil
}

// MarshalIndent renders the config as pretty 2-space JSON, matching the
// JSON.stringify(config,null,2) the Node scripts wrote to launch.json.
func (c *Config) MarshalIndent() ([]byte, error) {
	compact, err := c.MarshalJSON()
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, compact, "", "  "); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
