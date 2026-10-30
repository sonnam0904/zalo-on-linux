// Package autoconfig ports scripts/auto-config.mjs: detect the host's Electron,
// native runtime and PulseAudio/PipeWire devices, then write a launch.json for
// the current machine.
package autoconfig

import (
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"

	"zalo-linux-native/internal/config"
)

func boolPtr(b bool) *bool    { return &b }
func strPtr(s string) *string { return &s }

// Run generates launch.json in root (the project checkout root).
func Run(root, home string) error {
	// 1. Locate or automatically download Electron v22.3.27.
	electron := filepath.Join(home, ".local", "electron-v22.3.27", "electron")
	if !exists(electron) {
		alt := filepath.Join(home, "electron-v22.3.27", "electron")
		if exists(alt) {
			electron = alt
		} else {
			fmt.Println("Electron v22.3.27 not found. Downloading automatically...")
			electronDir := filepath.Join(home, ".local", "electron-v22.3.27")
			if err := os.MkdirAll(electronDir, 0o755); err == nil {
				if downloadElectron(electronDir) {
					electron = filepath.Join(electronDir, "electron")
					fmt.Println("Installed Electron v22.3.27 at:", electron)
				}
			}
		}
	}

	// 2. Locate the native runtime.
	runtime := filepath.Join(root, "runtime")
	if !exists(filepath.Join(runtime, "bionic", "linker64")) {
		recovery := filepath.Join(home, "zalo-native-recovery", "mute-evidence-20260910", "runtime")
		if exists(recovery) {
			runtime = recovery
		}
	}

	// 3. Auto-detect microphone.
	source := ""
	if def := strings.TrimSpace(cmdOutput("pactl", "get-default-source")); def != "" && !strings.HasSuffix(def, ".monitor") {
		source = def
	}
	if source == "" {
		for _, line := range splitLines(cmdOutput("pactl", "list", "sources", "short")) {
			parts := strings.Split(line, "\t")
			name := ""
			if len(parts) > 1 {
				name = parts[1]
			} else if len(parts) == 1 {
				name = parts[0]
			}
			if name != "" && !strings.HasSuffix(name, ".monitor") {
				source = name
				break
			}
		}
	}

	// 4. Auto-detect speaker.
	sink := ""
	if def := strings.TrimSpace(cmdOutput("pactl", "get-default-sink")); def != "" {
		sink = def
	}
	if sink == "" {
		lines := splitLines(cmdOutput("pactl", "list", "sinks", "short"))
		if len(lines) > 0 {
			parts := strings.Split(lines[0], "\t")
			if len(parts) > 1 {
				sink = parts[1]
			} else if len(parts) == 1 {
				sink = parts[0]
			}
		}
	}

	// 5. Check for a webcam.
	var videoDevice *string
	if exists("/dev/video0") {
		videoDevice = strPtr("/dev/video0")
	}

	if source == "" {
		source = "alsa_input.pci-0000_00_1f.3.analog-stereo"
	}
	if sink == "" {
		sink = "alsa_output.pci-0000_00_1f.3.analog-stereo"
	}

	c := &config.Config{
		AppDir:               root,
		Electron:             electron,
		Runtime:              runtime,
		Source:               source,
		Sink:                 sink,
		NoSandbox:            boolPtr(true),
		ExperimentalVideo:    boolPtr(videoDevice != nil),
		VideoDevice:          videoDevice,
		ExperimentalIncoming: boolPtr(true),
		Log:                  boolPtr(true),
	}

	target := filepath.Join(root, "launch.json")
	body, err := c.MarshalIndent()
	if err != nil {
		return err
	}
	if err := os.WriteFile(target, append(body, '\n'), 0o600); err != nil {
		return err
	}

	hostname, _ := os.Hostname()
	username := ""
	if u, uerr := user.Current(); uerr == nil {
		username = u.Username
	}
	fmt.Printf("PASS auto-configured launch.json for host %s (%s)\n", hostname, username)
	fmt.Printf("  Electron:   %s\n", electron)
	fmt.Printf("  Runtime:    %s\n", runtime)
	fmt.Printf("  Microphone: %s\n", c.Source)
	fmt.Printf("  Speaker:    %s\n", c.Sink)
	if videoDevice != nil {
		fmt.Printf("  Webcam:     %s\n", *videoDevice)
	}
	return nil
}

func downloadElectron(electronDir string) bool {
	const url = "https://github.com/electron/electron/releases/download/v22.3.27/electron-v22.3.27-linux-x64.zip"
	const zip = "/tmp/electron-v22.3.27.zip"
	curl := exec.Command("curl", "-L", "-o", zip, url)
	curl.Stdout, curl.Stderr = os.Stdout, os.Stderr
	if err := curl.Run(); err != nil {
		fmt.Println("Failed to download Electron automatically:", err)
		return false
	}
	unzip := exec.Command("unzip", "-q", "-o", zip, "-d", electronDir)
	unzip.Stdout, unzip.Stderr = os.Stdout, os.Stderr
	if err := unzip.Run(); err != nil {
		fmt.Println("Failed to download Electron automatically:", err)
		return false
	}
	_ = os.Chmod(filepath.Join(electronDir, "electron"), 0o755)
	_ = os.Remove(zip)
	return true
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func cmdOutput(name string, args ...string) string {
	out, err := exec.Command(name, args...).Output()
	if err != nil {
		return ""
	}
	return string(out)
}

func splitLines(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
