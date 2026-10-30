package debugreport

import (
	"encoding/binary"
	"errors"
	"math"
)

// Minimal CBOR (RFC 8949) decoder for the zlog payload, which the Zalo client
// encodes with cborg. Only definite-length items are produced by that encoder.

var errCBOR = errors.New("invalid cbor")

// cborDecode decodes one item from b and returns it with the bytes consumed.
// Maps decode to map[string]any (non-string keys are skipped), arrays to []any.
func cborDecode(b []byte) (any, int, error) {
	return cborItem(b, 0, 0)
}

func cborItem(b []byte, off, depth int) (any, int, error) {
	if depth > 16 || off >= len(b) {
		return nil, 0, errCBOR
	}
	major, info := b[off]>>5, b[off]&0x1f
	off++

	if major == 7 {
		switch info {
		case 20:
			return false, off, nil
		case 21:
			return true, off, nil
		case 22, 23:
			return nil, off, nil
		case 25:
			if off+2 > len(b) {
				return nil, 0, errCBOR
			}
			return halfToFloat(binary.BigEndian.Uint16(b[off:])), off + 2, nil
		case 26:
			if off+4 > len(b) {
				return nil, 0, errCBOR
			}
			return float64(math.Float32frombits(binary.BigEndian.Uint32(b[off:]))), off + 4, nil
		case 27:
			if off+8 > len(b) {
				return nil, 0, errCBOR
			}
			return math.Float64frombits(binary.BigEndian.Uint64(b[off:])), off + 8, nil
		}
		return nil, 0, errCBOR
	}

	var n uint64
	switch {
	case info < 24:
		n = uint64(info)
	case info <= 27:
		size := 1 << (info - 24)
		if off+size > len(b) {
			return nil, 0, errCBOR
		}
		for i := 0; i < size; i++ {
			n = n<<8 | uint64(b[off+i])
		}
		off += size
	default:
		return nil, 0, errCBOR // indefinite lengths are never emitted by cborg
	}

	switch major {
	case 0:
		return float64(n), off, nil
	case 1:
		return -1 - float64(n), off, nil
	case 2, 3:
		if n > uint64(len(b)-off) {
			return nil, 0, errCBOR
		}
		s := string(b[off : off+int(n)])
		return s, off + int(n), nil
	case 4:
		if n > uint64(len(b)) {
			return nil, 0, errCBOR
		}
		arr := make([]any, 0, n)
		for i := uint64(0); i < n; i++ {
			v, next, err := cborItem(b, off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			arr, off = append(arr, v), next
		}
		return arr, off, nil
	case 5:
		if n > uint64(len(b)) {
			return nil, 0, errCBOR
		}
		m := make(map[string]any, n)
		for i := uint64(0); i < n; i++ {
			k, next, err := cborItem(b, off, depth+1)
			if err != nil {
				return nil, 0, err
			}
			v, next, err := cborItem(b, next, depth+1)
			if err != nil {
				return nil, 0, err
			}
			if ks, ok := k.(string); ok {
				m[ks] = v
			}
			off = next
		}
		return m, off, nil
	case 6: // tag: decode and return the tagged item
		return cborItem(b, off, depth+1)
	}
	return nil, 0, errCBOR
}

func halfToFloat(h uint16) float64 {
	sign := 1.0
	if h&0x8000 != 0 {
		sign = -1
	}
	exp, frac := int(h>>10&0x1f), float64(h&0x3ff)
	switch exp {
	case 0:
		return sign * math.Ldexp(frac, -24)
	case 31:
		if frac == 0 {
			return sign * math.Inf(1)
		}
		return math.NaN()
	}
	return sign * math.Ldexp(frac+1024, exp-25)
}
