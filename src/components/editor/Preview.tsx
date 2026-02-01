import React, { useEffect, useRef, memo, useState, useCallback } from 'react'
import { useEditorStore, usePlaybackState } from '../../store/editorStore'
import { Movie } from 'tabler-icons-react'
import { FullscreenIcon, ExitFullscreenIcon } from '../ui/icons'
import {
  PlayerPlay,
  PlayerTrackPrev as RewindIcon,
  PlayerPause,
  PlayerSkipBack,
  PlayerSkipForward,
} from 'tabler-icons-react'
import { useShallow } from 'zustand/react/shallow'
import { formatTime } from '../../lib/utils'
import { Slider } from '../ui/slider'
import { Button } from '../ui/button'
import { PixiRenderer } from '../../lib/renderer-gl'
import { cn } from '../../lib/utils'

export const Preview = memo(
  ({
    videoRef,
    onSeekFrame,
  }: {
    videoRef: React.RefObject<HTMLVideoElement>
    onSeekFrame: (direction: 'next' | 'prev') => void
  }) => {
    const {
      videoUrl,
      audioUrl,
      cutRegions,
      speedRegions,
      webcamVideoUrl,
      duration,
      currentTime,
      togglePlay,
      isPreviewFullScreen,
      togglePreviewFullScreen,
      frameStyles,
      isWebcamVisible,
      webcamPosition,
      webcamStyles,
      videoDimensions,
      canvasDimensions,
      volume,
      isMuted,
      setCurrentTime,
      cursorStyles,
      cursorBitmapsToRender,
    } = useEditorStore(
      useShallow((state) => ({
        videoUrl: state.videoUrl,
        audioUrl: state.audioUrl,
        cutRegions: state.cutRegions,
        speedRegions: state.speedRegions,
        webcamVideoUrl: state.webcamVideoUrl,
        duration: state.duration,
        currentTime: state.currentTime,
        togglePlay: state.togglePlay,
        isPreviewFullScreen: state.isPreviewFullScreen,
        togglePreviewFullScreen: state.togglePreviewFullScreen,
        frameStyles: state.frameStyles,
        isWebcamVisible: state.isWebcamVisible,
        webcamPosition: state.webcamPosition,
        webcamStyles: state.webcamStyles,
        videoDimensions: state.videoDimensions,
        canvasDimensions: state.canvasDimensions,
        volume: state.volume,
        isMuted: state.isMuted,
        setCurrentTime: state.setCurrentTime,
        cursorStyles: state.cursorStyles,
        cursorBitmapsToRender: state.cursorBitmapsToRender,
      })),
    )

    const { setPlaying, setDuration, setVideoDimensions, setHasAudioTrack } = useEditorStore.getState()
    const { isPlaying, isCurrentlyCut } = usePlaybackState()

    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null)
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const pixiRendererRef = useRef<PixiRenderer | null>(null)
    const webcamVideoRef = useRef<HTMLVideoElement>(null)
    const audioRef = useRef<HTMLAudioElement>(null)
    const animationFrameId = useRef<number>()
    const [controlBarWidth, setControlBarWidth] = useState(0)

    // --- Start of Changes for Fullscreen Controls ---
    const [isControlBarVisible, setIsControlBarVisible] = useState(false)
    const [isCursorHidden, setIsCursorHidden] = useState(false)
    const inactivityTimerRef = useRef<number | null>(null)
    const previewContainerRef = useRef<HTMLDivElement>(null)

    // This effect handles the auto-hiding control bar in fullscreen mode.
    useEffect(() => {
      if (!isPreviewFullScreen) {
        if (inactivityTimerRef.current) {
          window.clearTimeout(inactivityTimerRef.current)
          inactivityTimerRef.current = null
        }
        setIsCursorHidden(false)
        return // Do nothing if not in fullscreen
      }

      // Start with controls hidden
      setIsControlBarVisible(false)

      // Hide cursor after 3 seconds of inactivity
      const initialHideTimeout = window.setTimeout(() => {
        setIsCursorHidden(true)
      }, 3000)

      const showControlsAndSetTimer = () => {
        setIsControlBarVisible(true)
        setIsCursorHidden(false)
        if (inactivityTimerRef.current) {
          window.clearTimeout(inactivityTimerRef.current)
        }
        inactivityTimerRef.current = window.setTimeout(() => {
          setIsControlBarVisible(false)
          setIsCursorHidden(true) // Ẩn con trỏ khi hết thời gian chờ
        }, 3000) // Hide after 3 seconds of inactivity
      }

      const container = previewContainerRef.current
      if (container) {
        container.addEventListener('mousemove', showControlsAndSetTimer)
      }

      // Cleanup function
      return () => {
        clearTimeout(initialHideTimeout)
        if (inactivityTimerRef.current) {
          window.clearTimeout(inactivityTimerRef.current)
        }
        if (container) {
          container.removeEventListener('mousemove', showControlsAndSetTimer)
        }
      }
    }, [isPreviewFullScreen])
    // --- End of Changes for Fullscreen Controls ---

    useEffect(() => {
      const canvas = canvasRef.current
      if (!canvas) return
      const resizeObserver = new ResizeObserver((entries) => {
        if (entries[0]) {
          const newWidth = entries[0].contentRect.width
          if (newWidth > 0) {
            setControlBarWidth(newWidth)
          }
        }
      })
      resizeObserver.observe(canvas)
      return () => {
        resizeObserver.disconnect()
      }
    }, [canvasDimensions])

    useEffect(() => {
      const background = frameStyles.background
      if ((background.type === 'image' || background.type === 'wallpaper') && background.imageUrl) {
        const img = new Image()
        
        // Setup handlers BEFORE setting src
        img.onload = () => {
          setBgImage(img)
        }
        img.onerror = () => {
          setBgImage(null)
        }

        let finalUrl = background.imageUrl
        
        // Match logic from RendererPage.tsx: Force media:// for ALL local files to ensure CORS headers
        // This fixes WebGL tainted canvas issues for both relative wallpapers and absolute user paths.
        if (finalUrl && !finalUrl.startsWith('blob:') && !finalUrl.startsWith('http')) {
             if (!finalUrl.startsWith('media://')) {
                  finalUrl = `media://${finalUrl}`
             }
        }
        
        // For local dev/production relative paths, ensure no leading slash issues if needed, 
        // but usually just using the string is fine if it matches public folder structure.
        
        // Use anonymous crossOrigin for all external/protocol requests to allow WebGL texture use
        img.crossOrigin = "anonymous"

        img.src = finalUrl
      } else {
        setBgImage(null)
      }
    }, [frameStyles.background])

    useEffect(() => {
      return () => {
        if (pixiRendererRef.current && pixiRendererRef.current.app) {
          try {
            // Destroy everything to free WebGL context
            pixiRendererRef.current.app.destroy(true, { children: true, texture: true, baseTexture: true } as any)
          } catch (e) {
            console.warn('Failed to destroy Pixi app', e)
          }
          pixiRendererRef.current = null
        }
      }
    }, [])

    const renderCanvas = useCallback(async () => {
      const canvas = canvasRef.current
      const video = videoRef.current
      const webcamVideo = webcamVideoRef.current
      const state = useEditorStore.getState()
      
      if (canvas && !pixiRendererRef.current) {
         pixiRendererRef.current = new PixiRenderer({
            canvas,
            width: canvasDimensions.width,
            height: canvasDimensions.height
         })
      }

      if (!canvas || !video || !pixiRendererRef.current || !state.videoDimensions.width) {
        if (state.isPlaying) animationFrameId.current = requestAnimationFrame(renderCanvas)
        return
      }
      try {
        await pixiRendererRef.current.render(
          state, 
          video, 
          webcamVideo, 
          video.currentTime, 
          canvas.width, 
          canvas.height, 
          bgImage
        )
      } catch (e) {
        console.error("PIXI RENDER ERROR:", e)
      }

      if (state.isPlaying) {
        animationFrameId.current = requestAnimationFrame(renderCanvas)
      }
    }, [videoRef, bgImage, canvasDimensions])

    useEffect(() => {
      if (isPlaying) {
        animationFrameId.current = requestAnimationFrame(renderCanvas)
      } else {
        renderCanvas()
      }
      return () => {
        if (animationFrameId.current) {
          cancelAnimationFrame(animationFrameId.current)
        }
      }
    }, [
      isPlaying,
      currentTime,
      renderCanvas,
      canvasDimensions,
      frameStyles,
      isWebcamVisible,
      webcamPosition,
      webcamStyles,
      videoDimensions,
      cursorStyles,
      cursorBitmapsToRender,
    ])

    useEffect(() => {
      const video = videoRef.current
      if (!video) return
      const webcamVideo = webcamVideoRef.current
      const audio = audioRef.current
      if (isPlaying) {
        video.play().catch(console.error)
        webcamVideo?.play().catch(console.error)
        audio?.play().catch(console.error)
      } else {
        video.pause()
        webcamVideo?.pause()
        audio?.pause()
        // When pausing, reset playbackRate to 1 so scrubbing is at normal speed
        video.playbackRate = 1
        if (webcamVideo) webcamVideo.playbackRate = 1
        if (audio) audio.playbackRate = 1
      }
    }, [isPlaying, videoRef])

    // Effect to handle volume and mute state
    useEffect(() => {
      const video = videoRef.current
      const audio = audioRef.current
      if (video) {
        // Video is always muted when we have a separate audio track
        if (audioUrl) {
          video.muted = true
        } else {
          // No separate audio, use video's own audio
          video.volume = volume
          video.muted = isMuted
        }
      }
      if (audio) {
        audio.volume = volume
        audio.muted = isMuted
      }
    }, [volume, isMuted, videoRef, audioUrl])

    useEffect(() => {
      const video = videoRef.current
      if (!video) return
      if (isPlaying && isCurrentlyCut) {
        const allCutRegions = Object.values(useEditorStore.getState().cutRegions)
        const activeCutRegion = allCutRegions.find(
          (r) => video.currentTime >= r.startTime && video.currentTime < r.startTime + r.duration,
        )
        if (activeCutRegion) {
          const newTime = activeCutRegion.startTime + activeCutRegion.duration
          video.currentTime = newTime
          setCurrentTime(newTime)
          // Sync audio with the jump
          if (audioRef.current) {
            audioRef.current.currentTime = newTime
          }
        }
      }
    }, [isCurrentlyCut, isPlaying, videoRef, setCurrentTime])

    const handleTimeUpdate = () => {
      if (!videoRef.current) return
      const video = videoRef.current
      const audio = audioRef.current
      const newTime = video.currentTime

      // Handle speed regions
      const activeSpeedRegion = Object.values(speedRegions).find(
        (r) => newTime >= r.startTime && newTime < r.startTime + r.duration,
      )
      video.playbackRate = activeSpeedRegion ? activeSpeedRegion.speed : 1

      const endTrimRegion = Object.values(cutRegions).find((r) => r.trimType === 'end')
      if (endTrimRegion && newTime >= endTrimRegion.startTime) {
        video.currentTime = endTrimRegion.startTime
        video.pause()
        // Also pause audio
        if (audio) {
          audio.currentTime = endTrimRegion.startTime
          audio.pause()
        }
      }
      if (webcamVideoRef.current) {
        webcamVideoRef.current.currentTime = newTime
        webcamVideoRef.current.playbackRate = video.playbackRate // Sync webcam speed
      }
      if (audio) {
        // Sync audio with video
        if (Math.abs(audio.currentTime - newTime) > 0.1) {
          audio.currentTime = newTime
        }
        audio.playbackRate = video.playbackRate // Sync audio speed
      }
      setCurrentTime(newTime)
    }

    const handleLoadedMetadata = () => {
      const video = videoRef.current
      if (video) {
        setDuration(video.duration)
        setVideoDimensions({ width: video.videoWidth, height: video.videoHeight })

        // Only check video for audio tracks if we don't have a separate audio file
        const store = useEditorStore.getState()
        if (!store.audioUrl) {
          // Check for audio tracks using type-safe checks
          const hasAudioTracks = video.audioTracks && video.audioTracks.length > 0
          const hasMozAudio = 'mozHasAudio' in video && video.mozHasAudio === true
          const hasWebkitAudio = 'webkitHasAudio' in video && video.webkitHasAudio === true

          setHasAudioTrack(!!(hasAudioTracks || hasMozAudio || hasWebkitAudio))
        }

        const timeFromStore = useEditorStore.getState().currentTime

        const onSeekComplete = () => {
          renderCanvas()
          video.removeEventListener('seeked', onSeekComplete)
        }

        video.addEventListener('seeked', onSeekComplete)
        // Restore the video's time from the store to prevent rewinding
        video.currentTime = timeFromStore
      }
    }

    const handleWebcamLoadedMetadata = useCallback(() => {
      const mainVideo = videoRef.current
      const webcamVideo = webcamVideoRef.current
      if (mainVideo && webcamVideo) {
        webcamVideo.currentTime = mainVideo.currentTime
        if (mainVideo.paused) {
          webcamVideo.pause()
        } else {
          webcamVideo.play().catch(console.error)
        }
      }
    }, [videoRef])

    const handleAudioLoadedMetadata = useCallback(() => {
      const video = videoRef.current
      const audio = audioRef.current
      if (video && audio) {
        audio.currentTime = video.currentTime
        if (video.paused) {
          audio.pause()
        } else {
          audio.play().catch(console.error)
        }
      }
    }, [videoRef])

    const handleScrub = (value: number) => {
      if (videoRef.current) {
        videoRef.current.currentTime = value
        setCurrentTime(value)
      }
      if (audioRef.current) {
        audioRef.current.currentTime = value
      }
    }

    const handleRewind = () => {
      const startTrimRegion = Object.values(cutRegions).find((r) => r.trimType === 'start')
      const rewindTime = startTrimRegion ? startTrimRegion.startTime + startTrimRegion.duration : 0
      setCurrentTime(rewindTime)
      if (videoRef.current) {
        videoRef.current.currentTime = rewindTime
      }
      if (audioRef.current) {
        audioRef.current.currentTime = rewindTime
      }
    }

    return (
      <div
        ref={previewContainerRef}
        className={cn(
          'w-full h-full flex flex-col items-center justify-center relative',
          isPreviewFullScreen && isCursorHidden && 'cursor-none',
        )}
      >
        <div
          id="preview-container"
          className="transition-all duration-300 ease-out flex items-center justify-center w-full flex-1 min-h-0"
        >
          {videoUrl ? (
            <canvas
              ref={canvasRef}
              width={canvasDimensions.width}
              height={canvasDimensions.height}
              style={{ 
                maxWidth: '100%', 
                maxHeight: '100%', 
                // When dimensions are known, force the aspect ratio via CSS to prevent squashing/stretching
                // This ensures that even if the container constraints force a different size, 
                // the canvas maintains its internal aspect ratio visually.
                aspectRatio: canvasDimensions.width && canvasDimensions.height 
                  ? `${canvasDimensions.width}/${canvasDimensions.height}` 
                  : 'auto',
                // Important: object-fit contain ensures the canvas content scales correctly within the element box if established by CSS
                objectFit: 'contain' 
              }}
              className="rounded-lg shadow-2xl h-auto w-auto mr-auto ml-auto block"
            />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-muted/30 to-muted/10 border-2 border-dashed border-border/40 rounded-xl flex flex-col items-center justify-center text-muted-foreground gap-4 backdrop-blur-sm">
              <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center backdrop-blur-md border border-border/30 shadow-lg">
                <Movie className="w-10 h-10 text-primary/60" />
              </div>
              <div className="text-center space-y-1">
                <p className="text-lg font-semibold text-foreground/80">No project loaded</p>
                <p className="text-sm text-muted-foreground/70">Load a project to begin editing</p>
              </div>
            </div>
          )}
        </div>

        <video
          ref={videoRef}
          src={videoUrl || undefined}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          playsInline
          style={{ 
            position: 'absolute', 
            width: videoDimensions.width || 'auto', 
            height: videoDimensions.height || 'auto', 
            opacity: 0, 
            pointerEvents: 'none', 
            zIndex: -10 
          }}
        />
        {audioUrl && (
          <audio
            ref={audioRef}
            src={audioUrl}
            onLoadedMetadata={handleAudioLoadedMetadata}
            style={{ display: 'none' }}
          />
        )}
        {webcamVideoUrl && (
          <video
            ref={webcamVideoRef}
            src={webcamVideoUrl}
            muted
            playsInline
            onLoadedMetadata={handleWebcamLoadedMetadata}
            style={{ 
              position: 'absolute', 
              width: 320, 
              height: 180, 
              opacity: 0, 
              pointerEvents: 'none', 
              zIndex: -10 
            }}
          />
        )}

        {/* Control bar */}
        {videoUrl && (
          <div
            className={cn(
              'w-full mt-3 transition-opacity duration-200',
              isPreviewFullScreen && 'absolute bottom-6 left-0 right-0 mx-auto px-4 z-10',
              isPreviewFullScreen && !isControlBarVisible && 'opacity-0 pointer-events-none',
            )}
            style={{ maxWidth: isPreviewFullScreen ? 'min(90%, 800px)' : '100%' }}
          >
            <div
              className="bg-card/95 backdrop-blur-xl border border-border/40 shadow-md rounded-xl px-3 py-2 flex items-center gap-2 max-w-full mx-auto"
              style={{
                width: isPreviewFullScreen ? 'auto' : controlBarWidth,
                minWidth: isPreviewFullScreen ? 'auto' : 420,
              }}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePlay}
                title="Play/Pause (Space)"
                className="flex-shrink-0 text-foreground hover:text-foreground hover:bg-accent h-10 w-10 rounded-xl transition-all duration-150"
              >
                {isPlaying ? <PlayerPause className="w-4 h-4" /> : <PlayerPlay className="w-4 h-4 ml-0.5" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRewind}
                title="Rewind to Start"
                className="flex-shrink-0 text-foreground hover:text-foreground hover:bg-accent h-10 w-10 rounded-xl transition-all duration-150"
              >
                <RewindIcon className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onSeekFrame('prev')}
                title="Previous Frame (J)"
                className="flex-shrink-0 text-foreground hover:text-foreground hover:bg-accent h-10 w-10 rounded-xl transition-all duration-150"
              >
                <PlayerSkipBack className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => onSeekFrame('next')}
                title="Next Frame (K)"
                className="flex-shrink-0 text-foreground hover:text-foreground hover:bg-accent h-10 w-10 rounded-xl transition-all duration-150"
              >
                <PlayerSkipForward className="w-4 h-4" />
              </Button>

              <div className="flex items-baseline gap-2 text-xs font-mono tabular-nums text-muted-foreground min-w-[130px] ml-2">
                <span className="text-foreground font-semibold">{formatTime(currentTime, true)}</span>
                <span className="text-muted-foreground/50">/</span>
                <span className="text-muted-foreground">{formatTime(duration, true)}</span>
              </div>
              <Slider
                min={0}
                max={duration}
                step={0.01}
                value={currentTime}
                onChange={handleScrub}
                disabled={duration === 0}
                className="flex-1"
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={togglePreviewFullScreen}
                className="flex-shrink-0 text-foreground hover:text-foreground hover:bg-accent h-10 w-10 rounded-xl transition-all duration-150"
              >
                {isPreviewFullScreen ? (
                  <ExitFullscreenIcon className="w-4 h-4" />
                ) : (
                  <FullscreenIcon className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    )
  },
)
Preview.displayName = 'Preview'
