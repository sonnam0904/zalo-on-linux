#!/usr/bin/env bash
#
# install.sh — Cài Zalo (Linux) chỉ bằng một lệnh.
#
# Giữ nguyên hướng hiện tại: client Zalo (JS) vẫn chạy dưới Electron, binary Go
# `zalo` lo việc khởi chạy / dò phần cứng / cập nhật. Script này chỉ gói các bước
# thủ công (go build → autoconfig → tạo .desktop) lại thành một bước duy nhất và
# đưa Zalo vào menu ứng dụng để click là mở, không phải gõ lệnh nữa.
#
# Cách dùng:
#   ./install.sh                 Cài / cài lại (build + cấu hình nếu cần + menu)
#   ./install.sh --reconfigure   Dò lại mic/loa/webcam, ghi lại launch.json
#   ./install.sh --no-build      Dùng binary ./zalo có sẵn, không build lại
#   ./install.sh --uninstall     Gỡ menu entry + icon (không xoá thư mục app)
#   ./install.sh --help
#
set -euo pipefail

# ---- Vị trí thư mục app (thư mục chứa chính script này, đã giải symlink) -------
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# ---- Đường dẫn đích theo chuẩn XDG (cài cho người dùng, không cần root) --------
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
APPLICATIONS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/256x256/apps"
DESKTOP_FILE="$APPLICATIONS_DIR/zalo.desktop"
ICON_FILE="$ICON_DIR/zalo.png"
LAUNCHER="$APP_DIR/run-zalo.sh"
BIN="$APP_DIR/zalo"

# ---- In ấn ---------------------------------------------------------------------
c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
step() { printf '%s==>%s %s\n' "$c_ok" "$c_off" "$*"; }
info() { printf '    %s%s%s\n' "$c_dim" "$*" "$c_off"; }
warn() { printf '%s[!]%s %s\n' "$c_warn" "$c_off" "$*" >&2; }
die()  { printf '%s[x]%s %s\n' "$c_err" "$c_off" "$*" >&2; exit 1; }

RECONFIGURE=0
DO_BUILD=1
ACTION=install
for arg in "$@"; do
    case "$arg" in
        --reconfigure) RECONFIGURE=1 ;;
        --no-build)    DO_BUILD=0 ;;
        --uninstall)   ACTION=uninstall ;;
        -h|--help)
            sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) die "Tham số không hợp lệ: $arg (xem --help)" ;;
    esac
done

# ------------------------------------------------------------------ gỡ cài đặt --
if [[ "$ACTION" == uninstall ]]; then
    step "Gỡ Zalo khỏi menu ứng dụng"
    rm -f "$DESKTOP_FILE" "$ICON_FILE" "$LAUNCHER"
    command -v update-desktop-database >/dev/null 2>&1 && \
        update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
    info "Đã xoá menu entry + icon + launcher."
    info "Thư mục app ($APP_DIR) và launch.json được giữ nguyên — xoá tay nếu muốn."
    exit 0
fi

step "Cài Zalo từ: $APP_DIR"

# ---- Kiểm tra payload tối thiểu (đúng thư mục chưa) ---------------------------
[[ -f "$APP_DIR/bootstrap.js" && -d "$APP_DIR/main-dist" && -d "$APP_DIR/pc-dist" ]] \
    || die "Không thấy payload Zalo (bootstrap.js / main-dist / pc-dist) trong $APP_DIR."

# ---- Công cụ cần thiết --------------------------------------------------------
MISSING=()
command -v curl  >/dev/null 2>&1 || MISSING+=("curl")
command -v unzip >/dev/null 2>&1 || MISSING+=("unzip")
if ((${#MISSING[@]})); then
    warn "Thiếu công cụ để tự tải Electron nếu chưa có: ${MISSING[*]}"
    warn "Cài chúng (vd: sudo apt install ${MISSING[*]}) hoặc đặt sẵn Electron 22.3.27."
fi
command -v pactl >/dev/null 2>&1 || warn "Không thấy 'pactl' — sẽ dùng mic/loa mặc định dự phòng."

# ---- 1. Binary zalo ----------------------------------------------------------
if ((DO_BUILD)); then
    if command -v go >/dev/null 2>&1; then
        step "Build binary 'zalo' (Go $(go version | awk '{print $3}' | sed 's/^go//'))"
        ( cd "$APP_DIR" && go build -o "$BIN" ./cmd/zalo ) || die "go build thất bại."
        info "Đã build: $BIN"
    elif [[ -x "$BIN" ]]; then
        warn "Không có Go — dùng binary có sẵn: $BIN"
    else
        die "Cần Go để build (https://go.dev/dl/) hoặc một binary ./zalo có sẵn. Hoặc chạy lại với --no-build khi đã có ./zalo."
    fi
else
    [[ -x "$BIN" ]] || die "--no-build nhưng không thấy binary thực thi: $BIN"
    info "Bỏ qua build, dùng: $BIN"
fi

# ---- 2. launch.json (Electron + mic/loa/webcam) -------------------------------
if [[ ! -f "$APP_DIR/launch.json" || "$RECONFIGURE" == 1 ]]; then
    step "Dò phần cứng + Electron 22.3.27 → launch.json"
    info "Nếu thiếu Electron, bước này sẽ tự tải (~80MB) về ~/.local/electron-v22.3.27."
    ( cd "$APP_DIR" && "$BIN" autoconfig "$APP_DIR" ) || die "autoconfig thất bại."
else
    info "launch.json đã có — giữ nguyên (dùng --reconfigure để dò lại)."
fi
[[ -f "$APP_DIR/launch.json" ]] || die "Thiếu launch.json sau autoconfig."

# ---- 3. Launcher wrapper (tự định vị, tự dò lại nếu thiếu launch.json) --------
step "Tạo launcher: $LAUNCHER"
cat > "$LAUNCHER" <<'WRAP'
#!/usr/bin/env bash
# Được install.sh sinh ra. Mở Zalo (Electron) từ menu ứng dụng.
set -euo pipefail
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$APP_DIR"
# Linux: ép hộp thoại chọn/lưu file của Chromium đi qua xdg-desktop-portal, để nó
# nổi lên trên cửa sổ Zalo thay vì bị đẩy ra sau (hộp thoại GTK trực tiếp hay lỗi này).
export GTK_USE_PORTAL=1
if [[ ! -f "$APP_DIR/launch.json" ]]; then
    "$APP_DIR/zalo" autoconfig "$APP_DIR"
fi
exec "$APP_DIR/zalo" launch "$APP_DIR/launch.json" "$@"
WRAP
chmod 0755 "$LAUNCHER"

# ---- 4. Icon -----------------------------------------------------------------
step "Cài icon"
mkdir -p "$ICON_DIR"
if [[ -f "$APP_DIR/pc-dist/zalo.png" ]]; then
    cp -f "$APP_DIR/pc-dist/zalo.png" "$ICON_FILE"
    ICON_NAME=zalo
else
    warn "Không thấy pc-dist/zalo.png — dùng tên icon chung 'zalo'."
    ICON_NAME=zalo
fi

# ---- 5. Menu entry (.desktop) ------------------------------------------------
step "Đăng ký menu entry: $DESKTOP_FILE"
mkdir -p "$APPLICATIONS_DIR"
# Exec: bọc nháy kép quanh đường dẫn launcher (chuẩn .desktop cho path có dấu cách)
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Zalo
GenericName=Messenger
Comment=Zalo for Linux - Nhắn gửi yêu thương
Exec="$LAUNCHER" %U
Icon=$ICON_NAME
Terminal=false
Categories=Network;InstantMessaging;Chat;
Keywords=zalo;chat;message;call;vng;
StartupNotify=true
StartupWMClass=Zalo
EOF
chmod 0644 "$DESKTOP_FILE"

if command -v desktop-file-validate >/dev/null 2>&1; then
    desktop-file-validate "$DESKTOP_FILE" 2>&1 | sed 's/^/    /' || \
        warn "desktop-file-validate báo cảnh báo (thường không ảnh hưởng)."
fi
command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$APPLICATIONS_DIR" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -q -t -f "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

# ---- Xong --------------------------------------------------------------------
printf '\n%s✓ Cài đặt xong.%s\n' "$c_ok" "$c_off"
cat <<EOF

  • Mở Zalo: tìm "Zalo" trong menu ứng dụng rồi click.
  • Hoặc chạy trực tiếp: $LAUNCHER
  • Dò lại mic/loa:      ./install.sh --reconfigure
  • Gỡ khỏi menu:        ./install.sh --uninstall

  ${c_dim}App chạy tại chỗ trong $APP_DIR (không copy payload).
  Nếu di chuyển thư mục này, chạy lại ./install.sh.${c_off}
EOF
