#include "video-frame-store.h"
#include <errno.h>
#include <pthread.h>
#include <string.h>
static pthread_mutex_t mutex=PTHREAD_MUTEX_INITIALIZER;
static unsigned char pixels[1920*1080*3/2];
static size_t size;
static int active,width,height;
static uint64_t sequence;
void video_frame_store_stop(void) {
    pthread_mutex_lock(&mutex);
    active=0;memset(pixels,0,sizeof pixels);size=0;width=height=0;
    pthread_mutex_unlock(&mutex);
}
void video_frame_store_start(void) {
    pthread_mutex_lock(&mutex);
    memset(pixels,0,sizeof pixels);size=0;width=height=0;active=1;
    pthread_mutex_unlock(&mutex);
}
int video_frame_store_publish(int w,int h,const unsigned char *planes[3],const int strides[3]) {
    if(!planes || !strides || w<2 || h<2 || w>1920 || h>1080 || w%2 || h%2)return -EINVAL;
    for(int p=0;p<3;p++)if(!planes[p] || strides[p]<(p?w/2:w) || strides[p]>16384)return -EINVAL;
    pthread_mutex_lock(&mutex);
    if(!active){pthread_mutex_unlock(&mutex);return -ENOTCONN;}
    size_t offset=0;
    for(int p=0;p<3;p++) {
        int columns=p?w/2:w,rows=p?h/2:h;
        for(int y=0;y<rows;y++) {
            memcpy(pixels+offset,planes[p]+(size_t)y*strides[p],(size_t)columns);
            offset+=(size_t)columns;
        }
    }
    if(offset<size)memset(pixels+offset,0,size-offset);
    size=offset;width=w;height=h;sequence++;
    pthread_mutex_unlock(&mutex);return 0;
}
int video_frame_store_snapshot(unsigned char *out,size_t capacity,int *w,int *h,uint64_t *seq) {
    if(!out || !w || !h || !seq)return -EINVAL;
    pthread_mutex_lock(&mutex);
    int result=!active || !size?-ENODATA:capacity<size?-ENOBUFS:(int)size;
    if(result>0){memcpy(out,pixels,size);*w=width;*h=height;*seq=sequence;}
    pthread_mutex_unlock(&mutex);return result;
}
