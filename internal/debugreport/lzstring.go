package debugreport

import (
	"strings"
	"unicode/utf16"
)

// Port of the decompression half of lz-string 1.x (pieroxy/lz-string), which
// the Zalo client uses to compress log tags and arguments in its .zlog files.

const lzBase64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

// LZDecompressFromBase64 mirrors LZString.decompressFromBase64.
func LZDecompressFromBase64(s string) (string, bool) {
	if s == "" {
		return "", true
	}
	return lzDecompress(len(s), 32, func(i int) int {
		if i >= len(s) {
			return 0
		}
		return strings.IndexByte(lzBase64Alphabet, s[i])
	})
}

// LZDecompress mirrors LZString.decompress (16 bits per UTF-16 code unit).
func LZDecompress(s string) (string, bool) {
	if s == "" {
		return "", true
	}
	units := utf16.Encode([]rune(s))
	return lzDecompress(len(units), 32768, func(i int) int {
		if i >= len(units) {
			return 0
		}
		return int(units[i])
	})
}

func lzDecompress(length, resetValue int, next func(int) int) (string, bool) {
	val, position, index := next(0), resetValue, 1
	if val < 0 {
		return "", false
	}
	readBits := func(n int) (int, bool) {
		bits := 0
		for power := 1; power != 1<<n; power <<= 1 {
			if val&position != 0 {
				bits |= power
			}
			position >>= 1
			if position == 0 {
				position = resetValue
				val = next(index)
				index++
				if val < 0 {
					return 0, false
				}
			}
		}
		return bits, true
	}

	dict := [][]uint16{nil, nil, nil} // codes 0..2 are control codes
	enlargeIn, numBits := 4, 3

	kind, ok := readBits(2)
	if !ok {
		return "", false
	}
	var w []uint16
	switch kind {
	case 0, 1:
		c, ok := readBits(8 << kind)
		if !ok {
			return "", false
		}
		w = []uint16{uint16(c)}
	case 2:
		return "", true
	default:
		return "", false
	}
	dict = append(dict, w)
	result := append([]uint16(nil), w...)

	for {
		if index > length {
			return "", false
		}
		c, ok := readBits(numBits)
		if !ok {
			return "", false
		}
		switch c {
		case 0, 1:
			ch, ok := readBits(8 << c)
			if !ok {
				return "", false
			}
			dict = append(dict, []uint16{uint16(ch)})
			c = len(dict) - 1
			enlargeIn--
		case 2:
			return string(utf16.Decode(result)), true
		}
		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}

		var entry []uint16
		switch {
		case c < len(dict) && dict[c] != nil:
			entry = dict[c]
		case c == len(dict):
			entry = append(append([]uint16(nil), w...), w[0])
		default:
			return "", false
		}
		result = append(result, entry...)
		dict = append(dict, append(append([]uint16(nil), w...), entry[0]))
		enlargeIn--
		w = entry

		if enlargeIn == 0 {
			enlargeIn = 1 << numBits
			numBits++
		}
	}
}
