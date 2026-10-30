/* libzrtc SHA pinned by the launcher. Original allocation size 0x370 from
 * getInstance+0x33. No Android capturer, texture, or fake Java object.
 * onVideoFrame retains I420 into the original bounded latest-frame slot;
 * processVideoEncode dispatches callback slot 1 on the original thread. */
#include "video-capturer-linux.h"
#include <dlfcn.h>
#include <stdlib.h>
#include <errno.h>
struct LinuxVideoCapturer {
    void **vtable;
    void *native, *opaque;
    LinuxVideoFrameCallback callback;
    LinuxVideoSource *source;
    void (*receive)(void *,const void *);
    void (*stop)(void *);
    void (*destroy)(void *);
    void (*set_callback)(void *,void *);
};
static unsigned char accept_frame(void *self,const void *frame,unsigned char texture) {
    (void)self;(void)frame;return !texture;
}
static void encode_frame(LinuxVideoCapturer *c,const void *frame) {
    c->callback(c->opaque,frame);
}
static void *callback_vtable[]={(void *)accept_frame,(void *)encode_frame};
static void source_frame(void *opaque,const void *frame) {
    LinuxVideoCapturer *c=opaque;c->receive(c->native,frame);
}
LinuxVideoCapturer *linux_video_capturer_create(void *h,LinuxVideoFrameCallback cb,void *opaque) {
    if(!h || !cb)return NULL;
    LinuxVideoCapturer *c=calloc(1,sizeof *c);if(!c)return NULL;
    void (*ctor)(void *)=dlsym(h,"_ZN4zrtc13VideoCapturerC1Ev");
    void (*start)(void *)=dlsym(h,"_ZN4zrtc13VideoCapturer18_startEncodeThreadEv");
    c->destroy=dlsym(h,"_ZN4zrtc13VideoCapturerD1Ev");
    c->stop=dlsym(h,"_ZN4zrtc13VideoCapturer17_stopEncodeThreadEv");
    c->set_callback=dlsym(h,"_ZN4zrtc13VideoCapturer16registerCallbackEPNS0_21VideoCapturerCallbackE");
    c->receive=dlsym(h,"_ZN4zrtc13VideoCapturer12onVideoFrameERKN6webrtc10VideoFrameE");
    if(!ctor || !start || !c->destroy || !c->stop || !c->set_callback || !c->receive){free(c);return NULL;}
    c->native=calloc(1,0x370);if(!c->native){free(c);return NULL;}
    ctor(c->native);
    c->vtable=callback_vtable;c->callback=cb;c->opaque=opaque;
    c->source=linux_video_source_create(h,source_frame,c);
    if(!c->source){c->destroy(c->native);free(c->native);free(c);return NULL;}
    c->set_callback(c->native,c);start(c->native);return c;
}
int linux_video_capturer_submit(LinuxVideoCapturer *c,const void *pixels,size_t size,
    int width,int height,int rotation,int64_t timestamp_ns) {
    if(!c)return -EINVAL;
    return linux_video_source_submit(c->source,pixels,size,width,height,rotation,timestamp_ns);
}
void linux_video_capturer_destroy(LinuxVideoCapturer *c) {
    if(!c)return;
    c->stop(c->native); /* join before detaching callback or freeing frames */
    c->set_callback(c->native,NULL);
    linux_video_source_destroy(c->source);
    c->destroy(c->native);free(c->native);free(c);
}
