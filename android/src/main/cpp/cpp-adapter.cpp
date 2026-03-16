#include <jni.h>
#include "MediaCompositorOnLoad.hpp"

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void*) {
  return margelo::nitro::mediacompositor::initialize(vm);
}
