# Zalo cho Linux

Cài **Zalo** lên máy Linux và dùng như một ứng dụng bình thường: có icon trong
menu, nhắn tin, gọi thoại/video, giao diện tối (ZaDark), dịch tin nhắn không giới hạn.

> 💡 Chỉ cần **dán 1 dòng lệnh**. Không cần biết lập trình.

---

## ✅ Máy của bạn cần gì

- Linux 64-bit (Ubuntu, Linux Mint, Fedora, Pop!_OS… đều được).
- **git** để tải về. Nếu chưa có, cài trước:
  - Ubuntu / Mint / Debian: `sudo apt install git`
  - Fedora: `sudo dnf install git`
- Kết nối Internet + khoảng **1 GB trống**.

Không cần cài thêm gì khác (Electron sẽ được tải tự động khi cài).

---

## 📥 Cài đặt — chỉ **1 dòng**

Mở **Terminal**, dán dòng dưới đây rồi bấm **Enter**:

```sh
git clone https://github.com/sonnam0904/zalo-on-linux.git && cd zalo-on-linux && ./install.sh
```

- Lần đầu tải khá nặng (vài trăm MB) → hãy chờ một chút.
- Khi thấy dòng **“✓ Cài đặt xong.”** là hoàn tất.
- Nếu báo lỗi không chạy được `install.sh`, dán tiếp dòng này:
  ```sh
  cd zalo-on-linux && chmod +x install.sh && ./install.sh
  ```

👉 Sau đó mở **“Zalo”** trong menu ứng dụng là dùng được. Từ giờ không cần Terminal nữa. 🎉

---

## ▶️ Mở Zalo

Tìm **“Zalo”** trong menu ứng dụng của máy (như mọi app khác) rồi bấm vào.

---

## 🔄 Cập nhật lên bản mới

Mở Terminal, dán:

```sh
cd zalo-on-linux && git pull && ./install.sh
```

---

## 🔧 Những việc hay dùng

Mở Terminal trong thư mục `zalo-on-linux` rồi gõ:

| Bạn muốn… | Gõ lệnh |
|---|---|
| **Cập nhật** bản mới | `git pull && ./install.sh` |
| **Mic/loa không nghe thấy** (đổi tai nghe, micro…) | `./install.sh --reconfigure` |
| **Gỡ Zalo** khỏi menu | `./install.sh --uninstall` |

> Gỡ bằng lệnh trên chỉ xoá Zalo khỏi menu, **không xoá tin nhắn**. Muốn xoá hẳn,
> xoá luôn thư mục `zalo-on-linux`.

---

## ❓ Gặp trục trặc?

**Bấm “Zalo” trong menu mà không mở lên?**
Mở Terminal trong thư mục `zalo-on-linux` và gõ `./run-zalo.sh` để xem thông báo
lỗi, rồi gửi cho người hỗ trợ.

**Muốn giao diện tối (Dark Mode)?**
Đã có sẵn **ZaDark** — bấm icon hình mặt trăng ở thanh bên trái trong Zalo để bật/tắt
và tuỳ chỉnh (phông chữ, cỡ chữ, dịch tin nhắn…).

**Micro hoặc loa bị sai thiết bị?**
Chạy `./install.sh --reconfigure` để máy dò lại.

---
