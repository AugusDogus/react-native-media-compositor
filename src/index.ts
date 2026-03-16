import { NitroModules } from 'react-native-nitro-modules'
import type { MediaCompositor as MediaCompositorSpec } from './specs/media-compositor.nitro'

export const MediaCompositor =
  NitroModules.createHybridObject<MediaCompositorSpec>('MediaCompositor')