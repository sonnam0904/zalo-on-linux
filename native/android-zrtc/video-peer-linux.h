#pragma once
#include <stddef.h>
#include <stdint.h>
/* Experimental CPU Peer path. Network requires a separate explicit experimental
 * opt-in. Transport negotiation and remote rendering are not yet verified. */
int linux_video_peer_install(void *library);

void linux_video_peer_detach(void);
int linux_video_peer_submit(const void *,size_t,int,int,int,int64_t);
unsigned long linux_video_peer_frames(void);
unsigned long linux_video_peer_encoded_frames(void);
unsigned long linux_video_peer_encoded_bytes(void);
unsigned long linux_video_peer_decoded_frames(void);
int linux_video_peer_decoded_width(void);
int linux_video_peer_decoded_height(void);
