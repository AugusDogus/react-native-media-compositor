import { NitroModules } from 'react-native-nitro-modules'
import type {
  MediaCompositor,
  MediaCompositorImageRequest,
  MediaCompositorResult,
  MediaCompositorStatus,
  MediaCompositorVideoRequest,
} from './specs/media-compositor.nitro'

export type {
  MediaCompositor,
  MediaCompositorImageFormat,
  MediaCompositorImageRequest,
  MediaCompositorNormalizedRect,
  MediaCompositorPreviewSpec,
  MediaCompositorResult,
  MediaCompositorStatus,
  MediaCompositorTextAlign,
  MediaCompositorTextOverlay,
  MediaCompositorTextStyle,
  MediaCompositorVideoRequest,
} from './specs/media-compositor.nitro'

let mediaCompositor: MediaCompositor | null = null

export function getMediaCompositor(): MediaCompositor {
  if (mediaCompositor != null) {
    return mediaCompositor
  }

  mediaCompositor =
    NitroModules.createHybridObject<MediaCompositor>('MediaCompositor')

  return mediaCompositor
}

export async function composeImage(
  request: MediaCompositorImageRequest
): Promise<MediaCompositorResult> {
  return getMediaCompositor().composeImage(request)
}

export async function composeVideo(
  request: MediaCompositorVideoRequest
): Promise<MediaCompositorResult> {
  return getMediaCompositor().composeVideo(request)
}

export async function cancelComposition(): Promise<void> {
  return getMediaCompositor().cancel()
}

export function getCompositionStatus(): MediaCompositorStatus {
  return getMediaCompositor().status
}