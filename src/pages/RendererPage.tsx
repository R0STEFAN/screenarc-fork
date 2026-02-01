import log from 'electron-log/renderer'
import { useEffect, useRef } from 'react'
import { useEditorStore } from '../store/editorStore'
import { EditorState, EditorActions, CursorTheme, CursorFrame, CursorImageBitmap } from '../types'
import { ExportSettings } from '../components/editor/ExportModal'
import { RESOLUTIONS } from '../lib/constants'
import { PixiRenderer } from '../lib/renderer-gl'
import { prepareCursorBitmaps, mapExportTimeToSourceTime } from '../lib/utils'

type RenderStartPayload = {
  projectState: Omit<EditorState, keyof EditorActions>
  exportSettings: ExportSettings
}

type VideoFrameProvider = {
  getFrameForTime: (timeSec: number) => Promise<VideoFrame | null>
  close: () => void
}

async function createVideoFrameProvider(videoPath: string): Promise<VideoFrameProvider> {
  if (!('VideoDecoder' in window)) {
    throw new Error('VideoDecoder is not available in this context.')
  }

  let MP4Box: any
  try {
    const mod: any = await import('mp4box')
    MP4Box = mod?.default ?? mod
  } catch (e) {
    throw new Error('Failed to import mp4box module.')
  }

  if (!MP4Box?.createFile) {
    throw new Error('MP4Box.createFile is unavailable.')
  }

  const mp4boxfile = MP4Box.createFile()
  const frameQueue: VideoFrame[] = []
  const waiters: Array<(frame: VideoFrame | null) => void> = []
  let decoder: any = null
  let timescale = 1
  let closed = false
  let lastFrame: VideoFrame | null = null
  let nextFrame: VideoFrame | null = null

  const buildAvcCRecord = (avcC: any): Uint8Array | undefined => {
    if (!avcC) return undefined
    const spsList = Array.isArray(avcC.SPS) ? avcC.SPS : []
    const ppsList = Array.isArray(avcC.PPS) ? avcC.PPS : []
    const ext = avcC.ext instanceof Uint8Array ? avcC.ext : undefined

    let size = 6 + 1
    for (const sps of spsList) size += 2 + (sps?.data?.length || 0)
    size += 1
    for (const pps of ppsList) size += 2 + (pps?.data?.length || 0)
    if (ext) size += ext.length

    const out = new Uint8Array(size)
    let offset = 0
    out[offset++] = avcC.configurationVersion ?? 1
    out[offset++] = avcC.AVCProfileIndication ?? 0
    out[offset++] = avcC.profile_compatibility ?? 0
    out[offset++] = avcC.AVCLevelIndication ?? 0
    out[offset++] = 0xfc | (avcC.lengthSizeMinusOne ?? 3)
    out[offset++] = 0xe0 | (avcC.nb_SPS_nalus ?? spsList.length)
    for (const sps of spsList) {
      const data = sps?.data || new Uint8Array()
      out[offset++] = (data.length >> 8) & 0xff
      out[offset++] = data.length & 0xff
      out.set(data, offset)
      offset += data.length
    }
    out[offset++] = avcC.nb_PPS_nalus ?? ppsList.length
    for (const pps of ppsList) {
      const data = pps?.data || new Uint8Array()
      out[offset++] = (data.length >> 8) & 0xff
      out[offset++] = data.length & 0xff
      out.set(data, offset)
      offset += data.length
    }
    if (ext) {
      out.set(ext, offset)
    }
    return out
  }

  const extractDescriptionFromIsoFile = (isoFile: any, trackId: number): Uint8Array | undefined => {
    try {
      const trak = isoFile?.getTrackById?.(trackId)
      const entry = trak?.mdia?.minf?.stbl?.stsd?.entries?.[0]
      if (entry?.avcC) return buildAvcCRecord(entry.avcC)
      if (entry?.hvcC?.data) return new Uint8Array(entry.hvcC.data)
    } catch (e) {
      log.warn('[RendererPage] Failed to extract decoder description from ISOFile:', e)
    }
    return undefined
  }

  const getDecoderDescription = (track: any, isoFile: any): Uint8Array | undefined => {
    const isAvc = typeof track?.codec === 'string' && (track.codec.startsWith('avc1') || track.codec.startsWith('avc3'))
    const isHevc = typeof track?.codec === 'string' && (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1'))
    if (!isAvc && !isHevc) return undefined

    const desc =
      track?.avcC ||
      track?.hvcC ||
      track?.description ||
      track?.decoderConfig?.description ||
      track?.sampleDescriptions?.[0]?.avcC ||
      track?.sampleDescriptions?.[0]?.hvcC

    if (!desc) {
      return extractDescriptionFromIsoFile(isoFile, track?.id)
    }

    if (desc instanceof Uint8Array) return desc
    if (desc instanceof ArrayBuffer) return new Uint8Array(desc)
    if (desc?.buffer instanceof ArrayBuffer) return new Uint8Array(desc.buffer)
    if (ArrayBuffer.isView(desc)) return new Uint8Array(desc.buffer)
    if (typeof desc?.data?.length === 'number') return new Uint8Array(desc.data)
    return undefined
  }

  const pushFrame = (frame: VideoFrame) => {
    if (waiters.length > 0) {
      const waiter = waiters.shift()
      if (waiter) waiter(frame)
    } else {
      frameQueue.push(frame)
    }
  }

  const pullFrame = () =>
    new Promise<VideoFrame | null>((resolve) => {
      if (frameQueue.length > 0) return resolve(frameQueue.shift()!)
      if (closed) return resolve(null)
      waiters.push(resolve)
    })

  const ready = new Promise<void>((resolve, reject) => {
    mp4boxfile.onReady = (info: any) => {
      try {
        const track = info.videoTracks?.[0]
        if (!track) throw new Error('No video track found in MP4')
        timescale = track.timescale || 1

        decoder = new VideoDecoder({
          output: (frame: VideoFrame) => pushFrame(frame),
          error: (err) => log.error('[RendererPage] VideoDecoder error:', err),
        })

        const description = getDecoderDescription(track, mp4boxfile)
        const isAvc = typeof track?.codec === 'string' && (track.codec.startsWith('avc1') || track.codec.startsWith('avc3'))
        const isHevc = typeof track?.codec === 'string' && (track.codec.startsWith('hvc1') || track.codec.startsWith('hev1'))
        if ((isAvc || isHevc) && !description) {
          const trackKeys = Object.keys(track || {})
          const sampleDescKeys = Object.keys(track?.sampleDescriptions?.[0] || {})
          throw new Error(
            `Missing codec description (avcC/hvcC). codec=${track.codec}, trackKeys=${trackKeys.join(',')}, sampleDescriptionKeys=${sampleDescKeys.join(',')}`,
          )
        }
        decoder.configure({
          codec: track.codec,
          codedWidth: track.video?.width,
          codedHeight: track.video?.height,
          description,
        })

        mp4boxfile.setExtractionOptions(track.id, null, { nbSamples: 1 })
        mp4boxfile.start()
        resolve()
      } catch (err) {
        reject(err)
      }
    }

    mp4boxfile.onError = (err: any) => reject(err)

    let hasKeyframe = false
    mp4boxfile.onSamples = (_id: any, _user: any, samples: any[]) => {
      if (!decoder) return
      for (const sample of samples) {
        if (!hasKeyframe) {
          if (!sample.is_sync) continue
          hasKeyframe = true
        }
        const timestamp = Math.round((sample.cts * 1e6) / timescale)
        const duration = Math.round((sample.duration * 1e6) / timescale)
        // @ts-ignore
        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? 'key' : 'delta',
          timestamp,
          duration,
          data: sample.data,
        })
        decoder.decode(chunk)
      }
    }
  })

  try {
    const buffer = await window.electronAPI.readFileBuffer(videoPath)
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    ;(arrayBuffer as any).fileStart = 0
    mp4boxfile.appendBuffer(arrayBuffer)
    await ready
    mp4boxfile.flush()
    decoder?.flush().finally(() => {
      closed = true
      while (waiters.length > 0) {
        const waiter = waiters.shift()
        if (waiter) waiter(null)
      }
    })
  } catch (e) {
    log.warn('[RendererPage] Failed to initialize MP4Box/VideoDecoder:', e)
    try {
      decoder?.close()
    } catch {}
    throw e instanceof Error ? e : new Error('Failed to initialize MP4Box/VideoDecoder.')
  }

  const getFrameForTime = async (timeSec: number): Promise<VideoFrame | null> => {
    const targetUs = Math.round(timeSec * 1e6)

    if (!nextFrame) {
      nextFrame = await pullFrame()
    }

    while (nextFrame && (nextFrame.timestamp ?? 0) < targetUs) {
      if (lastFrame && lastFrame !== nextFrame) lastFrame.close()
      lastFrame = nextFrame
      nextFrame = await pullFrame()
    }

    return lastFrame ?? nextFrame ?? null
  }

  const close = () => {
    closed = true
    while (frameQueue.length > 0) {
      const frame = frameQueue.shift()
      frame?.close()
    }
    if (lastFrame) lastFrame.close()
    if (nextFrame && nextFrame !== lastFrame) nextFrame.close()
    if (decoder && decoder.state !== 'closed') decoder.close()
    if (typeof mp4boxfile.stop === 'function') mp4boxfile.stop()
  }

  return { getFrameForTime, close }
}

// These are needed to regenerate bitmaps within the renderer worker context.
async function prepareWindowsCursorBitmaps(theme: CursorTheme, scale: number): Promise<Map<string, CursorImageBitmap>> {
  const bitmapMap = new Map<string, CursorImageBitmap>()
  const cursorSet = theme[scale]
  if (!cursorSet) {
    log.warn(`[RendererPage] No cursor set found for scale ${scale}x`)
    return bitmapMap
  }
  const processingPromises: Promise<void>[] = []
  for (const cursorThemeName in cursorSet) {
    const frames = cursorSet[cursorThemeName]
    processingPromises.push(
      (async () => {
        const idcName = await window.electronAPI.mapCursorNameToIDC(cursorThemeName)
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i] as CursorFrame
          if (frame.rgba && frame.width > 0 && frame.height > 0) {
            try {
              const buffer = new Uint8ClampedArray(Object.values(frame.rgba))
              const imageData = new ImageData(buffer, frame.width, frame.height)
              const bitmap = await createImageBitmap(imageData)
              const key = `${idcName}-${i}`
              bitmapMap.set(key, { ...frame, imageBitmap: bitmap })
            } catch (e) {
              log.error(`[RendererPage] Failed to create bitmap for ${idcName}-${i}`, e)
            }
          }
        }
      })(),
    )
  }
  await Promise.all(processingPromises)
  return bitmapMap
}

async function prepareMacOSCursorBitmaps(theme: CursorTheme, scale: number): Promise<Map<string, CursorImageBitmap>> {
  const bitmapMap = new Map<string, CursorImageBitmap>()
  const cursorSet = theme[scale]
  if (!cursorSet) {
    log.warn(`[RendererPage] No cursor set found for scale ${scale}x`)
    return bitmapMap
  }
  const processingPromises: Promise<void>[] = []
  for (const cursorThemeName in cursorSet) {
    const frames = cursorSet[cursorThemeName]
    processingPromises.push(
      (async () => {
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i] as CursorFrame
          if (frame.rgba && frame.width > 0 && frame.height > 0) {
            try {
              const buffer = new Uint8ClampedArray(Object.values(frame.rgba))
              const imageData = new ImageData(buffer, frame.width, frame.height)
              const bitmap = await createImageBitmap(imageData)
              const key = `${cursorThemeName}-${i}`
              bitmapMap.set(key, { ...frame, imageBitmap: bitmap })
            } catch (e) {
              log.error(`[RendererPage] Failed to create bitmap for ${cursorThemeName}-${i}`, e)
            }
          }
        }
      })(),
    )
  }
  await Promise.all(processingPromises)
  return bitmapMap
}

// Helper to pre-load an image for the renderer worker
const loadBackgroundImage = (
  background: EditorState['frameStyles']['background'],
): Promise<HTMLImageElement | null> => {
  return new Promise((resolve) => {
    if ((background.type !== 'image' && background.type !== 'wallpaper') || !background.imageUrl) {
      resolve(null)
      return
    }
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => {
      log.error(`[RendererPage] Failed to load background image for export: ${img.src}`)
      resolve(null) // Resolve with null on error to not block rendering
    }
    const finalUrl = background.imageUrl.startsWith('blob:') ? background.imageUrl : `media://${background.imageUrl}`
    img.src = finalUrl
  })
}

export function RendererPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const webcamVideoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    log.info('[RendererPage] Component mounted. Setting up listeners.')

    const cleanup = window.electronAPI.onRenderStart(async ({ projectState, exportSettings }: RenderStartPayload) => {
      const canvas = canvasRef.current
      const video = videoRef.current
      const webcamVideo = webcamVideoRef.current
      let frameProvider: VideoFrameProvider | null = null
      let webcamFrameProvider: VideoFrameProvider | null = null

      try {
        log.info('[RendererPage] Received "render:start" event.', { exportSettings })
        if (!canvas || !video) throw new Error('Canvas or Video ref is not available.')

        // --- 1. SETUP CANVAS AND CONTEXT ---
        const { resolution, fps } = exportSettings
        const [ratioW, ratioH] = projectState.aspectRatio.split(':').map(Number)
        const baseHeight = RESOLUTIONS[resolution as keyof typeof RESOLUTIONS].height
        let outputWidth = Math.round(baseHeight * (ratioW / ratioH))
        outputWidth = outputWidth % 2 === 0 ? outputWidth : outputWidth + 1
        const outputHeight = baseHeight

        canvas.width = outputWidth
        canvas.height = outputHeight
        // const ctx = canvas.getContext('2d', { alpha: false })
        // if (!ctx) throw new Error('Failed to get 2D context from canvas.')
        const pixiRenderer = new PixiRenderer({ canvas, width: outputWidth, height: outputHeight })

        // --- 2. PREPARE STATE AND ASSETS ---
        useEditorStore.setState(projectState)
        let finalCursorBitmaps = new Map<string, CursorImageBitmap>()
        if (projectState.platform === 'win32' || projectState.platform === 'darwin') {
          if (projectState.cursorTheme) {
            const scale = (await window.electronAPI.getSetting<number>('recorder.cursorScale')) || 2
            log.info(`[RendererPage] Regenerating bitmaps for ${projectState.platform} at scale ${scale}x`)
            if (projectState.platform === 'win32') {
              finalCursorBitmaps = await prepareWindowsCursorBitmaps(projectState.cursorTheme, scale)
            } else {
              finalCursorBitmaps = await prepareMacOSCursorBitmaps(projectState.cursorTheme, scale)
            }
          }
        } else {
          log.info('[RendererPage] Preparing Linux bitmaps from project state.')
          finalCursorBitmaps = await prepareCursorBitmaps(projectState.cursorImages)
        }
        const projectStateWithCursorBitmaps = { ...projectState, cursorBitmapsToRender: finalCursorBitmaps }
        const bgImage = await loadBackgroundImage(projectState.frameStyles.background)

        // --- 2.5 SETUP VIDEO DECODER (Optimization) ---
        frameProvider = null
        webcamFrameProvider = null
        const isSecure = typeof window !== 'undefined' ? window.isSecureContext : false
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown'
        const hasVideoDecoder = 'VideoDecoder' in window
        const hasVideoEncoder = 'VideoEncoder' in window
        log.info('[RendererPage] WebCodecs availability', {
          isSecure,
          hasVideoDecoder,
          hasVideoEncoder,
          ua,
        })
        if (!hasVideoDecoder) {
          throw new Error(
            `WebCodecs VideoDecoder is unavailable (secureContext=${isSecure}, hasVideoDecoder=${hasVideoDecoder}, hasVideoEncoder=${hasVideoEncoder}, ua=${ua}). Export requires decoder-only mode.`,
          )
        }
        try {
          if (projectStateWithCursorBitmaps.videoPath) {
            frameProvider = await createVideoFrameProvider(projectStateWithCursorBitmaps.videoPath)
            if (frameProvider) log.info('[RendererPage] Using WebCodecs VideoDecoder for main video.')
          }
          if (projectStateWithCursorBitmaps.webcamVideoPath) {
            webcamFrameProvider = await createVideoFrameProvider(projectStateWithCursorBitmaps.webcamVideoPath)
            if (webcamFrameProvider) log.info('[RendererPage] Using WebCodecs VideoDecoder for webcam video.')
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown decoder initialization error'
          throw new Error(
            `Decoder initialization failed (secureContext=${isSecure}, hasVideoDecoder=${hasVideoDecoder}, ua=${ua}): ${msg}`,
          )
        }
        const useDecoder = Boolean(frameProvider)
        const useWebcamDecoder = Boolean(webcamFrameProvider)
        if (!useDecoder) {
          throw new Error(
            `WebCodecs VideoDecoder is unavailable (secureContext=${isSecure}, hasVideoDecoder=${hasVideoDecoder}, ua=${ua}). Export requires decoder-only mode.`,
          )
        }

        // --- 3. LOAD VIDEO SOURCES ---
        const loadVideo = (videoElement: HTMLVideoElement, source: string, path: string): Promise<void> =>
          new Promise((resolve, reject) => {
            videoElement.onloadedmetadata = () => {
              log.info(`[RendererPage] ${source} metadata loaded.`)
              resolve()
            }
            videoElement.onerror = (e) => reject(new Error(`Failed to load ${source}: ${e}`))
            videoElement.src = `media://${path}`
            videoElement.muted = true
            videoElement.load()
          })

        const loadPromises: Promise<void>[] = [loadVideo(video, 'Main video', projectStateWithCursorBitmaps.videoPath!)]
        const hasWebcam = Boolean(projectStateWithCursorBitmaps.webcamVideoPath && typeof projectStateWithCursorBitmaps.webcamVideoPath === 'string')
        if (hasWebcam && webcamVideo) {
          loadPromises.push(loadVideo(webcamVideo, 'Webcam video', projectStateWithCursorBitmaps.webcamVideoPath!))
        }
        await Promise.all(loadPromises)

        const mainDuration = video.duration || projectState.duration
        const webcamDuration = hasWebcam && webcamVideo ? webcamVideo.duration : 0
        const webcamTimeScale =
          hasWebcam && webcamDuration > 0 && mainDuration > 0 ? webcamDuration / mainDuration : 1
        if (hasWebcam) {
          log.info('[RendererPage] Webcam timing sync', {
            mainDuration,
            webcamDuration,
            webcamTimeScale,
          })
        }

        // --- 4. CALCULATE EXPORT DURATION AND FRAMES ---
        const effectiveDuration = mainDuration || projectState.duration
        let exportDuration = effectiveDuration
        Object.values(projectState.cutRegions).forEach((region) => (exportDuration -= region.duration))
        Object.values(projectState.speedRegions).forEach((region) => {
          exportDuration -= region.duration
          exportDuration += region.duration / region.speed
        })
        exportDuration = Math.max(0, exportDuration)
        const totalFrames = Math.floor(exportDuration * fps)
        log.info(
          `[RendererPage] Starting seek-driven rendering. Total frames: ${totalFrames}, Export duration: ${exportDuration.toFixed(2)}s`,
        )

        // --- SETUP ENCODER (Optimization) ---
        let videoEncoder: any = null
        let lastProgress = 0
        const useHardwareEncoding = exportSettings.format === 'mp4' && 'VideoEncoder' in window

        if (useHardwareEncoding) {
          log.info('[RendererPage] Initializing hardware encoder (VideoEncoder)')
          
          const calculateBitrate = (res: string, qual: string, f: number) => {
            const baseBitrates: Record<string, number> = {
              '720p': 5_000_000,
              '1080p': 8_000_000,
              '2k': 14_000_000,
            }
            const qualityMultipliers: Record<string, number> = {
              'low': 0.6,
              'medium': 1.0,
              'high': 2.0, // Significant boost for high quality
            }
            const fpsMultiplier = f >= 60 ? 1.4 : 1.0 // Higher FPS needs more data
            const codecPenalty = 1.3 // Baseline profile needs ~30% more bitrate than High profile

             const base = baseBitrates[res] || 8_000_000
             const qualMult = qualityMultipliers[qual] || 1.0
             
             return Math.floor(base * qualMult * fpsMultiplier * codecPenalty)
          }

          const targetBitrate = calculateBitrate(exportSettings.resolution, exportSettings.quality, fps)
          log.info(`[RendererPage] Configured encoder bitrate: ${(targetBitrate / 1_000_000).toFixed(2)} Mbps`)

          videoEncoder = new (window as any).VideoEncoder({
            output: (chunk: any) => {
              const buffer = new ArrayBuffer(chunk.byteLength)
              chunk.copyTo(buffer)
              window.electronAPI.sendFrameToMain({ frame: Buffer.from(buffer), progress: lastProgress })
            },
            error: (e: any) => log.error('[RendererPage] Encoder error:', e),
          })

          videoEncoder.configure({
            codec: 'avc1.420033', // H.264 Baseline Profile Level 5.1
            width: outputWidth,
            height: outputHeight,
            bitrate: targetBitrate,
            framerate: fps,
            avc: { format: 'annexb' },
          })
        }

        for (let frame = 0; frame < totalFrames; frame++) {
          // Backpressure handling to prevent hanging on slower systems
          if (videoEncoder && videoEncoder.encodeQueueSize > 2) {
            // Wait for the queue to drain
            while (videoEncoder.encodeQueueSize > 2) {
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          }

          lastProgress = Math.min(99, ((frame + 1) / totalFrames) * 100)
          const exportTimestamp = frame / fps
          const sourceTimestamp = mapExportTimeToSourceTime(
            exportTimestamp,
            effectiveDuration,
            projectState.cutRegions,
            projectState.speedRegions,
          )

          let mainFrame: VideoFrame | null = null
          let webcamFrame: VideoFrame | null = null

          if (useDecoder && frameProvider) {
            mainFrame = await frameProvider.getFrameForTime(sourceTimestamp)
          } else {
            throw new Error('Decoder-only mode: main video decoder not available.')
          }

          if (hasWebcam && webcamVideo) {
            const webcamTimestamp = Math.max(
              0,
              Math.min(sourceTimestamp * webcamTimeScale, Math.max(0, webcamDuration - 1 / fps)),
            )
            if (useWebcamDecoder && webcamFrameProvider) {
              webcamFrame = await webcamFrameProvider.getFrameForTime(webcamTimestamp)
            } else {
              throw new Error('Decoder-only mode: webcam decoder not available.')
            }
          }

          if (!mainFrame) {
            throw new Error('No decoded frame available for main video.')
          }

          const webcamFrameToUse = webcamFrame ?? webcamVideo

          // Now that videos are at the correct time, draw the scene
          const webcamFrameDimensions = webcamFrame
            ? {
                width: (webcamFrame as any).displayWidth || (webcamFrame as any).codedWidth,
                height: (webcamFrame as any).displayHeight || (webcamFrame as any).codedHeight,
              }
            : undefined
          await pixiRenderer.render(
            projectStateWithCursorBitmaps,
            mainFrame,
            webcamFrameToUse,
            sourceTimestamp, // Use the precise source timestamp for drawing
            outputWidth,
            outputHeight,
            bgImage,
            webcamFrameDimensions,
          )

          if (videoEncoder) {
            const timestamp = (frame / fps) * 1e6
            // @ts-ignore
            const vFrame = new VideoFrame(canvas, { timestamp })
            const keyFrame = frame % (fps * 2) === 0
            videoEncoder.encode(vFrame, { keyFrame })
            vFrame.close()
          } else {
            // Send the rendered frame to the main process
            // const imageData = ctx.getImageData(0, 0, outputWidth, outputHeight)
            // const frameBuffer = Buffer.from(imageData.data.buffer)
            const extraction = pixiRenderer.app.renderer.extract.pixels(pixiRenderer.app.stage)
            const pixels = (extraction as any).pixels || extraction
            const frameBuffer = Buffer.from(pixels.buffer)

            const progress = Math.min(99, ((frame + 1) / totalFrames) * 100)
            window.electronAPI.sendFrameToMain({ frame: frameBuffer, progress })
          }
        }

        if (videoEncoder) {
          await videoEncoder.flush()
        }


        // --- 6. FINISH ---
        log.info('[RendererPage] Render loop finished. Sending "finishRender" signal.')
        window.electronAPI.finishRender()
        pixiRenderer.destroy()
        if (frameProvider) frameProvider.close()
        if (webcamFrameProvider) webcamFrameProvider.close()
      } catch (error) {
        log.error('[RendererPage] CRITICAL ERROR during render process:', error)
        if (frameProvider) frameProvider.close()
        if (webcamFrameProvider) webcamFrameProvider.close()
        const message = error instanceof Error ? error.message : 'Unknown render error'
        window.electronAPI.sendRenderError({ error: message })
      }
    })

    log.info('[RendererPage] Sending "render:ready" signal to main process.')
    window.electronAPI.rendererReady()

    return () => {
      log.info('[RendererPage] Component unmounted. Cleaning up listener.')
      if (typeof cleanup === 'function') cleanup()
    }
  }, [])

  return (
    <div>
      <h1>Renderer Worker</h1>
      <p>This page is hidden and used for video exporting.</p>
      <canvas ref={canvasRef}></canvas>
      <video ref={videoRef} style={{ display: 'none' }}></video>
      <video ref={webcamVideoRef} style={{ display: 'none' }}></video>
    </div>
  )
}
