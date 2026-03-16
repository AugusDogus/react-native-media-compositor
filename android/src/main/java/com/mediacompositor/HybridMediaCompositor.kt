package com.mediacompositor

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.util.Size
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import com.margelo.nitro.mediacompositor.HybridMediaCompositorSpec
import com.margelo.nitro.mediacompositor.MediaCompositorImageFormat
import com.margelo.nitro.mediacompositor.MediaCompositorImageRequest
import com.margelo.nitro.mediacompositor.MediaCompositorPreviewSpec
import com.margelo.nitro.mediacompositor.MediaCompositorResult
import com.margelo.nitro.mediacompositor.MediaCompositorStatus
import com.margelo.nitro.mediacompositor.MediaCompositorTextAlign
import com.margelo.nitro.mediacompositor.MediaCompositorTextOverlay
import com.margelo.nitro.mediacompositor.MediaCompositorTextStyle
import com.margelo.nitro.mediacompositor.MediaCompositorVideoRequest
import java.io.File
import java.io.FileOutputStream
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private data class PreviewCropLayout(
  val cropRect: Rect,
  val renderSize: Size
)

private data class OverlayRenderFrame(
  val frame: RectF,
  val scale: Float
)

class HybridMediaCompositor : HybridMediaCompositorSpec() {
  private val stateLock = Any()
  private val mainHandler = Handler(Looper.getMainLooper())
  private var currentStatus: MediaCompositorStatus = MediaCompositorStatus.IDLE
  private var activeTransformer: Transformer? = null

  override val isProcessing: Boolean
    get() = synchronized(stateLock) {
      currentStatus == MediaCompositorStatus.PROCESSING
    }

  override val status: MediaCompositorStatus
    get() = synchronized(stateLock) {
      currentStatus
    }

  override fun composeImage(
    request: MediaCompositorImageRequest
  ): Promise<MediaCompositorResult> {
    beginProcessing()

    return Promise.async {
      try {
        val inputFile = toFile(request.inputPath)
        val outputFile = outputFile(
          requestedPath = request.outputPath,
          fallbackExtension = imageExtension(request)
        )
        val sourceBitmap = BitmapFactory.decodeFile(inputFile.absolutePath)
          ?: throw Error("The input image could not be decoded.")
        val cropLayout = previewCropLayout(
          sourceWidth = sourceBitmap.width,
          sourceHeight = sourceBitmap.height,
          preview = request.preview
        )
        val croppedBitmap = cropBitmap(sourceBitmap, cropLayout?.cropRect)
        val renderedBitmap = renderImageComposition(
          sourceBitmap = croppedBitmap,
          overlays = request.overlays,
          preview = request.preview
        )

        writeBitmap(
          bitmap = renderedBitmap,
          outputFile = outputFile,
          format = request.outputFormat ?: inferImageFormat(outputFile),
          quality = request.quality ?: 0.92
        )

        finishProcessing(MediaCompositorStatus.IDLE)
        MediaCompositorResult(filePath = Uri.fromFile(outputFile).toString())
      } catch (error: Throwable) {
        finishProcessing(statusFor(error))
        throw error
      }
    }
  }

  override fun composeVideo(
    request: MediaCompositorVideoRequest
  ): Promise<MediaCompositorResult> {
    beginProcessing()

    return Promise.async {
      try {
        val context = requireApplicationContext()
        val inputFile = toFile(request.inputPath)
        val outputFile = outputFile(
          requestedPath = request.outputPath,
          fallbackExtension = videoExtension(request)
        )
        val videoSize = readVideoSize(inputFile)
        val cropLayout = previewCropLayout(
          sourceWidth = videoSize.width,
          sourceHeight = videoSize.height,
          preview = request.preview
        )
        val outputSize = cropLayout?.renderSize ?: videoSize
        val overlayBitmap = renderOverlayBitmap(
          frameWidth = outputSize.width,
          frameHeight = outputSize.height,
          overlays = request.overlays,
          preview = request.preview
        )
        val videoEffects = mutableListOf<androidx.media3.common.Effect>()
        if (cropLayout != null) {
          videoEffects += Presentation.createForWidthAndHeight(
            outputSize.width,
            outputSize.height,
            Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP
          )
        }

        val effects = if (overlayBitmap != null) {
          val overlaySettings = StaticOverlaySettings.Builder()
            .setOverlayFrameAnchor(0f, 0f)
            .setBackgroundFrameAnchor(0f, 0f)
            .build()
          val bitmapOverlay = BitmapOverlay.createStaticBitmapOverlay(
            overlayBitmap,
            overlaySettings
          )
          videoEffects += OverlayEffect(listOf(bitmapOverlay))
          Effects(emptyList(), videoEffects)
        } else {
          Effects(emptyList(), videoEffects)
        }

        val mediaItem = MediaItem.fromUri(Uri.fromFile(inputFile))
        val editedMediaItem = EditedMediaItem.Builder(mediaItem)
          .setEffects(effects)
          .setRemoveAudio(!(request.preserveAudio ?: true))
          .build()

        val transformer = runOnMainThread {
          Transformer.Builder(context)
            .setLooper(Looper.getMainLooper())
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .build()
        }

        setActiveTransformer(transformer)
        export(transformer, editedMediaItem, outputFile)
        finishProcessing(MediaCompositorStatus.IDLE)

        MediaCompositorResult(filePath = Uri.fromFile(outputFile).toString())
      } catch (error: Throwable) {
        finishProcessing(statusFor(error))
        throw error
      }
    }
  }

  override fun cancel(): Promise<Unit> {
    val transformer = synchronized(stateLock) {
      val current = activeTransformer
      if (current != null) {
        currentStatus = MediaCompositorStatus.CANCELLED
        activeTransformer = null
      }
      current
    }

    if (transformer != null) {
      mainHandler.post {
        transformer.cancel()
      }
    }
    return Promise.resolved(Unit)
  }

  private fun beginProcessing() {
    synchronized(stateLock) {
      if (currentStatus == MediaCompositorStatus.PROCESSING) {
        throw Error("A media composition operation is already in progress.")
      }
      currentStatus = MediaCompositorStatus.PROCESSING
      activeTransformer = null
    }
  }

  private fun finishProcessing(status: MediaCompositorStatus) {
    synchronized(stateLock) {
      currentStatus = status
      activeTransformer = null
    }
  }

  private fun setActiveTransformer(transformer: Transformer) {
    synchronized(stateLock) {
      activeTransformer = transformer
    }
  }

  private fun requireApplicationContext() =
    NitroModules.applicationContext
      ?: throw Error("ReactApplicationContext is unavailable.")

  private fun toFile(path: String): File {
    val uri = Uri.parse(path)
    if (uri.scheme.isNullOrEmpty() || uri.scheme == "file") {
      return if (uri.path.isNullOrEmpty()) File(path) else File(uri.path!!)
    }
    throw Error("Only local file paths are supported for media composition.")
  }

  private fun outputFile(
    requestedPath: String?,
    fallbackExtension: String
  ): File {
    val file = if (requestedPath != null) {
      toFile(requestedPath)
    } else {
      File.createTempFile(
        "media-compositor-",
        ".$fallbackExtension",
        requireApplicationContext().cacheDir
      )
    }

    file.parentFile?.mkdirs()
    if (file.exists()) {
      file.delete()
    }
    return file
  }

  private fun inferImageFormat(file: File): MediaCompositorImageFormat {
    return if (file.extension.lowercase() == "png") {
      MediaCompositorImageFormat.PNG
    } else {
      MediaCompositorImageFormat.JPG
    }
  }

  private fun imageExtension(request: MediaCompositorImageRequest): String {
    return when (
      request.outputFormat ?: inferImageFormat(
        toFile(request.outputPath ?: request.inputPath)
      )
    ) {
      MediaCompositorImageFormat.JPG -> "jpg"
      MediaCompositorImageFormat.PNG -> "png"
    }
  }

  private fun videoExtension(request: MediaCompositorVideoRequest): String {
    val outputPath = request.outputPath ?: return "mp4"
    return if (outputPath.lowercase().endsWith(".mov")) {
      "mov"
    } else {
      "mp4"
    }
  }

  private fun cropBitmap(
    sourceBitmap: Bitmap,
    cropRect: Rect?
  ): Bitmap {
    val safeCropRect = cropRect ?: return sourceBitmap
    return Bitmap.createBitmap(
      sourceBitmap,
      safeCropRect.left,
      safeCropRect.top,
      safeCropRect.width(),
      safeCropRect.height()
    )
  }

  private fun renderImageComposition(
    sourceBitmap: Bitmap,
    overlays: Array<MediaCompositorTextOverlay>,
    preview: MediaCompositorPreviewSpec?
  ): Bitmap {
    val outputBitmap = sourceBitmap.copy(Bitmap.Config.ARGB_8888, true)
      ?: Bitmap.createBitmap(
        sourceBitmap.width,
        sourceBitmap.height,
        Bitmap.Config.ARGB_8888
      ).also {
        Canvas(it).drawBitmap(sourceBitmap, 0f, 0f, null)
      }

    val overlayBitmap = renderOverlayBitmap(
      frameWidth = outputBitmap.width,
      frameHeight = outputBitmap.height,
      overlays = overlays,
      preview = preview
    ) ?: return outputBitmap

    Canvas(outputBitmap).drawBitmap(overlayBitmap, 0f, 0f, null)
    return outputBitmap
  }

  private fun renderOverlayBitmap(
    frameWidth: Int,
    frameHeight: Int,
    overlays: Array<MediaCompositorTextOverlay>,
    preview: MediaCompositorPreviewSpec?
  ): Bitmap? {
    val drawableOverlays = overlays.filter { it.text.trim().isNotEmpty() }
    if (drawableOverlays.isEmpty()) {
      return null
    }

    val overlayBitmap = Bitmap.createBitmap(
      frameWidth,
      frameHeight,
      Bitmap.Config.ARGB_8888
    )
    val canvas = Canvas(overlayBitmap)

    drawableOverlays.forEach { overlay ->
      val renderFrame = overlayRenderFrame(
        overlay = overlay,
        frameWidth = frameWidth,
        frameHeight = frameHeight,
        preview = preview
      )
      drawTextOverlay(
        canvas = canvas,
        overlay = overlay,
        renderFrame = renderFrame
      )
    }

    return overlayBitmap
  }

  private fun drawTextOverlay(
    canvas: Canvas,
    overlay: MediaCompositorTextOverlay,
    renderFrame: OverlayRenderFrame
  ) {
    val trimmedText = overlay.text.trim()
    if (trimmedText.isEmpty()) {
      return
    }

    val textStyle = overlay.style
    val scale = renderFrame.scale
    val horizontalPadding = max(
      1f,
      ((textStyle.paddingHorizontal ?: 12.0) * scale).toFloat()
    )
    val verticalPadding = max(
      1f,
      ((textStyle.paddingVertical ?: 6.0) * scale).toFloat()
    )
    val cornerRadius = max(0f, ((textStyle.cornerRadius ?: 0.0) * scale).toFloat())
    val fontSize = max(12f, (textStyle.fontSize * scale).toFloat())
    val bubbleRect = RectF(renderFrame.frame)
    val maxTextWidth = max(1, (bubbleRect.width() - horizontalPadding * 2f).roundToInt())
    val opacity = clamp((textStyle.opacity ?: 1.0).toFloat(), 0f, 1f)

    val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
      color = parseColor(textStyle.textColor, opacity)
      textSize = fontSize
      isSubpixelText = true
    }

    val textLayout = StaticLayout.Builder
      .obtain(trimmedText, 0, trimmedText.length, textPaint, maxTextWidth)
      .setAlignment(textAlignment(textStyle))
      .setIncludePad(false)
      .build()

    val bubbleHeight = max(
      bubbleRect.height(),
      textLayout.height + verticalPadding * 2f
    )
    val bubbleTop = min(
      bubbleRect.top,
      frameHeightLimit(canvas, bubbleHeight)
    )
    val adjustedBubbleRect = RectF(
      bubbleRect.left,
      bubbleTop,
      bubbleRect.right,
      bubbleTop + bubbleHeight
    )

    val backgroundColor = parseColor(
      textStyle.backgroundColor ?: "#00000000",
      opacity
    )
    if (Color.alpha(backgroundColor) > 0) {
      val bubblePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = backgroundColor
        style = Paint.Style.FILL
      }
      canvas.drawRoundRect(
        adjustedBubbleRect,
        cornerRadius,
        cornerRadius,
        bubblePaint
      )
    }

    canvas.save()
    canvas.translate(
      adjustedBubbleRect.left + horizontalPadding,
      adjustedBubbleRect.top + verticalPadding
    )
    textLayout.draw(canvas)
    canvas.restore()
  }

  private fun frameHeightLimit(
    canvas: Canvas,
    bubbleHeight: Float
  ): Float {
    return max(0f, canvas.height.toFloat() - bubbleHeight)
  }

  private fun overlayRenderFrame(
    overlay: MediaCompositorTextOverlay,
    frameWidth: Int,
    frameHeight: Int,
    preview: MediaCompositorPreviewSpec?
  ): OverlayRenderFrame {
    val width = clamp(
      (overlay.rect.width * frameWidth).toFloat(),
      1f,
      frameWidth.toFloat()
    )
    val height = clamp(
      (overlay.rect.height * frameHeight).toFloat(),
      1f,
      frameHeight.toFloat()
    )
    val left = clamp(
      (overlay.rect.x * frameWidth).toFloat(),
      0f,
      frameWidth - width
    )
    val top = clamp(
      (overlay.rect.y * frameHeight).toFloat(),
      0f,
      frameHeight - height
    )

    val scale = if (preview != null && preview.width > 0.0 && preview.height > 0.0) {
      frameWidth.toFloat() / preview.width.toFloat()
    } else {
      1f
    }

    return OverlayRenderFrame(
      frame = RectF(left, top, left + width, top + height),
      scale = scale
    )
  }

  private fun previewCropLayout(
    sourceWidth: Int,
    sourceHeight: Int,
    preview: MediaCompositorPreviewSpec?
  ): PreviewCropLayout? {
    val previewWidth = preview?.width ?: return null
    val previewHeight = preview.height
    if (previewWidth <= 0.0 || previewHeight <= 0.0 || sourceWidth <= 0 || sourceHeight <= 0) {
      return null
    }

    val previewAspect = previewWidth / previewHeight
    val sourceAspect = sourceWidth.toDouble() / sourceHeight.toDouble()

    val cropRect = if (sourceAspect > previewAspect) {
      val cropWidth = (sourceHeight * previewAspect).roundToInt().coerceAtLeast(1)
      Rect(
        ((sourceWidth - cropWidth) / 2.0).roundToInt(),
        0,
        ((sourceWidth + cropWidth) / 2.0).roundToInt(),
        sourceHeight
      )
    } else {
      val cropHeight = (sourceWidth / previewAspect).roundToInt().coerceAtLeast(1)
      Rect(
        0,
        ((sourceHeight - cropHeight) / 2.0).roundToInt(),
        sourceWidth,
        ((sourceHeight + cropHeight) / 2.0).roundToInt()
      )
    }

    return PreviewCropLayout(
      cropRect = cropRect,
      renderSize = Size(cropRect.width(), cropRect.height())
    )
  }

  private fun writeBitmap(
    bitmap: Bitmap,
    outputFile: File,
    format: MediaCompositorImageFormat,
    quality: Double
  ) {
    val compressFormat = when (format) {
      MediaCompositorImageFormat.JPG -> Bitmap.CompressFormat.JPEG
      MediaCompositorImageFormat.PNG -> Bitmap.CompressFormat.PNG
    }
    val outputQuality = clamp(quality.toFloat(), 0.1f, 1f)
    FileOutputStream(outputFile).use { stream ->
      bitmap.compress(compressFormat, (outputQuality * 100).roundToInt(), stream)
    }
  }

  private fun readVideoSize(inputFile: File): Size {
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(inputFile.absolutePath)
      val width = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
        ?.toIntOrNull()
        ?: throw Error("Failed to read input video width.")
      val height = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
        ?.toIntOrNull()
        ?: throw Error("Failed to read input video height.")
      val rotation = retriever
        .extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
        ?.toIntOrNull() ?: 0

      return if (rotation == 90 || rotation == 270) {
        Size(height, width)
      } else {
        Size(width, height)
      }
    } finally {
      retriever.release()
    }
  }

  private suspend fun export(
    transformer: Transformer,
    editedMediaItem: EditedMediaItem,
    outputFile: File
  ) {
    suspendCoroutine<Unit> { continuation ->
      mainHandler.post {
        val listener = object : Transformer.Listener {
          override fun onCompleted(
            composition: Composition,
            exportResult: ExportResult
          ) {
            continuation.resume(Unit)
          }

          override fun onError(
            composition: Composition,
            exportResult: ExportResult,
            exportException: ExportException
          ) {
            continuation.resumeWithException(exportException)
          }
        }

        try {
          transformer.addListener(listener)
          transformer.start(editedMediaItem, outputFile.absolutePath)
        } catch (error: Throwable) {
          continuation.resumeWithException(error)
        }
      }
    }
  }

  private suspend fun <T> runOnMainThread(block: () -> T): T {
    return suspendCoroutine { continuation ->
      if (Looper.myLooper() == Looper.getMainLooper()) {
        try {
          continuation.resume(block())
        } catch (error: Throwable) {
          continuation.resumeWithException(error)
        }
        return@suspendCoroutine
      }

      mainHandler.post {
        try {
          continuation.resume(block())
        } catch (error: Throwable) {
          continuation.resumeWithException(error)
        }
      }
    }
  }

  private fun statusFor(error: Throwable): MediaCompositorStatus {
    if (error.message?.contains("cancel", ignoreCase = true) == true) {
      return MediaCompositorStatus.CANCELLED
    }
    return MediaCompositorStatus.FAILED
  }

  private fun parseColor(value: String, opacity: Float): Int {
    val baseColor = try {
      Color.parseColor(value)
    } catch (_: IllegalArgumentException) {
      throw Error("The color value \"$value\" is invalid.")
    }

    val alpha = (Color.alpha(baseColor) * clamp(opacity, 0f, 1f)).roundToInt()
    return Color.argb(
      alpha,
      Color.red(baseColor),
      Color.green(baseColor),
      Color.blue(baseColor)
    )
  }

  private fun textAlignment(style: MediaCompositorTextStyle): Layout.Alignment {
    return when (style.textAlign ?: MediaCompositorTextAlign.CENTER) {
      MediaCompositorTextAlign.LEFT -> Layout.Alignment.ALIGN_NORMAL
      MediaCompositorTextAlign.CENTER -> Layout.Alignment.ALIGN_CENTER
      MediaCompositorTextAlign.RIGHT -> Layout.Alignment.ALIGN_OPPOSITE
    }
  }

  private fun clamp(value: Float, minValue: Float, maxValue: Float): Float {
    return max(minValue, min(value, maxValue))
  }
}
