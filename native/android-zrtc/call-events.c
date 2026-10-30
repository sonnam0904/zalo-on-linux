#include "call-events.h"
#include <string.h>
#define S "Ljava/lang/String;"
/* Recovered from the pinned JniCallCallback constructor, not inferred from
 * similarly named desktop events. Desktop translation belongs in the IPC host. */
static const struct { const char *name, *signature, *types; } events[] = {
    {"onCallStats", "(" S ")V", "S"},
    {"onCallLog", "(" S ")V", "S"},
    {"onCallState", "(I)V", "I"},
    {"onIncomingCall", "()V", ""},
    {"onMakeCall", "()V", ""},
    {"onCallAutoHangup", "()V", ""},
    {"onCallQualityChanged", "(I)V", "I"},
    {"onInitZrtpRequestFailed", "(I)V", "I"},
    {"onInitZrtpWithServer", "(" S S ")V", "SS"},
    {"onCallAudioState", "(I)V", "I"},
    {"onCallChangeZRTP", "(I" S S S ")V", "ISSS"},
    {"onCallUpdateP2PStatus", "(II)V", "II"},
    {"onCallVideoState", "(I)V", "I"},
    {"onCallErr", "(I)V", "I"},
    {"onPreConnectSuccessful", "(III" S ")V", "IIIS"},
    {"onCallRequest", "(IIII" S ")V", "IIIIS"},
    {"onEnableLowDataModeComplete", "(ZZ)V", "ZZ"},
};
const char *zrtc_event_signature(const char *name) {
    for (size_t i = 0; i < sizeof events / sizeof events[0]; i++)
        if (!strcmp(events[i].name, name)) return events[i].signature;
    return NULL;
}
const char *zrtc_event_types(const char *name) {
    for (size_t i = 0; i < sizeof events / sizeof events[0]; i++)
        if (!strcmp(events[i].name, name)) return events[i].types;
    return NULL;
}
