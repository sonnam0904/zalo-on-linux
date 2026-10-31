# Zalo cho Linux

Cài **Zalo** lên máy Linux và dùng như một ứng dụng bình thường: có icon trong  
menu, nhắn tin, gọi thoại/video, giao diện tối (ZaDark), dịch tin nhắn không giới hạn.

---

## ✅ Máy của bạn cần gì

- Linux 64-bit (Ubuntu, Linux Mint, Debian, Fedora, Pop!_OS… đều được).
- Kết nối Internet + khoảng **1 GB trống**.

Electron sẽ được tải tự động ở lần chạy đầu — không cần cài sẵn gì khác.

---

## 📥 Cài đặt

Chọn **1 trong 2 cách**:

### Cách A — Cài bằng file `.deb` (Ubuntu / Mint / Debian — dễ nhất) ⭐

1. Mở trang **[Releases](https://github.com/sonnam0904/zalo-on-linux/releases/latest)**
   rồi tải file `zalo-on-linux_X.Y.Z_amd64.deb`.
2. Cài: **double-click** file vừa tải (mở bằng trình cài phần mềm), **hoặc** mở
   Terminal ngay thư mục chứa file rồi gõ:
   ```sh
   sudo apt install ./zalo-on-linux_*.deb
   ```
3. Mở **“Zalo”** trong menu ứng dụng. 🎉

> Thích làm gọn trong Terminal? Tải + cài **bản mới nhất** bằng 1 dòng:
> ```sh
> cd /tmp && curl -L -o zalo.deb "$(curl -fsSL https://api.github.com/repos/sonnam0904/zalo-on-linux/releases/latest | grep -o 'https://[^"]*_amd64\.deb')" && sudo apt install -y ./zalo.deb
> ```

### Cách B — Cài bằng 1 dòng từ mã nguồn (mọi distro)

Cần **git** trước (`sudo apt install git`, hoặc `sudo dnf install git` trên Fedora).
Mở Terminal, dán:

```sh
git clone https://github.com/sonnam0904/zalo-on-linux.git && cd zalo-on-linux && ./install.sh
```

- Lần đầu tải khá nặng (vài trăm MB) → hãy chờ một chút.
- Khi thấy **“✓ Cài đặt xong.”** là hoàn tất → mở **“Zalo”** trong menu.
- Nếu báo không chạy được `install.sh`:
  `cd zalo-on-linux && chmod +x install.sh && ./install.sh`

---

## ▶️ Mở Zalo

Tìm **“Zalo”** trong menu ứng dụng của máy (như mọi app khác) rồi bấm vào.

---

## 🔄 Cập nhật lên bản mới

| Bạn cài bằng | Cách cập nhật |
|---|---|
| **`.deb` (Cách A)** | Tải `.deb` mới ở [Releases](https://github.com/sonnam0904/zalo-on-linux/releases/latest) rồi cài đè: `sudo apt install ./zalo-on-linux_*.deb` |
| **`./install.sh` (Cách B)** | `cd zalo-on-linux && git pull && ./install.sh` |

---

## 🔧 Những việc hay dùng

| Bạn muốn… | `.deb` (Cách A) | `./install.sh` (Cách B) |
|---|---|---|
| **Gỡ Zalo** | `sudo apt remove zalo-on-linux` | `./install.sh --uninstall` |
| **Mic/loa sai thiết bị** | xoá `~/.config/zalo-on-linux/launch.json` rồi mở lại Zalo | `./install.sh --reconfigure` |

> Gỡ Zalo **không xoá tin nhắn**. Dữ liệu tài khoản nằm ở `~/.config/ZaloData`
> (xoá thư mục này nếu muốn xoá sạch).

---

## ❓ Gặp trục trặc?

**Bấm “Zalo” trong menu mà không mở lên?**
Mở Terminal trong thư mục `zalo-on-linux` và gõ `./run-zalo.sh` để xem thông báo
lỗi, rồi gửi cho người hỗ trợ.

**Zalo bị treo / đăng nhập xong không vào được / lỗi lạ?**
Mở Terminal và gõ lệnh dưới đây (khi đang lỗi hoặc ngay sau khi tắt Zalo):

| Cài bằng | Gõ lệnh |
|---|---|
| file `.deb` | `zalo-on-linux --debug` |
| `./install.sh` | `cd zalo-on-linux && ./run-zalo.sh --debug` |

Lệnh sẽ tạo file `~/zalo-debug-<ngày-giờ>.txt` (gồm thông tin máy, log của Zalo,
các thư viện không chạy được trên máy). Gửi file đó cho người hỗ trợ. File có thể
chứa ID tài khoản Zalo nhưng **không** chứa mật khẩu hay nội dung tin nhắn.

**Muốn giao diện tối (Dark Mode)?**
Đã có sẵn **ZaDark** — bấm icon hình mặt trăng ở thanh bên trái trong Zalo để bật/tắt
và tuỳ chỉnh (phông chữ, cỡ chữ, dịch tin nhắn…).

**Micro hoặc loa bị sai thiết bị?**
Để máy dò lại — xem cột tương ứng ở bảng **“Những việc hay dùng”** phía trên
(cài `.deb`: xoá `~/.config/zalo-on-linux/launch.json` rồi mở lại Zalo; cài
`./install.sh`: chạy `./install.sh --reconfigure`).

---
