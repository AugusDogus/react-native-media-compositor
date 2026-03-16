# react-native-media-compositor

`react-native-media-compositor` is a Nitro-based React Native module for
burning styled text overlays into local images and videos.

[![Version](https://img.shields.io/npm/v/react-native-media-compositor.svg)](https://www.npmjs.com/package/react-native-media-compositor)
[![Downloads](https://img.shields.io/npm/dm/react-native-media-compositor.svg)](https://www.npmjs.com/package/react-native-media-compositor)
[![License](https://img.shields.io/npm/l/react-native-media-compositor.svg)](https://github.com/augusdogus/react-native-media-compositor/blob/main/LICENSE)

## What it supports today

- Local file input and output on iOS and Android
- Text overlay composition for images
- Text overlay composition for videos
- Preview-to-export crop parity via a `preview` size contract
- Cancellation and basic processing status via the Nitro object

## Current v1 limitations

- Text overlays only
- No remote URLs, asset-library URLs, or streaming inputs
- No timed overlays or animation timeline yet
- No custom fonts, image overlays, or sticker/video overlays yet

## Installation

```bash
bun add react-native-media-compositor react-native-nitro-modules
```

Then regenerate native dependencies in your app as usual:

```bash
cd ios && pod install
```

## API

The package exports:

- `composeImage(request)`
- `composeVideo(request)`
- `cancelComposition()`
- `getMediaCompositor()`

Important request types:

- `MediaCompositorTextOverlay`
- `MediaCompositorNormalizedRect`
- `MediaCompositorPreviewSpec`

## Why `preview` matters

If your UI displays media with `resizeMode="cover"`, the user is looking at a
cropped viewport, not the full source frame. Pass the measured preview size in
the `preview` field so the native compositor can export the same crop the user
saw in the editor.

If you omit `preview`, composition happens against the full source image/video
frame.

## Example

```ts
import { composeVideo } from 'react-native-media-compositor'

const result = await composeVideo({
  inputPath: 'file:///path/to/input.mp4',
  preserveAudio: true,
  preview: {
    width: 320,
    height: 568,
  },
  overlays: [
    {
      id: 'headline',
      text: 'Hello from Nitro',
      rect: {
        x: 0.1,
        y: 0.72,
        width: 0.8,
        height: 0.16,
      },
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
    },
  ],
})

console.log(result.filePath)
```

## Running the example app

```bash
bun install
cd example
bun run pod
bun run ios
# or
bun run android
```

The example app lets you:

- pick a local image or video
- preview it with `cover` cropping
- drag and edit a text overlay
- export the result through the public package API

## Development

```bash
bun run codegen
bun run build
```

Do not hand-edit files under `nitrogen/generated`.

## Credits

Bootstrapped with [create-nitro-module](https://github.com/patrickkabwe/create-nitro-module).
