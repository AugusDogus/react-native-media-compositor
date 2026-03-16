import type React from 'react'
import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { LayoutChangeEvent } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import Video from 'react-native-video'
import { launchImageLibrary } from 'react-native-image-picker'
import {
  cancelComposition,
  composeImage,
  composeVideo,
  type MediaCompositorNormalizedRect,
  type MediaCompositorPreviewSpec,
  type MediaCompositorTextOverlay,
} from 'react-native-media-compositor'
import { TextOverlayEditor } from './TextOverlayEditor'

type ExampleMode = 'photo' | 'video'
type AspectPresetId = 'source' | 'square' | 'portrait'
type ResultKind = 'image' | 'video'

interface SelectedAsset {
  uri: string
  width?: number
  height?: number
  type?: string
  fileName?: string
}

const DEFAULT_RECT: MediaCompositorNormalizedRect = {
  x: 0.1,
  y: 0.68,
  width: 0.8,
  height: 0.16,
}

const ASPECT_PRESETS: Array<{
  id: AspectPresetId
  label: string
  ratio: number | null
}> = [
  { id: 'source', label: 'Source', ratio: null },
  { id: 'square', label: '1:1', ratio: 1 },
  { id: 'portrait', label: '9:16', ratio: 9 / 16 },
]

function isVideoAsset(asset: SelectedAsset | null): boolean {
  return asset?.type?.startsWith('video/') ?? false
}

function formatAspectRatio(asset: SelectedAsset | null): number {
  if (asset?.width != null && asset.height != null && asset.width > 0 && asset.height > 0) {
    return asset.width / asset.height
  }
  return 16 / 9
}

function buildPreviewSpec(
  width: number,
  height: number
): MediaCompositorPreviewSpec | undefined {
  if (width <= 0 || height <= 0) {
    return undefined
  }

  return {
    width,
    height,
  }
}

function App(): React.JSX.Element {
  const [mode, setMode] = useState<ExampleMode>('photo')
  const [aspectPreset, setAspectPreset] = useState<AspectPresetId>('portrait')
  const [selectedAsset, setSelectedAsset] = useState<SelectedAsset | null>(null)
  const [overlayText, setOverlayText] = useState('Drag me, then tap to edit')
  const [overlayRect, setOverlayRect] =
    useState<MediaCompositorNormalizedRect>(DEFAULT_RECT)
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 })
  const [isComposing, setIsComposing] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [resultUri, setResultUri] = useState<string | null>(null)
  const [resultKind, setResultKind] = useState<ResultKind | null>(null)

  const selectedAspectRatio = useMemo(() => {
    const preset = ASPECT_PRESETS.find((item) => item.id === aspectPreset)
    return preset?.ratio ?? formatAspectRatio(selectedAsset)
  }, [aspectPreset, selectedAsset])

  const overlay = useMemo<MediaCompositorTextOverlay>(
    () => ({
      id: 'headline',
      text: overlayText,
      rect: overlayRect,
      style: {
        fontSize: 18,
        textColor: '#FFFFFF',
        backgroundColor: '#99000000',
        paddingHorizontal: 12,
        paddingVertical: 6,
        textAlign: 'center',
        opacity: 1,
        cornerRadius: 12,
      },
    }),
    [overlayRect, overlayText]
  )

  const previewSpec = useMemo(
    () => buildPreviewSpec(previewSize.width, previewSize.height),
    [previewSize.height, previewSize.width]
  )

  async function handlePickMedia(): Promise<void> {
    setErrorMessage(null)

    const response = await launchImageLibrary({
      mediaType: mode,
      selectionLimit: 1,
      includeExtra: false,
      formatAsMp4: mode === 'video',
    })

    if (response.didCancel) {
      return
    }

    if (response.errorMessage != null) {
      setErrorMessage(response.errorMessage)
      return
    }

    const asset = response.assets?.[0]
    if (asset?.uri == null) {
      setErrorMessage('The selected asset did not expose a local file URI.')
      return
    }

    setSelectedAsset({
      fileName: asset.fileName,
      height: asset.height,
      type: asset.type,
      uri: asset.uri,
      width: asset.width,
    })
    setResultUri(null)
    setResultKind(null)
  }

  async function handleCompose(): Promise<void> {
    if (selectedAsset == null) {
      setErrorMessage('Pick an image or video first.')
      return
    }

    if (previewSpec == null) {
      setErrorMessage('Wait for the preview to measure before exporting.')
      return
    }

    setIsComposing(true)
    setErrorMessage(null)

    try {
      const overlays = overlayText.trim().length > 0 ? [overlay] : []

      if (isVideoAsset(selectedAsset)) {
        const result = await composeVideo({
          inputPath: selectedAsset.uri,
          preserveAudio: true,
          preview: previewSpec,
          overlays,
        })
        setResultUri(result.filePath)
        setResultKind('video')
      } else {
        const result = await composeImage({
          inputPath: selectedAsset.uri,
          outputFormat: 'png',
          preview: previewSpec,
          overlays,
        })
        setResultUri(result.filePath)
        setResultKind('image')
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Media composition failed.'
      setErrorMessage(message)
    } finally {
      setIsComposing(false)
    }
  }

  async function handleCancel(): Promise<void> {
    try {
      await cancelComposition()
    } finally {
      setIsComposing(false)
    }
  }

  function handlePreviewLayout(event: LayoutChangeEvent): void {
    setPreviewSize({
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    })
  }

  const showVideoPreview = isVideoAsset(selectedAsset)

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Text style={styles.title}>Media compositor example</Text>
          <Text style={styles.subtitle}>
            Pick local media, place a text overlay over a cover-style preview,
            then export with the same crop and layout.
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Source type</Text>
          <View style={styles.row}>
            <ModeButton
              active={mode === 'photo'}
              label="Image"
              onPress={() => setMode('photo')}
            />
            <ModeButton
              active={mode === 'video'}
              label="Video"
              onPress={() => setMode('video')}
            />
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Preview crop</Text>
          <View style={styles.row}>
            {ASPECT_PRESETS.map((preset) => (
              <ModeButton
                key={preset.id}
                active={aspectPreset === preset.id}
                label={preset.label}
                onPress={() => setAspectPreset(preset.id)}
              />
            ))}
          </View>
        </View>

        <View style={styles.section}>
          <View style={styles.actionRow}>
            <Pressable style={styles.primaryButton} onPress={handlePickMedia}>
              <Text style={styles.primaryButtonLabel}>
                Pick {mode === 'photo' ? 'image' : 'video'}
              </Text>
            </Pressable>
            <Pressable
              disabled={isComposing || selectedAsset == null}
              style={[
                styles.secondaryButton,
                selectedAsset == null && styles.buttonDisabled,
              ]}
              onPress={handleCompose}>
              <Text style={styles.secondaryButtonLabel}>Export</Text>
            </Pressable>
            <Pressable
              disabled={!isComposing}
              style={[
                styles.secondaryButton,
                !isComposing && styles.buttonDisabled,
              ]}
              onPress={handleCancel}>
              <Text style={styles.secondaryButtonLabel}>Cancel</Text>
            </Pressable>
          </View>
          <Text style={styles.metaText}>
            {selectedAsset?.fileName ?? 'No asset selected yet'}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Preview</Text>
          <View
            style={[styles.previewShell, { aspectRatio: selectedAspectRatio }]}
            onLayout={handlePreviewLayout}>
            {selectedAsset == null ? (
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                  Pick a local image or video to start the demo.
                </Text>
              </View>
            ) : (
              <>
                {showVideoPreview ? (
                  <Video
                    muted
                    repeat
                    paused={false}
                    resizeMode="cover"
                    source={{ uri: selectedAsset.uri }}
                    style={StyleSheet.absoluteFill}
                  />
                ) : (
                  <Image
                    resizeMode="cover"
                    source={{ uri: selectedAsset.uri }}
                    style={StyleSheet.absoluteFill}
                  />
                )}
                <TextOverlayEditor
                  disabled={isComposing}
                  previewHeight={previewSize.height}
                  previewWidth={previewSize.width}
                  rect={overlayRect}
                  text={overlayText}
                  onChangeRect={setOverlayRect}
                  onChangeText={setOverlayText}
                />
              </>
            )}
            {isComposing ? (
              <View style={styles.busyOverlay}>
                <ActivityIndicator color="#ffffff" />
                <Text style={styles.busyText}>Composing…</Text>
              </View>
            ) : null}
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Exported output</Text>
          {resultUri == null ? (
            <Text style={styles.metaText}>
              Export a composition to preview the output file URI here.
            </Text>
          ) : (
            <>
              <View style={styles.resultShell}>
                {resultKind === 'video' ? (
                  <Video
                    controls
                    paused={false}
                    repeat
                    resizeMode="contain"
                    source={{ uri: resultUri }}
                    style={styles.resultMedia}
                  />
                ) : (
                  <Image
                    resizeMode="contain"
                    source={{ uri: resultUri }}
                    style={styles.resultMedia}
                  />
                )}
              </View>
              <Text selectable style={styles.resultUri}>
                {resultUri}
              </Text>
            </>
          )}
        </View>

        {errorMessage != null ? (
          <View style={styles.errorCard}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  )
}

function ModeButton({
  active,
  label,
  onPress,
}: {
  active: boolean
  label: string
  onPress: () => void
}): React.JSX.Element {
  return (
    <Pressable
      style={[styles.chip, active && styles.chipActive]}
      onPress={onPress}>
      <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
        {label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#101217',
  },
  content: {
    padding: 20,
    gap: 20,
  },
  header: {
    gap: 8,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
  },
  subtitle: {
    fontSize: 15,
    lineHeight: 22,
    color: '#c4cad5',
  },
  section: {
    gap: 12,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  actionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  chip: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#202530',
  },
  chipActive: {
    backgroundColor: '#2f80ed',
  },
  chipLabel: {
    color: '#d7dce5',
    fontWeight: '600',
  },
  chipLabelActive: {
    color: '#ffffff',
  },
  primaryButton: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: '#2f80ed',
  },
  primaryButtonLabel: {
    color: '#ffffff',
    fontWeight: '700',
  },
  secondaryButton: {
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 14,
    backgroundColor: '#202530',
  },
  secondaryButtonLabel: {
    color: '#ffffff',
    fontWeight: '700',
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  metaText: {
    color: '#c4cad5',
    lineHeight: 20,
  },
  previewShell: {
    position: 'relative',
    width: '100%',
    maxHeight: 520,
    overflow: 'hidden',
    borderRadius: 20,
    backgroundColor: '#181c24',
  },
  emptyState: {
    flex: 1,
    minHeight: 260,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyStateText: {
    color: '#8d97a8',
    textAlign: 'center',
    lineHeight: 22,
  },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    gap: 10,
  },
  busyText: {
    color: '#ffffff',
    fontWeight: '600',
  },
  resultShell: {
    aspectRatio: 16 / 9,
    overflow: 'hidden',
    borderRadius: 20,
    backgroundColor: '#181c24',
  },
  resultMedia: {
    width: '100%',
    height: '100%',
  },
  resultUri: {
    color: '#9ac2ff',
    lineHeight: 20,
  },
  errorCard: {
    borderRadius: 16,
    padding: 16,
    backgroundColor: 'rgba(190, 52, 85, 0.14)',
  },
  errorText: {
    color: '#ffd3dd',
    lineHeight: 20,
  },
})

export default App