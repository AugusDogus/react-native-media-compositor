# Example App

This example app exercises the public `react-native-media-compositor` API.

It lets you:

- pick a local image or video
- preview it with `cover` cropping
- drag and edit a text overlay
- export the composited result back through the package

## Run it

```sh
bun install
cd example
bun run pod
bun run ios
# or
bun run android
```

## What to verify

- the preview crop matches the exported file
- the text overlay position matches what you dragged in the editor
- image and video exports both complete successfully
- `Cancel` interrupts long-running video exports cleanly
