// Package zadark ports scripts/zadark.mjs: it applies or removes the ZaDark dark
// theme on an application directory by editing HTML entry points, bootstrap.js
// and the renderer bundles. ZaDark is MPL-2.0.
//
// Privacy: the Content-Security-Policy is deliberately NOT widened for
// api.zadark.com or Google Fonts, so ZaDark's translate feature and remote fonts
// stay blocked and nothing leaves the machine through it.
package zadark

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Version is the bundled ZaDark release.
const Version = "26.2.1"

var bodyClasses = []string{"zadark", "zadark-pc", "zadark-linux"}

// A leading "./" keeps the same files but does not match Zalo's startup filter,
// which strips <link>/<script> tags whose path starts with "zadark".
func link(name string) string {
	return `<link rel="stylesheet" href="./zadark/css/` + name + `.min.css">`
}
func scriptTag(file string) string {
	return `<script src="./zadark/` + file + `.min.js"></script>`
}

var libs = func() []string {
	names := []string{"jquery", "popper", "tippy", "hotkeys-js", "toastify", "webfont", "introjs", "localforage"}
	out := make([]string, 0, len(names))
	for _, n := range names {
		out = append(out, scriptTag("libs/zadark-"+n))
	}
	return out
}()

const settingsTag = `<script src="./linux-extras/zadark-settings.js"></script>`
const themeLock = `<script src="./linux-extras/theme-lock.js"></script>`

type page struct {
	rel  string
	head []string
	body []string
	html bool
}

var pages = []page{
	{
		rel:  "pc-dist/index.html",
		head: []string{link("zadark-fonts"), link("zadark"), link("zadark-popup")},
		body: append(append(append([]string{}, libs...),
			scriptTag("js/zadark-shared"), scriptTag("js/zadark-translate"), scriptTag("js/zadark-zconv"), scriptTag("js/zadark-reaction"), scriptTag("js/zadark")),
			settingsTag),
		html: true,
	},
	{
		rel:  "pc-dist/znotification.html",
		head: []string{link("zadark-znotification")},
		body: []string{scriptTag("libs/zadark-webfont"), scriptTag("js/zadark-znotification")},
	},
	{
		rel:  "pc-dist/popup-viewer.html",
		head: []string{},
		body: []string{scriptTag("js/zadark-popup-viewer")},
	},
}

var themeLockPages = map[string]bool{"pc-dist/index.html": true, "pc-dist/znotification.html": true}

const lightSrc = "updateThemeSetting(e) {"
const lightPatched = "updateThemeSetting(e) { e = 0; /* light-only */"
const mainLine = "require('./pc-dist/zadark/js/zadark-main.min');"
const mainAnchor = "return require('./main-dist/main');"

var (
	zadarkTagRe = regexp.MustCompile(`\n?[ \t]*<(?:link rel="stylesheet" href|script src)="(?:\./)?zadark/[^"]*"(?:></script>|>)`)
	dataAttrRe  = regexp.MustCompile(` data-zadark-(?:version|os)="[^"]*"`)
	bodyOpenRe  = regexp.MustCompile(`<body\b[^>]*>`)
	bodyAttrsRe = regexp.MustCompile(`<body\b([^>]*)>`)
	classRe     = regexp.MustCompile(` class="([^"]*)"`)
	cspRe       = regexp.MustCompile(`<meta http-equiv="Content-Security-Policy"[^>]*>`)
	htmlOpenRe  = regexp.MustCompile(`<html\b`)
	wsRe        = regexp.MustCompile(`\s+`)
)

func strip(html string) string {
	out := strings.ReplaceAll(html, themeLock, "")
	out = strings.ReplaceAll(out, settingsTag, "")
	out = zadarkTagRe.ReplaceAllString(out, "")
	out = dataAttrRe.ReplaceAllString(out, "")
	// Only the first <body ...> tag, matching JS String.replace with a non-global regex.
	if loc := bodyOpenRe.FindStringIndex(out); loc != nil {
		body := out[loc[0]:loc[1]]
		stripped := stripBodyClasses(body)
		out = out[:loc[0]] + stripped + out[loc[1]:]
	}
	return out
}

func stripBodyClasses(body string) string {
	loc := classRe.FindStringSubmatchIndex(body)
	if loc == nil {
		return body
	}
	classes := body[loc[2]:loc[3]]
	var rest []string
	for _, x := range wsRe.Split(classes, -1) {
		if x != "" && !contains(bodyClasses, x) {
			rest = append(rest, x)
		}
	}
	replacement := ""
	if len(rest) > 0 {
		replacement = ` class="` + strings.Join(rest, " ") + `"`
	}
	return body[:loc[0]] + replacement + body[loc[1]:]
}

func withBodyClasses(html string) string {
	loc := bodyAttrsRe.FindStringSubmatchIndex(html)
	if loc == nil {
		return html
	}
	attrs := html[loc[2]:loc[3]]
	var replacement string
	if strings.Contains(attrs, ` class="`) {
		newAttrs := classRe.ReplaceAllStringFunc(attrs, func(m string) string {
			sub := classRe.FindStringSubmatch(m)
			var existing []string
			for _, x := range wsRe.Split(sub[1], -1) {
				if x != "" {
					existing = append(existing, x)
				}
			}
			existing = append(existing, bodyClasses...)
			return ` class="` + strings.Join(existing, " ") + `"`
		})
		replacement = "<body" + newAttrs + ">"
	} else {
		replacement = `<body class="` + strings.Join(bodyClasses, " ") + `"` + attrs + ">"
	}
	return html[:loc[0]] + replacement + html[loc[1]:]
}

func patchPage(html string, p page, themeLockEnabled bool) (string, error) {
	out := strip(html)
	if themeLockEnabled {
		if meta := cspRe.FindString(out); meta != "" {
			out = strings.Replace(out, meta, meta+themeLock, 1)
		} else if strings.Contains(out, "<head>") {
			out = strings.Replace(out, "<head>", "<head>"+themeLock, 1)
		} else {
			return "", errors.New("Missing <head>")
		}
	}
	if len(p.head) > 0 {
		if !strings.Contains(out, "</head>") {
			return "", errors.New("Missing </head>")
		}
		out = strings.Replace(out, "</head>", strings.Join(p.head, "")+"</head>", 1)
	}
	if !strings.Contains(out, "</body>") {
		return "", errors.New("Missing </body>")
	}
	out = replaceLast(out, "</body>", strings.Join(p.body, "")+"</body>")
	if p.html {
		if !htmlOpenRe.MatchString(out) {
			return "", errors.New("Missing <html>")
		}
		loc := htmlOpenRe.FindStringIndex(out)
		out = out[:loc[0]] + `<html data-zadark-version="` + Version + `" data-zadark-os="Linux"` + out[loc[1]:]
	}
	return withBodyClasses(out), nil
}

func patchBootstrap(text string) (string, error) {
	if strings.Contains(text, mainLine) {
		return text, nil
	}
	if !strings.Contains(text, mainAnchor) {
		return "", errors.New("bootstrap.js entry point not found")
	}
	return strings.Replace(text, mainAnchor, mainLine+"\n    "+mainAnchor, 1), nil
}

func unpatchBootstrap(text string) (string, error) {
	return strings.Replace(text, mainLine+"\n    ", "", 1), nil
}

func lockLight(text string) (string, error) {
	return strings.ReplaceAll(strings.ReplaceAll(text, lightPatched, lightSrc), lightSrc, lightPatched), nil
}
func unlockLight(text string) (string, error) {
	return strings.ReplaceAll(text, lightPatched, lightSrc), nil
}

func bundleFiles(root string) []string {
	var out []string
	for _, dir := range []string{"pc-dist", "pc-dist/lazy"} {
		entries, err := os.ReadDir(filepath.Join(root, dir))
		if err != nil {
			continue
		}
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".js") {
				out = append(out, filepath.Join(root, dir, e.Name()))
			}
		}
	}
	return out
}

func editBundles(root string, fn func(string) (string, error)) ([]string, error) {
	var changed []string
	for _, file := range bundleFiles(root) {
		before, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		if !strings.Contains(string(before), lightSrc) {
			continue
		}
		after, err := fn(string(before))
		if err != nil {
			return nil, err
		}
		if after != string(before) {
			if err := os.WriteFile(file, []byte(after), 0o644); err != nil {
				return nil, err
			}
			rel, _ := filepath.Rel(root, file)
			changed = append(changed, rel)
		}
	}
	return changed, nil
}

// edit reads file, applies fn, writes if changed, and reports whether it changed.
func edit(file string, fn func(string) (string, error)) (bool, error) {
	before, err := os.ReadFile(file)
	if err != nil {
		return false, err
	}
	after, err := fn(string(before))
	if err != nil {
		return false, err
	}
	if after != string(before) {
		if err := os.WriteFile(file, []byte(after), 0o644); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

// Apply ports applyZaDark(): returns the list of changed relative paths.
func Apply(root string) ([]string, error) {
	var changed []string
	for _, p := range pages {
		pp := p
		did, err := edit(filepath.Join(root, pp.rel), func(html string) (string, error) {
			return patchPage(html, pp, themeLockPages[pp.rel])
		})
		if err != nil {
			return nil, err
		}
		if did {
			changed = append(changed, pp.rel)
		}
	}
	did, err := edit(filepath.Join(root, "bootstrap.js"), patchBootstrap)
	if err != nil {
		return nil, err
	}
	if did {
		changed = append(changed, "bootstrap.js")
	}
	more, err := editBundles(root, lockLight)
	if err != nil {
		return nil, err
	}
	return append(changed, more...), nil
}

// Remove ports removeZaDark().
func Remove(root string) ([]string, error) {
	var changed []string
	for _, p := range pages {
		did, err := edit(filepath.Join(root, p.rel), strip2)
		if err != nil {
			return nil, err
		}
		if did {
			changed = append(changed, p.rel)
		}
	}
	did, err := edit(filepath.Join(root, "bootstrap.js"), unpatchBootstrap)
	if err != nil {
		return nil, err
	}
	if did {
		changed = append(changed, "bootstrap.js")
	}
	more, err := editBundles(root, unlockLight)
	if err != nil {
		return nil, err
	}
	return append(changed, more...), nil
}

// strip2 adapts strip to the edit() signature.
func strip2(html string) (string, error) { return strip(html), nil }

// Run ports the zadark.mjs CLI.
func Run(binDir string, args []string) error {
	if len(args) < 1 {
		return errors.New("Usage: zalo zadark apply|remove [appDir]")
	}
	action := args[0]
	root := binDir
	if len(args) > 1 && args[1] != "" {
		root, _ = filepath.Abs(args[1])
	}
	var changed []string
	var err error
	switch action {
	case "apply":
		changed, err = Apply(root)
	case "remove":
		changed, err = Remove(root)
	default:
		return errors.New("Usage: zalo zadark apply|remove [appDir]")
	}
	if err != nil {
		return err
	}
	verb := "Removed"
	if action == "apply" {
		verb = "Applied"
	}
	list := "no change"
	if len(changed) > 0 {
		list = strings.Join(changed, ", ")
	}
	fmt.Printf("%s ZaDark %s: %s\n", verb, Version, list)
	return nil
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

// replaceLast replaces the last occurrence of old in s with repl.
func replaceLast(s, old, repl string) string {
	i := strings.LastIndex(s, old)
	if i < 0 {
		return s
	}
	return s[:i] + repl + s[i+len(old):]
}
