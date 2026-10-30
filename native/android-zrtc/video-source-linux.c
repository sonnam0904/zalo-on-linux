/* Pinned libzrtc x86_64 CPU source layout, verified at 0x383520/0x383610.
 * No SurfaceTextureHelper is created; texture input is not supported.
 * Use on one owner thread, destroy only after callbacks return.
 */
#include "video-source-linux.h"
#include <dlfcn.h>
#include <errno.h>
#include <stdlib.h>
struct LinuxVideoSource {
    void **vtable;
    LinuxVideoFrameCallback callback;
    void *opaque,*native;
    void (*receive)(void *,const void *,int,int,int,int,int64_t);
    void (*destroy)(void *);
};
static void receive_frame(LinuxVideoSource *source,const void *frame) {
    source->callback(source->opaque,frame);
}
static void *callback_vtable[]={(void *)receive_frame};
LinuxVideoSource *linux_video_source_create(void *h,LinuxVideoFrameCallback cb,void *opaque) {
    if(!h || !cb)return NULL;
    void (*pool_init)(void *)=dlsym(h,"_ZN6webrtc14I420BufferPoolC1Ev");
    void (*set_callback)(void *,void *)=dlsym(h,"_ZN4zrtc11VideoSource16registerCallbackEPNS0_19VideoSourceCallbackE");
    void *table=dlsym(h,"_ZTVN4zrtc11VideoSourceE");
    LinuxVideoSource *s=calloc(1,sizeof *s);if(!s)return NULL;
    s->receive=dlsym(h,"_ZN4zrtc11VideoSource25OnByteBufferFrameCapturedEPKviiiil");
    s->destroy=dlsym(h,"_ZN4zrtc11VideoSourceD1Ev");
    if(!pool_init || !set_callback || !table || !s->receive || !s->destroy){free(s);return NULL;}
    s->native=calloc(1,0x50);if(!s->native){free(s);return NULL;}
    s->vtable=callback_vtable;s->callback=cb;s->opaque=opaque;
    *(void **)s->native=(unsigned char *)table+16;
    ((unsigned char *)s->native)[8]=1;
    pool_init((unsigned char *)s->native+0x30);
    set_callback(s->native,s);return s;
}
int linux_video_source_submit(LinuxVideoSource *s,const void *nv21,size_t size,
    int width,int height,int rotation,int64_t timestamp_ns) {
    if(!s || !nv21 || width<2 || height<2 || width>1920 || height>1080 ||
        width%2 || height%2 || timestamp_ns<0 ||
        (rotation!=0 && rotation!=90 && rotation!=180 && rotation!=270) ||
        size!=(size_t)width*(size_t)height*3/2)return -EINVAL;
    s->receive(s->native,nv21,(int)size,width,height,rotation,timestamp_ns);return 0;
}
void linux_video_source_destroy(LinuxVideoSource *s) {
    if(!s)return;
    s->destroy(s->native);free(s->native);free(s);
}
