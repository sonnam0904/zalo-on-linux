#define _GNU_SOURCE
#include "video-peer-linux.h"
#include "video-source-linux.h"
#include "video-frame-store.h"
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdatomic.h>
static void *library, *owner, *capturer;
static LinuxVideoSource *source;
static unsigned long frames;
static atomic_ulong encoded_frames,encoded_bytes;
static atomic_ulong decoded_frames;
static atomic_int decoded_width,decoded_height;
static int (*original_render)(void *,const void *);
static int (*frame_width)(const void *),(*frame_height)(const void *);
static const unsigned char *(*frame_plane)(const void *,int);
static int (*frame_stride)(const void *,int);
static int observe_render(void *self,const void *value) {
    const unsigned char *planes[3];int strides[3];
    for(int p=0;p<3;p++){planes[p]=frame_plane(value,p);strides[p]=frame_stride(value,p);}
    video_frame_store_publish(frame_width(value),frame_height(value),planes,strides);
    atomic_store(&decoded_width,frame_width(value));
    atomic_store(&decoded_height,frame_height(value));
    atomic_fetch_add(&decoded_frames,1);
    return original_render(self,value);
}
unsigned long linux_video_peer_decoded_frames(void) {return atomic_load(&decoded_frames);}
int linux_video_peer_decoded_width(void) {return atomic_load(&decoded_width);}
int linux_video_peer_decoded_height(void) {return atomic_load(&decoded_height);}
static int (*original_send)(void *,unsigned char,const void *,const void *,const void *);
/* Observe, then forward unchanged to the original codec SendData. This does
 * not replace the Peer callback or PayloadRouter and does not claim delivery. */
static int observe_send(void *self,unsigned char payload,const unsigned char *image,const void *fragment,const void *header) {
    const void *data;size_t size;
    memcpy(&data,image+0x28,sizeof data);memcpy(&size,image+0x30,sizeof size);
    if(data && size) {atomic_fetch_add(&encoded_frames,1);atomic_fetch_add(&encoded_bytes,size);}
    return original_send(self,payload,image,fragment,header);
}
unsigned long linux_video_peer_encoded_frames(void) {return atomic_load(&encoded_frames);}
unsigned long linux_video_peer_encoded_bytes(void) {return atomic_load(&encoded_bytes);}
static void (*receive)(void *,const void *),(*start_thread)(void *),(*stop_thread)(void *);
static void (*set_callback)(void *,void *);
static void frame(void *opaque,const void *value) {receive(opaque,value);frames++;}
unsigned long linux_video_peer_frames(void) {return frames;}
void linux_video_peer_detach(void) {
    video_frame_store_stop();
    if(capturer)stop_thread(capturer);
    if(source)linux_video_source_destroy(source);
    source=NULL;capturer=NULL;owner=NULL;
}
/* Peer owns the original capturer. Do not replace its shared_ptr or destructor.
 * Retain the original Peer callback: capture/FPS/media gates and encoding run
 * through the engine, rather than bypassing them with direct codec delivery. */
static int bind_capture(unsigned char *peer) {
    if(source)return -EBUSY;
    void *native;memcpy(&native,peer+0x620,sizeof native);
    if(!native)return -ENODEV;
    source=linux_video_source_create(library,frame,native);
    if(!source)return -ENOMEM;
    owner=peer;capturer=native;frames=0;set_callback(native,peer+0x18);
    video_frame_store_start();
    return 0;
}
static int start_capture(void *peer) {
    if(peer!=owner || !source || !capturer)return -ENODEV;
    start_thread(capturer);return 0;
}

int linux_video_peer_submit(const void *pixels,size_t size,int w,int h,int r,int64_t t) {
    if(!source)return -ENOTCONN;
    return linux_video_source_submit(source,pixels,size,w,h,r,t);
}
static void jump(unsigned char *at,const void *target) {
    const unsigned char op[]={0xff,0x25,0,0,0,0};
    memcpy(at,op,6);memcpy(at+6,&target,8);
}
static int patch(unsigned char *at,const unsigned char *expected,const void *target) {
    if(memcmp(at,expected,14))return -1;
    long page=sysconf(_SC_PAGESIZE);if(page<=0)return -1;
    uintptr_t lo=(uintptr_t)at&~((uintptr_t)page-1);
    uintptr_t hi=((uintptr_t)at+13)&~((uintptr_t)page-1);
    size_t size=hi-lo+(size_t)page;
    if(mprotect((void *)lo,size,PROT_READ|PROT_WRITE))return -1;
    jump(at,target);
    if(mprotect((void *)lo,size,PROT_READ|PROT_EXEC))_exit(2);
    return 0;
}
int linux_video_peer_install(void *h) {
    library=h;
    receive=dlsym(h,"_ZN4zrtc13VideoCapturer12onVideoFrameERKN6webrtc10VideoFrameE");
    start_thread=dlsym(h,"_ZN4zrtc13VideoCapturer18_startEncodeThreadEv");
    stop_thread=dlsym(h,"_ZN4zrtc13VideoCapturer17_stopEncodeThreadEv");
    set_callback=dlsym(h,"_ZN4zrtc13VideoCapturer16registerCallbackEPNS0_21VideoCapturerCallbackE");
    unsigned char *init=dlsym(h,"_ZN4zrtc4Peer10initializeEv");
    unsigned char *video=dlsym(h,"_ZN4zrtc4Peer26_initVideoCodingAndCaptureEv");
    unsigned char *start=dlsym(h,"_ZN4zrtc4Peer18_startVideoCaptureEv");
    unsigned char *send=dlsym(h,"_ZN4zrtc17WebRtcVideoCoding8SendDataEhRKN6webrtc12EncodedImageERKNS1_22RTPFragmentationHeaderEPKNS1_14RTPVideoHeaderE");
    unsigned char *render=dlsym(h,"_ZN4zrtc17WebRtcVideoCoding13FrameToRenderERN6webrtc10VideoFrameE");
    frame_width=dlsym(h,"_ZNK6webrtc10VideoFrame5widthEv");
    frame_height=dlsym(h,"_ZNK6webrtc10VideoFrame6heightEv");
    frame_plane=dlsym(h,"_ZNK6webrtc10VideoFrame6bufferENS_9PlaneTypeE");
    frame_stride=dlsym(h,"_ZNK6webrtc10VideoFrame6strideENS_9PlaneTypeE");
    if(!frame_plane || !frame_stride)return -1;
    if(!render || !frame_width || !frame_height)return -1;
    if(!receive || !start_thread || !stop_thread || !set_callback || !init || !video || !start || !send)return -1;
    const unsigned char egl[14]={0x48,0x83,0xbf,0x50,0x08,0,0,0,0x0f,0x84,0x0b,0x02,0,0};
    const unsigned char android[14]={0xe8,0xbd,0x1e,0xfc,0xff,0x49,0x8b,0xbe,0x20,0x06,0,0,0x48,0x8b};
    const unsigned char beginning[14]={0x55,0x41,0x57,0x41,0x56,0x41,0x54,0x53,0x48,0x81,0xec,0x60,0x01,0};
    const unsigned char hardware[14]={0x41,0x80,0xbe,0x48,0x08,0,0,0,0x74,0x14,0x41,0x8a,0x8e,0xd4};
    const unsigned char send_entry[17]={0x55,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xec,0xa8,0x06,0,0};
    const unsigned char render_entry[14]={0x41,0x57,0x41,0x56,0x41,0x54,0x53,0x50,0x49,0x89,0xf6,0x48,0x89,0xfb};
    if(memcmp(render,render_entry,14))return -1;
    if(memcmp(init+0x59,egl,14) || memcmp(video+0x75e,android,14) ||
       memcmp(video+0x3b3,hardware,14) || memcmp(start,beginning,14) || memcmp(send,send_entry,17))return -1;
    long page=sysconf(_SC_PAGESIZE);if(page<=0)return -1;
    unsigned char *code=mmap(NULL,(size_t)page,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
    if(code==MAP_FAILED)return -1;
    /* Within original prologue: r14=Peer, stack already call-aligned.
     * mov r14,rdi; movabs bind,rax; call rax; mov eax,r14d;
     * jump original cleanup (preserves actual initialization error). */
    const unsigned char prefix[]={0x4c,0x89,0xf7,0x48,0xb8};
    memcpy(code,prefix,5);void *bind=(void *)bind_capture;memcpy(code+5,&bind,8);
    const unsigned char suffix[]={0xff,0xd0,0x41,0x89,0xc6};
    memcpy(code+13,suffix,5);jump(code+18,video+0x88a);
    /* Whole original SendData prologue, containing no PC-relative operands. */
    memcpy(code+128,send_entry,17);jump(code+145,send+17);
    original_send=(void *)(code+128);
    /* Whole PC-independent FrameToRender prologue; keep original callbacks. */
    memcpy(code+192,render_entry,14);jump(code+206,render+14);
    original_render=(void *)(code+192);
    if(mprotect(code,(size_t)page,PROT_READ|PROT_EXEC)){munmap(code,(size_t)page);return -1;}
    /* Installation is before JNI threads start. Any partial failure terminates
     * the worker; no execution through partially installed adapters. */
    if(patch(render,render_entry,(void *)observe_render) || patch(send,send_entry,(void *)observe_send) || patch(video+0x3b3,hardware,video+0x3d1) ||
       patch(video+0x75e,android,code) || patch(start,beginning,(void *)start_capture) ||
       patch(init+0x59,egl,init+0x67))_exit(2);
    return 0;
}
