import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Keyboard,
  PanResponder,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { MediaCompositorNormalizedRect } from 'react-native-media-compositor'

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

interface TextOverlayEditorProps {
  text: string
  rect: MediaCompositorNormalizedRect
  previewWidth: number
  previewHeight: number
  disabled?: boolean
  onChangeText: (text: string) => void
  onChangeRect: (rect: MediaCompositorNormalizedRect) => void
}

export function TextOverlayEditor({
  text,
  rect,
  previewWidth,
  previewHeight,
  disabled = false,
  onChangeText,
  onChangeRect,
}: TextOverlayEditorProps) {
  const inputRef = useRef<TextInput>(null)
  const dragStartRect = useRef(rect)
  const didMoveRef = useRef(false)
  const [isEditing, setIsEditing] = useState(false)
  const [liveRect, setLiveRect] = useState(rect)

  useEffect(() => {
    setLiveRect(rect)
  }, [rect])

  useEffect(() => {
    if (!isEditing) {
      return
    }

    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
    })

    return () => cancelAnimationFrame(frame)
  }, [isEditing])

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () =>
          !disabled && !isEditing && previewWidth > 0 && previewHeight > 0,
        onMoveShouldSetPanResponder: () =>
          !disabled && !isEditing && previewWidth > 0 && previewHeight > 0,
        onPanResponderGrant: () => {
          dragStartRect.current = liveRect
          didMoveRef.current = false
          Keyboard.dismiss()
        },
        onPanResponderMove: (_, gestureState) => {
          if (previewWidth <= 0 || previewHeight <= 0) {
            return
          }

          const nextRect: MediaCompositorNormalizedRect = {
            ...dragStartRect.current,
            x: clamp(
              dragStartRect.current.x + gestureState.dx / previewWidth,
              0,
              1 - dragStartRect.current.width
            ),
            y: clamp(
              dragStartRect.current.y + gestureState.dy / previewHeight,
              0,
              1 - dragStartRect.current.height
            ),
          }

          if (Math.abs(gestureState.dx) > 2 || Math.abs(gestureState.dy) > 2) {
            didMoveRef.current = true
          }

          setLiveRect(nextRect)
          onChangeRect(nextRect)
        },
        onPanResponderRelease: () => {
          if (!didMoveRef.current) {
            setIsEditing(true)
          }
        },
      }),
    [
      disabled,
      isEditing,
      liveRect,
      onChangeRect,
      previewHeight,
      previewWidth,
    ]
  )

  if (previewWidth <= 0 || previewHeight <= 0) {
    return null
  }

  return (
    <View
      style={[
        styles.frame,
        {
          left: liveRect.x * previewWidth,
          top: liveRect.y * previewHeight,
          width: liveRect.width * previewWidth,
          height: liveRect.height * previewHeight,
        },
      ]}
      {...panResponder.panHandlers}>
      {isEditing ? (
        <TextInput
          ref={inputRef}
          value={text}
          multiline
          autoCorrect={false}
          returnKeyType="done"
          style={styles.input}
          onChangeText={onChangeText}
          onBlur={() => {
            Keyboard.dismiss()
            setIsEditing(false)
          }}
        />
      ) : (
        <View style={styles.previewBubble}>
          <Text numberOfLines={4} style={styles.previewText}>
            {text}
          </Text>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.45)',
    borderStyle: 'dashed',
  },
  input: {
    flex: 1,
    color: '#ffffff',
    fontSize: 18,
    textAlign: 'center',
    textAlignVertical: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  previewBubble: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  previewText: {
    color: '#ffffff',
    fontSize: 18,
    textAlign: 'center',
  },
})
