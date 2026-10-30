#pragma once
#include <stddef.h>
#include <sys/types.h>
typedef struct { int fd; pid_t pid; } ZrtcPcm;
int zrtc_pcm_open(ZrtcPcm *pcm, int recording);
int zrtc_pcm_transfer(ZrtcPcm *pcm, void *buffer, size_t bytes, int recording,
                      const int *stopping);
void zrtc_pcm_close(ZrtcPcm *pcm);
