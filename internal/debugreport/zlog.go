package debugreport

import (
	"encoding/binary"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The Zalo client writes its own logs to <userData>/cal/<process>.zlog as a
// binary ring buffer. Each record is laid out as
//
//	separator(2) size(2) tick(8, big-endian ms) encoder(1)=62 level(1)
//	len(1) zlogVersion(len) payload(CBOR map)
//
// with payload {$1: line, $2: lz(tags), $3: [lzBase64(arg)...], $4: template}.
// The ring wraps, so records are located by their fixed header rather than by
// walking from the start of the file, then ordered by tick.

const zlogEncoderVersion = 62

var zlogLevels = []string{"INFO", "ERROR", "WARN", "DEBUG", "CRITICAL"}

// ZlogEntry is one decoded log record.
type ZlogEntry struct {
	Time    time.Time
	Level   string
	Tags    string
	Message string
}

// IsError reports whether the entry is at error level or above.
func (e ZlogEntry) IsError() bool { return e.Level == "ERROR" || e.Level == "CRITICAL" }

func (e ZlogEntry) String() string {
	tags := ""
	if e.Tags != "" {
		tags = " [" + e.Tags + "]"
	}
	return fmt.Sprintf("%s %-5s%s %s", e.Time.Format("2006-01-02 15:04:05.000"), e.Level, tags, e.Message)
}

var (
	minTick = time.Date(2015, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
	maxTick = time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).UnixMilli()
)

// ParseZlog decodes every record it can find in a .zlog file, oldest first.
func ParseZlog(data []byte) []ZlogEntry {
	var out []ZlogEntry
	for p := 8; p+3 < len(data); p++ {
		if data[p] != zlogEncoderVersion || data[p+1] >= byte(len(zlogLevels)) {
			continue
		}
		vlen := int(data[p+2])
		start := p + 3 + vlen
		if vlen == 0 || vlen > 32 || start >= len(data) || !isAlnum(data[p+3:start]) {
			continue
		}
		tick := int64(binary.BigEndian.Uint64(data[p-8 : p]))
		if tick < minTick || tick > maxTick {
			continue
		}
		v, n, err := cborDecode(data[start:])
		payload, ok := v.(map[string]any)
		if err != nil || !ok {
			continue
		}
		out = append(out, ZlogEntry{
			Time:    time.UnixMilli(tick),
			Level:   zlogLevels[data[p+1]],
			Tags:    decodeTags(payload["$2"]),
			Message: formatMessage(payload["$4"], payload["$3"]),
		})
		p = start + n - 1
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time.Before(out[j].Time) })
	return out
}

func isAlnum(b []byte) bool {
	for _, c := range b {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z') {
			return false
		}
	}
	return true
}

func decodeTags(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	if d, ok := LZDecompress(s); ok {
		return d
	}
	return s
}

// formatMessage mirrors the client's text formatter: each "{}" in the
// template takes the next argument and leftovers are appended.
func formatMessage(template, args any) string {
	var parts []string
	if list, ok := args.([]any); ok {
		for _, a := range list {
			parts = append(parts, formatArg(a))
		}
	}
	t, _ := template.(string)
	if t == "" {
		return strings.Join(parts, " ")
	}
	var rest []string
	for _, p := range parts {
		if strings.Contains(t, "{}") {
			t = strings.Replace(t, "{}", p, 1)
		} else {
			rest = append(rest, p)
		}
	}
	return strings.TrimSpace(t + " " + strings.Join(rest, " "))
}

func formatArg(a any) string {
	switch v := a.(type) {
	case string:
		if d, ok := LZDecompressFromBase64(v); ok {
			return d
		}
		return v
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64)
	case nil:
		return "null"
	default:
		return fmt.Sprint(v)
	}
}
