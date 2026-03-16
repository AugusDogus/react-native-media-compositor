import type { HybridObject } from 'react-native-nitro-modules'

export type MediaCompositorStatus =
  | 'idle'
  | 'processing'
  | 'cancelled'
  | 'failed'

export type MediaCompositorImageFormat = 'jpg' | 'png'
export type MediaCompositorTextAlign = 'left' | 'center' | 'right'

export interface MediaCompositorPreviewSpec {
  width: number
  height: number
}

export interface MediaCompositorNormalizedRect {
  x: number
  y: number
  width: number
  height: number
}

export interface MediaCompositorTextStyle {
  fontSize: number
  textColor: string
  backgroundColor?: string
  paddingHorizontal?: number
  paddingVertical?: number
  textAlign?: MediaCompositorTextAlign
  opacity?: number
  cornerRadius?: number
}

export interface MediaCompositorTextOverlay {
  id: string
  text: string
  rect: MediaCompositorNormalizedRect
  style: MediaCompositorTextStyle
}

export interface MediaCompositorImageRequest {
  inputPath: string
  outputPath?: string
  outputFormat?: MediaCompositorImageFormat
  quality?: number
  preview?: MediaCompositorPreviewSpec
  overlays: MediaCompositorTextOverlay[]
}

export interface MediaCompositorVideoRequest {
  inputPath: string
  outputPath?: string
  preserveAudio?: boolean
  preview?: MediaCompositorPreviewSpec
  overlays: MediaCompositorTextOverlay[]
}

export interface MediaCompositorResult {
  filePath: string
}

export interface MediaCompositor
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  readonly isProcessing: boolean
  readonly status: MediaCompositorStatus

  composeImage(
    request: MediaCompositorImageRequest
  ): Promise<MediaCompositorResult>
  composeVideo(
    request: MediaCompositorVideoRequest
  ): Promise<MediaCompositorResult>
  cancel(): Promise<void>
}