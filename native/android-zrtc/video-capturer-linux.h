#pragma once
#include "video-source-linux.h"
typedef struct LinuxVideoCapturer LinuxVideoCapturer;
/* Owns an original VideoCapturer and its encode thread. Callback is borrowed
 * on that thread; stop/destroy from the submitting owner thread only. */
LinuxVideoCapturer *linux_video_capturer_create(void *library,
    LinuxVideoFrameCallback callback, void *opaque);
int linux_video_capturer_submit(LinuxVideoCapturer *, const void *, size_t,
    int width, int height, int rotation, int64_t timestamp_ns);
void linux_video_capturer_destroy(LinuxVideoCapturer *);
