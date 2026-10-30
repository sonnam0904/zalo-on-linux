#include "video-capturer-linux.h"
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#include <stdatomic.h>
static atomic_uint frames;
static pthread_t owner;
static int (*width_of)(const void *),(*height_of)(const void *);
static void received(void *opaque,const void *frame) {
    (void)opaque;
    if(pthread_equal(owner,pthread_self()) || width_of(frame)!=640 || height_of(frame)!=480)_exit(3);
    atomic_fetch_add(&frames,1);
}
int main(int argc,char **argv) {
    if(argc!=2)return 2;
    alarm(15);owner=pthread_self();
    void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!h)return 2;
    width_of=dlsym(h,"_ZNK6webrtc10VideoFrame5widthEv");
    height_of=dlsym(h,"_ZNK6webrtc10VideoFrame6heightEv");
    if(!width_of || !height_of)return 2;
    size_t size=640*480*3/2;unsigned char *pixels=malloc(size);if(!pixels)return 2;
    memset(pixels,128,size);
    for(int cycle=0;cycle<3;cycle++) {
        atomic_store(&frames,0);
        LinuxVideoCapturer *c=linux_video_capturer_create(h,received,NULL);if(!c)return 2;
        if(linux_video_capturer_submit(c,pixels,size-1,640,480,0,0)>=0)return 3;
        for(int i=0;i<30;i++) {
            memset(pixels,32+i,640*480);
            if(linux_video_capturer_submit(c,pixels,size,640,480,0,(int64_t)i*33333333))return 3;
            usleep(33333);
        }
        usleep(150000);
        linux_video_capturer_destroy(c);
        unsigned count=atomic_load(&frames);
        if(count<25 || count>30)return 3;
        usleep(100000);
        if(count!=atomic_load(&frames))return 3;
        printf("PASS CPU capturer cycle %d: %u frames on original encode thread; joined cleanly\n",cycle,count);
    }
    free(pixels);return 0;
}
