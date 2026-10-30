#pragma once
#include <stddef.h>
#include <stdint.h>
typedef struct LinuxVideoSource LinuxVideoSource;
/* Frame pointer is borrowed only for the duration of callback. */
typedef void (*LinuxVideoFrameCallback)(void *opaque,const void *frame);
/* Caller must verify the pinned ELF before creating this CPU-only source. */
LinuxVideoSource *linux_video_source_create(void *library,LinuxVideoFrameCallback callback,void *opaque);
/* The Android byte-buffer entry point consumes NV21: Y followed by VU. */
int linux_video_source_submit(LinuxVideoSource *source,const void *nv21,size_t size,
    int width,int height,int rotation,int64_t timestamp_ns);
void linux_video_source_destroy(LinuxVideoSource *source);
