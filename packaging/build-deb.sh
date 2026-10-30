#!/usr/bin/env bash
#
# build-deb.sh — Đóng gói Zalo for Linux thành 1 file .deb.
#
# Dùng:
#   packaging/build-deb.sh <version> [arch]
#   ví dụ: packaging/build-deb.sh 1.2.0
#
# Kết quả: dist/zalo-on-linux_<version>_<arch>.deb
#
# Thiết kế cài đặt của .deb:
#   /opt/zalo-on-linux/            toàn bộ payload (app JS + binary Go `zalo` + runtime)
#   /usr/bin/zalo-on-linux         launcher (sinh launch.json theo từng user, mở Electron)
#   /usr/share/applications/...    menu entry
#   /usr/share/icons/.../zalo.png  icon
# Vì /opt chỉ-đọc với user thường, launcher sinh launch.json vào
# ~/.config/zalo-on-linux/ rồi trỏ appDir/runtime về /opt/zalo-on-linux.
#
set -euo pipefail

VERSION="${1:?Thiếu version. Dùng: build-deb.sh <version> [arch]}"
ARCH="${2:-amd64}"
PKG="zalo-on-linux"

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT_DIR="$REPO/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="$STAGE/${PKG}_${VERSION}_${ARCH}"
OPT="$DEST/opt/$PKG"

echo "==> Đóng gói $PKG $VERSION ($ARCH)"
echo "    repo:  $REPO"
echo "    stage: $DEST"

# ---- 1. Copy payload vào /opt/zalo-on-linux ----------------------------------
mkdir -p "$OPT"
rsync -a \
  --exclude='.git' --exclude='.github' --exclude='packaging' \
  --exclude='.codegraph' --exclude='openwiki' --exclude='node_modules' \
  --exclude='dist' --exclude='launch.json' --exclude='run-zalo.sh' \
  --exclude='*.deb' --exclude='*.log' \
  "$REPO"/ "$OPT"/

# ---- 2. Build binary Go `zalo` (ghi đè bản prebuilt nếu có) -------------------
echo "==> go build zalo"
( cd "$OPT" && go build -trimpath -o zalo ./cmd/zalo )
chmod 0755 "$OPT/zalo"

# ---- 3. Launcher hệ thống /usr/bin/zalo-on-linux -----------------------------
mkdir -p "$DEST/usr/bin"
cat > "$DEST/usr/bin/$PKG" <<'LAUNCH'
#!/usr/bin/env bash
# Launcher của gói zalo-on-linux (.deb). Payload nằm ở /opt (chỉ-đọc), nên cấu
# hình theo từng user được sinh vào ~/.config/zalo-on-linux/launch.json.
set -euo pipefail
APP_DIR=/opt/zalo-on-linux
CONF_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/zalo-on-linux"
mkdir -p "$CONF_DIR"

# Linux: hộp thoại chọn/lưu file nổi lên trên cửa sổ (qua xdg-desktop-portal).
export GTK_USE_PORTAL=1

if [[ ! -f "$CONF_DIR/launch.json" ]]; then
    # autoconfig tự tải Electron (nếu thiếu) + dò mic/loa/webcam, ghi launch.json
    # với appDir/runtime trỏ vào CONF_DIR; sửa lại để trỏ về payload ở /opt.
    "$APP_DIR/zalo" autoconfig "$CONF_DIR"
    sed -i \
        -e "s#\"appDir\": \"[^\"]*#\"appDir\": \"$APP_DIR#" \
        -e "s#\"runtime\": \"[^\"]*#\"runtime\": \"$APP_DIR/runtime#" \
        "$CONF_DIR/launch.json"
fi

exec "$APP_DIR/zalo" launch "$CONF_DIR/launch.json" "$@"
LAUNCH
chmod 0755 "$DEST/usr/bin/$PKG"

# ---- 4. Menu entry -----------------------------------------------------------
mkdir -p "$DEST/usr/share/applications"
cat > "$DEST/usr/share/applications/$PKG.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Zalo
GenericName=Messenger
Comment=Zalo for Linux - Nhắn gửi yêu thương
Exec=/usr/bin/$PKG %U
Icon=zalo
Terminal=false
Categories=Network;InstantMessaging;Chat;
Keywords=zalo;chat;message;call;vng;
StartupNotify=true
StartupWMClass=Zalo
EOF

# ---- 5. Icon -----------------------------------------------------------------
mkdir -p "$DEST/usr/share/icons/hicolor/256x256/apps"
cp -f "$REPO/pc-dist/zalo.png" "$DEST/usr/share/icons/hicolor/256x256/apps/zalo.png"

# ---- 6. Metadata gói (DEBIAN/control + maintainer scripts) -------------------
mkdir -p "$DEST/DEBIAN"
INSTALLED_KB="$(du -sk "$DEST/opt" "$DEST/usr" | awk '{s+=$1} END{print s}')"
cat > "$DEST/DEBIAN/control" <<EOF
Package: $PKG
Version: $VERSION
Architecture: $ARCH
Maintainer: sonnam0904 <sonnguyennam@bizfly.vn>
Installed-Size: $INSTALLED_KB
Section: net
Priority: optional
Homepage: https://github.com/sonnam0904/zalo-on-linux
Depends: curl, unzip
Recommends: libgtk-3-0 | libgtk-3-0t64, libnss3, libgbm1, libasound2 | libasound2t64, libnotify4, libxtst6, libxss1, xdg-utils, xdg-desktop-portal-gtk, pulseaudio-utils | pipewire-pulse
Description: Zalo for Linux (Electron, native voice/video toolkit)
 Zalo desktop chạy trên Linux qua Electron, kèm bộ công cụ Go lo khởi chạy,
 dò phần cứng, cập nhật. Electron 22.3.27 được tải tự động ở lần chạy đầu.
 Cấu hình (mic/loa/webcam) được dò riêng cho từng máy.
EOF

# postinst/postrm: cập nhật cache menu + icon
cat > "$DEST/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi
exit 0
EOF
cat > "$DEST/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
exit 0
EOF
chmod 0755 "$DEST/DEBIAN/postinst" "$DEST/DEBIAN/postrm"

# ---- 7. Build .deb -----------------------------------------------------------
mkdir -p "$OUT_DIR"
DEB="$OUT_DIR/${PKG}_${VERSION}_${ARCH}.deb"
dpkg-deb --build --root-owner-group "$DEST" "$DEB"

echo "==> Xong: $DEB"
dpkg-deb --info "$DEB" | sed 's/^/    /'
