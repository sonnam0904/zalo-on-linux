/* Pinned x86_64 VideoSource CPU ingress. No Peer, signaling or EGL claim.
 * The Android constructor initializes fields/pool then creates a texture
 * helper unconditionally. This CPU-only owner initializes the same pool but
 * has no texture helper and must never call OnTextureFrameCaptured.
 * ABI verified at ctor 0x383520, byte ingress 0x383700, dtor 0x383610.
 */
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "video-source-linux.h"
static unsigned frames;
static int (*width_of)(const void *),(*height_of)(const void *);
static const unsigned char *(*plane_of)(const void *,int);
static int verify_nv21;
static void *sym(void *h,const char *name) {
    void *p=dlsym(h,name);if(!p){fprintf(stderr,"Missing video symbol: %s\n",name);exit(2);}return p;
}
static void on_frame(void *self,const void *frame) {
    (void)self;
    if(width_of(frame)!=640 || height_of(frame)!=480) exit(3);
    if(verify_nv21) {
        const unsigned char *u=plane_of(frame,1),*v=plane_of(frame,2);
        if(!u || !v || u[0]!=90 || v[0]!=240) exit(6);
    }
    frames++;
}
int main(int argc,char **argv) {
    if(argc!=2 && (argc!=3 || strcmp(argv[2],"--verify-nv21"))) return 2;
    verify_nv21=argc==3;
    alarm(15);
    void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!h){fputs(dlerror(),stderr);return 2;}
    width_of=sym(h,"_ZNK6webrtc10VideoFrame5widthEv");
    height_of=sym(h,"_ZNK6webrtc10VideoFrame6heightEv");
    plane_of=sym(h,"_ZN6webrtc10VideoFrame6bufferENS_9PlaneTypeE");
    LinuxVideoSource *source=linux_video_source_create(h,on_frame,NULL);
    unsigned char *pixels=malloc(640*480*3/2);
    if(!source || !pixels) return 2;
    if(linux_video_source_submit(source,pixels,1,640,480,0,0)==0 ||
       linux_video_source_submit(source,pixels,640*480*3/2,640,480,45,0)==0 || frames)return 5;
    for(unsigned i=0;i<30;i++) {
        size_t n=0,total=640*480*3/2;
        if(verify_nv21) {
            memset(pixels,81,640*480);
            for(size_t p=640*480;p<total;p+=2){pixels[p]=240;pixels[p+1]=90;}
            n=total;
        }
        while(n<total){size_t got=fread(pixels+n,1,total-n,stdin);if(!got){fputs("Truncated camera frame\n",stderr);return 4;}n+=got;}
        if(linux_video_source_submit(source,pixels,total,640,480,0,(int64_t)i*33333333))return 5;
    }
    linux_video_source_destroy(source);free(pixels);
    if(frames!=30)return 3;
    printf("PASS %s -> native VideoSource -> I420 callback: %u frames 640x480; not a video call\n",
        verify_nv21?"NV21 color vector":"camera",frames);
    dlclose(h);return 0;
}
