#pragma once
#include <stddef.h>
#include <stdint.h>
/* Latest-frame mailbox. Input planes are borrowed only during publish.
 * Snapshot copies into caller-owned storage; no native frame pointers escape.
 * Stop disables publishing and erases retained media. */
void video_frame_store_start(void);
void video_frame_store_stop(void);
int video_frame_store_publish(int width,int height,const unsigned char *planes[3],const int strides[3]);
int video_frame_store_snapshot(unsigned char *out,size_t capacity,int *width,int *height,uint64_t *sequence);
