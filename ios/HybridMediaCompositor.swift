import AVFoundation
import Foundation
import NitroModules
import UIKit

private enum MediaCompositorError: LocalizedError {
  case alreadyProcessing
  case invalidColor(String)
  case invalidOverlayFrame(String)
  case missingVideoTrack
  case missingExportSession
  case cancelled
  case unsupportedImage
  case unsupportedInputPath

  var errorDescription: String? {
    switch self {
    case .alreadyProcessing:
      return "A media composition operation is already in progress."
    case .invalidColor(let value):
      return "The color value \"\(value)\" is invalid."
    case .invalidOverlayFrame(let overlayId):
      return "The overlay frame for \"\(overlayId)\" is invalid."
    case .missingVideoTrack:
      return "The input file does not contain a video track."
    case .missingExportSession:
      return "Failed to create an AVAssetExportSession for the composition export."
    case .cancelled:
      return "The composition export was cancelled."
    case .unsupportedImage:
      return "The input image format is not supported."
    case .unsupportedInputPath:
      return "Only local file paths are supported for media composition."
    }
  }
}

private struct PreviewCropLayout {
  let cropRect: CGRect
  let renderSize: CGSize
}

private struct OverlayRenderFrame {
  let frame: CGRect
  let scale: CGFloat
}

final class HybridMediaCompositor: HybridMediaCompositorSpec {
  private let stateLock = NSLock()
  private var currentStatus: MediaCompositorStatus = .idle
  private var activeExportSession: AVAssetExportSession?

  var isProcessing: Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return currentStatus == .processing
  }

  var status: MediaCompositorStatus {
    stateLock.lock()
    defer { stateLock.unlock() }
    return currentStatus
  }

  func composeImage(
    request: MediaCompositorImageRequest
  ) throws -> Promise<MediaCompositorResult> {
    try beginProcessing()

    return Promise.async {
      do {
        let inputURL = try self.fileURL(from: request.inputPath)
        let outputURL = try self.outputURL(
          requestedPath: request.outputPath,
          fallbackExtension: self.imageExtension(for: request)
        )

        guard let sourceImage = UIImage(contentsOfFile: inputURL.path) else {
          throw MediaCompositorError.unsupportedImage
        }

        let cropLayout = self.previewCropLayout(
          sourceSize: sourceImage.size,
          preview: request.preview
        )
        let croppedImage = self.croppedImage(
          sourceImage: sourceImage,
          cropRect: cropLayout?.cropRect
        )
        let renderedImage = try self.renderImageComposition(
          sourceImage: croppedImage,
          overlays: request.overlays,
          preview: request.preview
        )
        let data = try self.imageData(
          for: renderedImage,
          format: request.outputFormat ?? self.inferImageFormat(from: outputURL),
          quality: request.quality ?? 0.92
        )

        try data.write(to: outputURL, options: .atomic)
        self.finishProcessing(with: .idle)
        return MediaCompositorResult(filePath: outputURL.absoluteString)
      } catch {
        self.finishProcessing(with: self.status(for: error))
        throw error
      }
    }
  }

  func composeVideo(
    request: MediaCompositorVideoRequest
  ) throws -> Promise<MediaCompositorResult> {
    try beginProcessing()

    return Promise.async {
      do {
        let inputURL = try self.fileURL(from: request.inputPath)
        let outputURL = try self.outputURL(
          requestedPath: request.outputPath,
          fallbackExtension: self.videoExtension(for: request)
        )

        let asset = AVURLAsset(url: inputURL)
        let videoTracks = try await asset.loadTracks(withMediaType: .video)
        guard let sourceVideoTrack = videoTracks.first else {
          throw MediaCompositorError.missingVideoTrack
        }

        let composition = AVMutableComposition()
        let duration = try await asset.load(.duration)
        let timeRange = CMTimeRange(start: .zero, duration: duration)

        guard
          let compositionVideoTrack = composition.addMutableTrack(
            withMediaType: .video,
            preferredTrackID: kCMPersistentTrackID_Invalid
          )
        else {
          throw MediaCompositorError.missingVideoTrack
        }

        try compositionVideoTrack.insertTimeRange(
          timeRange,
          of: sourceVideoTrack,
          at: .zero
        )

        let preferredTransform = try await sourceVideoTrack.load(.preferredTransform)
        compositionVideoTrack.preferredTransform = preferredTransform

        if request.preserveAudio ?? true {
          let audioTracks = try await asset.loadTracks(withMediaType: .audio)
          if let sourceAudioTrack = audioTracks.first,
             let compositionAudioTrack = composition.addMutableTrack(
               withMediaType: .audio,
               preferredTrackID: kCMPersistentTrackID_Invalid
             ) {
            try compositionAudioTrack.insertTimeRange(
              timeRange,
              of: sourceAudioTrack,
              at: .zero
            )
          }
        }

        let naturalSize = try await sourceVideoTrack.load(.naturalSize)
        let renderSize = self.renderSize(
          for: naturalSize,
          preferredTransform: preferredTransform
        )
        let cropLayout = self.previewCropLayout(
          sourceSize: renderSize,
          preview: request.preview
        )
        let outputRenderSize = cropLayout?.renderSize ?? renderSize

        let videoComposition = AVMutableVideoComposition()
        videoComposition.renderSize = outputRenderSize
        videoComposition.frameDuration = self.frameDuration(for: sourceVideoTrack)

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = timeRange

        let layerInstruction = AVMutableVideoCompositionLayerInstruction(
          assetTrack: compositionVideoTrack
        )
        let cropTransform = self.cropTransform(
          preferredTransform: preferredTransform,
          cropRect: cropLayout?.cropRect
        )
        layerInstruction.setTransform(cropTransform, at: .zero)
        instruction.layerInstructions = [layerInstruction]
        videoComposition.instructions = [instruction]

        let parentLayer = CALayer()
        parentLayer.frame = CGRect(origin: .zero, size: outputRenderSize)

        let videoLayer = CALayer()
        videoLayer.frame = parentLayer.frame
        parentLayer.addSublayer(videoLayer)

        if let overlayImage = try self.renderOverlayCanvas(
          size: outputRenderSize,
          overlays: request.overlays,
          preview: request.preview
        ) {
          let overlayLayer = CALayer()
          overlayLayer.frame = parentLayer.frame
          overlayLayer.contents = overlayImage.cgImage
          overlayLayer.contentsGravity = .resize
          parentLayer.addSublayer(overlayLayer)
        }

        videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
          postProcessingAsVideoLayer: videoLayer,
          in: parentLayer
        )

        guard let exportSession = AVAssetExportSession(
          asset: composition,
          presetName: AVAssetExportPresetHighestQuality
        ) else {
          throw MediaCompositorError.missingExportSession
        }

        exportSession.outputURL = outputURL
        exportSession.outputFileType = self.outputFileType(for: outputURL)
        exportSession.shouldOptimizeForNetworkUse = false
        exportSession.videoComposition = videoComposition

        self.setActiveExportSession(exportSession)
        try await self.export(session: exportSession)
        self.finishProcessing(with: .idle)

        return MediaCompositorResult(filePath: outputURL.absoluteString)
      } catch {
        self.finishProcessing(with: self.status(for: error))
        throw error
      }
    }
  }

  func cancel() throws -> Promise<Void> {
    let exportSession: AVAssetExportSession? = stateLock.withLock {
      let session = activeExportSession
      if session != nil {
        currentStatus = .cancelled
        activeExportSession = nil
      }
      return session
    }

    exportSession?.cancelExport()
    return Promise.resolved()
  }

  private func beginProcessing() throws {
    try stateLock.withLock {
      if currentStatus == .processing {
        throw MediaCompositorError.alreadyProcessing
      }
      currentStatus = .processing
      activeExportSession = nil
    }
  }

  private func finishProcessing(with status: MediaCompositorStatus) {
    stateLock.withLock {
      currentStatus = status
      activeExportSession = nil
    }
  }

  private func setActiveExportSession(_ exportSession: AVAssetExportSession) {
    stateLock.withLock {
      activeExportSession = exportSession
    }
  }

  private func status(for error: Error) -> MediaCompositorStatus {
    if let compositorError = error as? MediaCompositorError,
       case .cancelled = compositorError {
      return .cancelled
    }

    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
      return .cancelled
    }

    return .failed
  }

  private func export(session: AVAssetExportSession) async throws {
    try await withCheckedThrowingContinuation { continuation in
      session.exportAsynchronously {
        switch session.status {
        case .completed:
          continuation.resume()
        case .cancelled:
          continuation.resume(throwing: MediaCompositorError.cancelled)
        case .failed:
          continuation.resume(
            throwing: session.error ?? MediaCompositorError.missingExportSession
          )
        default:
          continuation.resume(
            throwing: session.error ?? MediaCompositorError.missingExportSession
          )
        }
      }
    }
  }

  private func renderImageComposition(
    sourceImage: UIImage,
    overlays: [MediaCompositorTextOverlay],
    preview: MediaCompositorPreviewSpec?
  ) throws -> UIImage {
    let sourceSize = sourceImage.size
    let overlayImage = try renderOverlayCanvas(
      size: sourceSize,
      overlays: overlays,
      preview: preview
    )
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = sourceImage.scale

    let renderer = UIGraphicsImageRenderer(size: sourceSize, format: format)
    return renderer.image { _ in
      sourceImage.draw(in: CGRect(origin: .zero, size: sourceSize))
      overlayImage?.draw(in: CGRect(origin: .zero, size: sourceSize))
    }
  }

  private func renderOverlayCanvas(
    size: CGSize,
    overlays: [MediaCompositorTextOverlay],
    preview: MediaCompositorPreviewSpec?
  ) throws -> UIImage? {
    let drawableOverlays = overlays.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    if drawableOverlays.isEmpty {
      return nil
    }

    let format = UIGraphicsImageRendererFormat.default()
    format.opaque = false
    format.scale = 1

    let renderer = UIGraphicsImageRenderer(size: size, format: format)
    return try renderer.image { _ in
      for overlay in drawableOverlays {
        let renderFrame = try self.overlayRenderFrame(
          rect: overlay.rect,
          renderSize: size,
          preview: preview,
          overlayId: overlay.id
        )
        try self.drawTextOverlay(overlay, in: renderFrame.frame, scale: renderFrame.scale)
      }
    }
  }

  private func drawTextOverlay(
    _ overlay: MediaCompositorTextOverlay,
    in frame: CGRect,
    scale: CGFloat
  ) throws {
    let trimmedText = overlay.text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmedText.isEmpty {
      return
    }

    let style = overlay.style
    let textColor = try color(
      from: style.textColor,
      opacity: style.opacity ?? 1
    )
    let backgroundColor = try color(
      from: style.backgroundColor ?? "#00000000",
      opacity: style.opacity ?? 1
    )

    let horizontalPadding = CGFloat(style.paddingHorizontal ?? 12) * scale
    let verticalPadding = CGFloat(style.paddingVertical ?? 6) * scale
    let cornerRadius = CGFloat(style.cornerRadius ?? 0) * scale
    let fontSize = max(CGFloat(style.fontSize) * scale, 12)
    let maxTextWidth = max(1, frame.width - horizontalPadding * 2)

    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.alignment = textAlignment(for: style.textAlign ?? .center)
    paragraphStyle.lineBreakMode = .byWordWrapping

    let attributes: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: fontSize, weight: .regular),
      .foregroundColor: textColor,
      .paragraphStyle: paragraphStyle,
    ]

    let attributedText = NSAttributedString(string: trimmedText, attributes: attributes)
    let textBounds = attributedText.boundingRect(
      with: CGSize(width: maxTextWidth, height: .greatestFiniteMagnitude),
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil
    ).integral

    let bubbleHeight = max(frame.height, ceil(textBounds.height) + verticalPadding * 2)
    let bubbleY = min(frame.minY, max(0, frame.maxY - bubbleHeight))
    let bubbleRect = CGRect(
      x: frame.minX,
      y: bubbleY,
      width: frame.width,
      height: bubbleHeight
    )
    let textRect = CGRect(
      x: bubbleRect.minX + horizontalPadding,
      y: bubbleRect.minY + verticalPadding,
      width: maxTextWidth,
      height: bubbleRect.height - verticalPadding * 2
    )

    if backgroundColor.cgColor.alpha > 0 {
      let bubblePath = UIBezierPath(
        roundedRect: bubbleRect,
        cornerRadius: cornerRadius
      )
      backgroundColor.setFill()
      bubblePath.fill()
    }

    attributedText.draw(
      with: textRect,
      options: [.usesLineFragmentOrigin, .usesFontLeading],
      context: nil
    )
  }

  private func overlayRenderFrame(
    rect: MediaCompositorNormalizedRect,
    renderSize: CGSize,
    preview: MediaCompositorPreviewSpec?,
    overlayId: String
  ) throws -> OverlayRenderFrame {
    guard
      renderSize.width > 0,
      renderSize.height > 0,
      rect.width > 0,
      rect.height > 0
    else {
      throw MediaCompositorError.invalidOverlayFrame(overlayId)
    }

    let width = min(max(CGFloat(rect.width) * renderSize.width, 1), renderSize.width)
    let height = min(max(CGFloat(rect.height) * renderSize.height, 1), renderSize.height)
    let x = clamped(CGFloat(rect.x) * renderSize.width, lower: 0, upper: renderSize.width - width)
    let y = clamped(CGFloat(rect.y) * renderSize.height, lower: 0, upper: renderSize.height - height)

    let scale: CGFloat
    if let preview, preview.width > 0, preview.height > 0 {
      scale = renderSize.width / CGFloat(preview.width)
    } else {
      scale = 1
    }

    return OverlayRenderFrame(
      frame: CGRect(x: x, y: y, width: width, height: height),
      scale: scale
    )
  }

  private func croppedImage(
    sourceImage: UIImage,
    cropRect: CGRect?
  ) -> UIImage {
    guard let cropRect else {
      return sourceImage
    }

    let format = UIGraphicsImageRendererFormat.default()
    format.scale = sourceImage.scale

    let renderer = UIGraphicsImageRenderer(size: cropRect.size, format: format)
    return renderer.image { _ in
      sourceImage.draw(
        in: CGRect(
          x: -cropRect.minX,
          y: -cropRect.minY,
          width: sourceImage.size.width,
          height: sourceImage.size.height
        )
      )
    }
  }

  private func imageData(
    for image: UIImage,
    format: MediaCompositorImageFormat,
    quality: Double
  ) throws -> Data {
    switch format {
    case .jpg:
      guard let data = image.jpegData(
        compressionQuality: clamped(quality, lower: 0.1, upper: 1)
      ) else {
        throw MediaCompositorError.unsupportedImage
      }
      return data
    case .png:
      guard let data = image.pngData() else {
        throw MediaCompositorError.unsupportedImage
      }
      return data
    }
  }

  private func fileURL(from path: String) throws -> URL {
    guard let url = URL(string: path), url.scheme != nil else {
      return URL(fileURLWithPath: path)
    }
    guard url.isFileURL else {
      throw MediaCompositorError.unsupportedInputPath
    }
    return url
  }

  private func outputURL(
    requestedPath: String?,
    fallbackExtension: String
  ) throws -> URL {
    let fileManager = FileManager.default
    let url: URL

    if let requestedPath {
      let resolvedURL = try fileURL(from: requestedPath)
      let parentURL = resolvedURL.deletingLastPathComponent()
      try fileManager.createDirectory(
        at: parentURL,
        withIntermediateDirectories: true,
        attributes: nil
      )
      url = resolvedURL
    } else {
      let fileName = "media-compositor-\(UUID().uuidString).\(fallbackExtension)"
      url = fileManager.temporaryDirectory.appendingPathComponent(fileName)
    }

    if fileManager.fileExists(atPath: url.path) {
      try fileManager.removeItem(at: url)
    }

    return url
  }

  private func inferImageFormat(from url: URL) -> MediaCompositorImageFormat {
    if url.pathExtension.lowercased() == "png" {
      return .png
    }
    return .jpg
  }

  private func imageExtension(for request: MediaCompositorImageRequest) -> String {
    switch request.outputFormat ?? inferImageFormat(from: URL(fileURLWithPath: request.inputPath)) {
    case .jpg:
      return "jpg"
    case .png:
      return "png"
    }
  }

  private func videoExtension(for request: MediaCompositorVideoRequest) -> String {
    guard let outputPath = request.outputPath else {
      return "mp4"
    }

    let resolvedExtension = URL(fileURLWithPath: outputPath).pathExtension.lowercased()
    return resolvedExtension == "mov" ? "mov" : "mp4"
  }

  private func outputFileType(for url: URL) -> AVFileType {
    switch url.pathExtension.lowercased() {
    case "mov":
      return .mov
    default:
      return .mp4
    }
  }

  private func renderSize(
    for naturalSize: CGSize,
    preferredTransform: CGAffineTransform
  ) -> CGSize {
    let transformedRect = CGRect(origin: .zero, size: naturalSize).applying(preferredTransform)
    return CGSize(
      width: abs(transformedRect.width),
      height: abs(transformedRect.height)
    )
  }

  private func previewCropLayout(
    sourceSize: CGSize,
    preview: MediaCompositorPreviewSpec?
  ) -> PreviewCropLayout? {
    guard
      let preview,
      preview.width > 0,
      preview.height > 0,
      sourceSize.width > 0,
      sourceSize.height > 0
    else {
      return nil
    }

    let previewAspectRatio = CGFloat(preview.width / preview.height)
    let sourceAspectRatio = sourceSize.width / sourceSize.height

    if abs(sourceAspectRatio - previewAspectRatio) < 0.0001 {
      return PreviewCropLayout(
        cropRect: CGRect(origin: .zero, size: sourceSize),
        renderSize: sourceSize
      )
    }

    let cropRect: CGRect
    if sourceAspectRatio > previewAspectRatio {
      let cropWidth = sourceSize.height * previewAspectRatio
      cropRect = CGRect(
        x: (sourceSize.width - cropWidth) / 2,
        y: 0,
        width: cropWidth,
        height: sourceSize.height
      )
    } else {
      let cropHeight = sourceSize.width / previewAspectRatio
      cropRect = CGRect(
        x: 0,
        y: (sourceSize.height - cropHeight) / 2,
        width: sourceSize.width,
        height: cropHeight
      )
    }

    return PreviewCropLayout(cropRect: cropRect, renderSize: cropRect.size)
  }

  private func cropTransform(
    preferredTransform: CGAffineTransform,
    cropRect: CGRect?
  ) -> CGAffineTransform {
    guard let cropRect else {
      return preferredTransform
    }

    let cropTranslation = CGAffineTransform(
      translationX: -cropRect.minX,
      y: -cropRect.minY
    )
    return preferredTransform.concatenating(cropTranslation)
  }

  private func frameDuration(for videoTrack: AVAssetTrack) -> CMTime {
    let nominalFrameRate = videoTrack.nominalFrameRate
    if nominalFrameRate > 0 {
      return CMTime(
        value: 1,
        timescale: CMTimeScale(nominalFrameRate.rounded())
      )
    }
    return CMTime(value: 1, timescale: 30)
  }

  private func textAlignment(for alignment: MediaCompositorTextAlign) -> NSTextAlignment {
    switch alignment {
    case .left:
      return .left
    case .center:
      return .center
    case .right:
      return .right
    }
  }

  private func color(
    from hex: String,
    opacity: Double
  ) throws -> UIColor {
    let sanitized = hex
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .replacingOccurrences(of: "#", with: "")
    let scanner = Scanner(string: sanitized)
    var value: UInt64 = 0

    guard scanner.scanHexInt64(&value) else {
      throw MediaCompositorError.invalidColor(hex)
    }

    let baseColor: UIColor
    switch sanitized.count {
    case 6:
      baseColor = UIColor(
        red: CGFloat((value & 0xFF0000) >> 16) / 255,
        green: CGFloat((value & 0x00FF00) >> 8) / 255,
        blue: CGFloat(value & 0x0000FF) / 255,
        alpha: 1
      )
    case 8:
      baseColor = UIColor(
        red: CGFloat((value & 0xFF000000) >> 24) / 255,
        green: CGFloat((value & 0x00FF0000) >> 16) / 255,
        blue: CGFloat((value & 0x0000FF00) >> 8) / 255,
        alpha: CGFloat(value & 0x000000FF) / 255
      )
    default:
      throw MediaCompositorError.invalidColor(hex)
    }

    let clampedOpacity = CGFloat(clamped(opacity, lower: 0, upper: 1))
    return baseColor.withAlphaComponent(baseColor.cgColor.alpha * clampedOpacity)
  }

  private func clamped<T: Comparable>(
    _ value: T,
    lower: T,
    upper: T
  ) -> T {
    min(max(value, lower), upper)
  }
}

private extension NSLock {
  func withLock<T>(_ operation: () throws -> T) rethrows -> T {
    lock()
    defer { unlock() }
    return try operation()
  }
}
