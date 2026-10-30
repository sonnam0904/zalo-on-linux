# Ghi chú tín hiệu cuộc gọi: Android và PC (Zalo 21.12.01)

Kết quả đọc mã (không gửi gói nào lên máy chủ Zalo). Nguồn: Java đã giải mã từ
APK `zalo-21.12.01-x86.apk` (`pa/l.java`, `vz/s0.java`, `vz/p1.java`,
`com/zing/zalocore/connection/socket/*`) và các bundle `pc-dist/`.

## Hai thế giới tín hiệu khác nhau

| | Android | Zalo PC (bản này) |
| --- | --- | --- |
| Kênh gửi | Socket TCP riêng của `libzalocore` (`NativeSocket.nativeSendRequest`), phiên riêng, đóng gói và mã hóa trong thư viện native | HTTPS REST `https://voicecall-wpa.chat.zalo.me/api/voicecall/<tên>` do renderer gọi, tham số mã hóa AES |
| Khung | `RequestPacket`: version 1, cmd (uint16), tham số nhị phân little-endian (`int32 LE`, chuỗi = `uint16 LE` độ dài + UTF-8) | Renderer `handleSendSignal` (số lệnh) rồi `Api.<hàm>` |
| Chat WebSocket | Không dùng cho gọi | `wss://*.chat.zalo.me`, khung `[version u8][cmd u16][subCmd u8] + JSON`; bảng lệnh chỉ có chat/ctrl (501, 521, 60x…), **không có lệnh gửi voip**; `CTRL_PULL_VOIP`=604 chỉ để nhận |

Số lệnh `call-send-signal` của PC **chính là mã lệnh Android**: 401 (request),
402 (answer), 407 (ringring), 408 (answer ack), 409 (endcall), 411/413 (hold/resume),
416 (request + extendData)… Nhưng bản PC chỉ cài một phần trong số đó.

## Lệnh Android không có tương đương trên PC

Trích từ `pa/l.java` (số lệnh = `RequestPacket.p((short) N)`):

| Lệnh | Hàm Android | Dùng để | Tham số (little-endian) | Trên PC |
| --- | --- | --- | --- | --- |
| 443 | `voiceMuteCall` | báo bên kia mic bật/tắt | `int32 receiverId, int32 callId, int32 status` | không có route |
| 421 | `voiceInteractCall` | báo camera bật/tắt | `int32 receiverId, int32 callId, int32 status, uint16+UTF-8 param, int32 i4` | không có route |
| 440 | `calleeRequestNewServer` | bên nhận xin đổi máy chủ | `int32 partnerId, int32 callId, int32 type, uint16+UTF-8 extraData` | không có route |
| 441 | `callerAnswerNewServer` | bên gọi trả lời máy chủ mới | như 440 | không có route |
| 417/419 | `voiceRequestChangeZRTP` / `...ACK` | đổi ZRTP | nhiều trường nhị phân | không có route |
| 422/423 | `voiceInAppACK` / `voiceCommandACK` | ACK nội bộ | | không có route |

Bảng route REST của renderer (ids 11300–11311, 12006, 12056, 12064…) chỉ gồm
`requestcall, request, ringring, answer, answerack, cancel, endcall, holdreq,
holdresp, unholdreq, unholdresp, logendcall`, nhóm `group/*`, `conf` (12006),
`requestaudio2video`, `requestsharescreen`. Không có tên route nào cho mute,
interact hay đổi máy chủ.

Phía nhận thì PC thấy đủ: máy chủ đẩy `mute_audio` (`params.type` 1 = tắt, 0 =
bật) và `onoff_camera` xuống phiên PC (đã ghi trong `zcall-agent.log`). Vì vậy
việc **nhận** hoạt động; chỉ thiếu đường **gửi**.

## Vì sao không làm được an toàn

1. Android gửi qua socket native với phiên đăng nhập riêng. Phiên PC (WSS +
   REST) không dùng lại được phiên đó.
2. WebSocket chat của PC chỉ nhận JSON với bảng lệnh chat; gửi `443`/`421` vào
   đó là gửi lệnh không có tài liệu cho máy chủ, nhiều khả năng bị từ chối hoặc
   bị ghi nhận bất thường trên tài khoản.
3. Đoán tên route REST (ví dụ `/api/voicecall/mute`) cũng là thăm dò máy chủ thật
   bằng tài khoản của bạn.
4. Thể hiện của lớp WebSocket nằm trong SharedWorker, không có IPC để agent gọi;
   muốn gửi phải vá bundle renderer.

Vì thế **không có mã gửi nào được thêm vào agent**. Thử nghiệm `12006`
(`/api/voicecall/conf`) trước đó: renderer gọi, máy chủ trả HTTP 200, nhưng bên
kia không đổi trạng thái và phản hồi không về agent (xem
`zcall-agent.js`: `reportMediaState`).

## Giao thức đổi máy chủ (chỉ ghi lại, chưa tích hợp)

- Engine phát `JniCallCallback::onCallRequest(int type, int partnerId, int callId,
  int i5, String data)`. `type` là thứ tự của `com.vng.zing.vn.zrtc.d`:
  `NONE`=0, `CALLEE_REQUEST_NEW_TCP_SERVER`=1, `CALLER_RESPONSE_NEW_TCP_SERVER`=2.
- App Android (`vz/p1.java`): type 1 → `calleeRequestNewServer` (lệnh 440), type 2 →
  `callerAnswerNewServer` (lệnh 441); cả hai bọc `data` làm `extraData`.
- Engine chỉ bắt đầu quy trình này khi cấu hình có `changeZRTP.enable == 1`
  (`enableChangeZrtp`, setter JNI `zrtc_call_config_set_enable_change_ZRTP`, TLV
  trường 8 của worker). Trong 4 cuộc gọi đến đã ghi log (2026-10-15), `params`
  không có `changeZRTP`, nên máy chủ không bật tính năng.
- Dự án hiện từ chối cấu hình này có chủ đích (`desktop-config.mjs` và
  `caller-response.mjs` từ chối `changeZRTP.enable == 1`; `outgoing-negotiation.mjs` và
  `outgoing-invitation.mjs` coi `onCallChangeZRTP` là lỗi).
- Trong worker, sự kiện `onCallRequest` được phát ra (`call-events.c`) nhưng
  không ai xử lý. Dù có xử lý, PC không có đường gửi lệnh 440/441.

## Điều cần có để làm tiếp

- Tên route REST và tham số mà máy chủ chấp nhận cho 443/421/440/441 từ phiên
  PC (chỉ biết được từ bản Zalo PC chính thức có các tính năng này, hoặc từ chính
  Zalo hỏi chúng ta), hoặc
- Một phiên socket native như Android (không khả thi với phiên PC).

Không nên thăm dò máy chủ bằng đoán route trên tài khoản thật.
