import {
    Application,
    Container,
    Sprite,
    Graphics,
    Texture,
    ColorSource,
    BlurFilter,
    FillGradient,
    Color,
} from 'pixi.js'
import { RenderableState } from '../types'
import { calculateZoomTransform, findLastMetadataIndex } from './transform'
import { EASING_MAP } from './easing'
import { drawBackground, getWebcamRectForPosition } from './renderer'

function lerp(start: number, end: number, t: number): number {
  return start * (1 - t) + end * t
}

export class PixiRenderer {
  public app: Application
  private width: number
  private height: number

  // Scene Graph
  private root: Container
    private backgroundFill: Graphics
  private backgroundSprite: Sprite
  private contentContainer: Container
  private videoContainer: Container
  private videoSprite: Sprite
  private videoMask: Graphics
  private borderGraphics: Graphics
  private shadowGraphics: Graphics

  private clickRippleGraphics: Graphics
  private cursorSprite: Sprite

  private webcamContainer: Container
  private webcamContent: Container
  private webcamSprite: Sprite
  private webcamMask: Graphics
  private webcamShadow: Graphics

  // Helpers
  private bgCanvas: OffscreenCanvas | HTMLCanvasElement
  private bgCtx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  private bgTexture: Texture

  private videoTexture: Texture
  private webcamTexture: Texture
  
  // Cache for shadow filters to avoid recreation
  private blurFilter: BlurFilter
  private webcamBlurFilter: BlurFilter

  constructor(options: { canvas: HTMLCanvasElement; width: number; height: number; backgroundColor?: ColorSource }) {
    this.width = options.width
    this.height = options.height

    this.app = new Application()
    // Explicitly disabling autoResize because we manage it
    
    // Background helper (using 2D canvas for complex gradients support)
    // We strictly use normal canvas to ensure compatibility with Pixi texture updates
    this.bgCanvas = document.createElement('canvas')
    this.bgCanvas.width = this.width
    this.bgCanvas.height = this.height
    
    this.bgCtx = this.bgCanvas.getContext('2d', { alpha: true }) as any

    this.root = new Container()
    
    // 1. Background
    this.backgroundFill = new Graphics()
    this.root.addChild(this.backgroundFill)

    this.bgTexture = Texture.from(this.bgCanvas)
    this.backgroundSprite = new Sprite(this.bgTexture)
    this.root.addChild(this.backgroundSprite)

    // 2. Content (Video + Frame)
    this.contentContainer = new Container()
    this.root.addChild(this.contentContainer)

    this.shadowGraphics = new Graphics()
    this.contentContainer.addChild(this.shadowGraphics)
    this.blurFilter = new BlurFilter()

    this.videoMask = new Graphics()
    // Mask does not need to be added to children if used as mask, but keeping it orphan is fine

    const clippedContainer = new Container()
    clippedContainer.mask = this.videoMask
    this.contentContainer.addChild(clippedContainer)
    this.contentContainer.addChild(this.videoMask) 

    this.videoContainer = new Container()
    clippedContainer.addChild(this.videoContainer)

    this.videoTexture = Texture.EMPTY
    this.videoSprite = new Sprite(this.videoTexture)
    this.videoContainer.addChild(this.videoSprite)

    this.clickRippleGraphics = new Graphics()
    this.videoContainer.addChild(this.clickRippleGraphics)

    this.cursorSprite = new Sprite(Texture.EMPTY)
    this.cursorSprite.anchor.set(0, 0)
    // Pivot will be set dynamically
    this.videoContainer.addChild(this.cursorSprite)

    this.borderGraphics = new Graphics()
    this.contentContainer.addChild(this.borderGraphics)

    // 3. Webcam
    this.webcamContainer = new Container()
    this.root.addChild(this.webcamContainer)

    this.webcamShadow = new Graphics()
    this.webcamContainer.addChild(this.webcamShadow)
    this.webcamBlurFilter = new BlurFilter()

    this.webcamMask = new Graphics()
    this.webcamContainer.addChild(this.webcamMask)

    this.webcamContent = new Container()
    this.webcamContent.mask = this.webcamMask
    this.webcamContainer.addChild(this.webcamContent)

    this.webcamTexture = Texture.EMPTY
    this.webcamSprite = new Sprite(this.webcamTexture)
    this.webcamContent.addChild(this.webcamSprite)

    // Initialize App
    this.app.init({ 
        canvas: options.canvas, 
        width: options.width, 
        height: options.height, 
        backgroundAlpha: 0,
        antialias: true, // Important for quality
        resolution: window.devicePixelRatio || 1,
        autoDensity: true
    }).then(() => {
        this.app.stage.addChild(this.root)
    })
  }

  public async render(
    state: RenderableState,
    videoElement: CanvasImageSource,
    webcamVideoElement: CanvasImageSource | null,
    currentTime: number,
    outputWidth: number,
    outputHeight: number,
    preloadedBgImage: HTMLImageElement | null,
    webcamDimensions?: { width: number; height: number },
  ) {
    if (!this.app.renderer) return; // Not initialized yet

    // Resize if needed
    if (this.width !== outputWidth || this.height !== outputHeight) {
       this.width = outputWidth
       this.height = outputHeight
       this.app.renderer.resize(outputWidth, outputHeight)
       
      if (this.bgCanvas.width !== outputWidth || this.bgCanvas.height !== outputHeight) {
          this.bgCanvas.width = outputWidth
          this.bgCanvas.height = outputHeight
          // Recreate texture from the resized canvas to avoid invalid resources
          this.bgTexture = Texture.from(this.bgCanvas)
          this.backgroundSprite.texture = this.bgTexture
      }
    }

    if (!state.videoDimensions.width || !state.videoDimensions.height) return

        // --- 1. Background ---
        const backgroundState = state.frameStyles.background
        const fallbackColor =
            backgroundState.type === 'color'
                ? backgroundState.color || '#111111'
                : backgroundState.type === 'gradient'
                    ? backgroundState.gradientStart || '#111111'
                    : backgroundState.color || '#111111'

        // Draw background via Pixi Graphics (color/gradient) to avoid canvas issues
        this.backgroundFill.clear()

        if (backgroundState.type === 'gradient') {
            const startColorStr = backgroundState.gradientStart || '#000000'
            const endColorStr = backgroundState.gradientEnd || '#ffffff'
            const direction = backgroundState.gradientDirection || 'to right'

            const startColor = Color.shared.setValue(startColorStr).toNumber()
            const endColor = Color.shared.setValue(endColorStr).toNumber()

            let gradient: FillGradient
            if (direction.startsWith('circle')) {
                const isCircleIn = direction === 'circle-in'
                gradient = new FillGradient({
                    type: 'radial',
                    center: { x: 0.5, y: 0.5 },
                    innerRadius: 0,
                    outerRadius: 0.5,
                    colorStops: [
                        { offset: 0, color: isCircleIn ? endColor : startColor },
                        { offset: 1, color: isCircleIn ? startColor : endColor },
                    ],
                })
            } else {
                const getCoords = (dir: string) => {
                    switch (dir) {
                        case 'to bottom':
                            return { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } }
                        case 'to top':
                            return { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } }
                        case 'to right':
                            return { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
                        case 'to left':
                            return { start: { x: 1, y: 0 }, end: { x: 0, y: 0 } }
                        case 'to bottom right':
                            return { start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }
                        case 'to bottom left':
                            return { start: { x: 1, y: 0 }, end: { x: 0, y: 1 } }
                        case 'to top right':
                            return { start: { x: 0, y: 1 }, end: { x: 1, y: 0 } }
                        case 'to top left':
                            return { start: { x: 1, y: 1 }, end: { x: 0, y: 0 } }
                        default:
                            return { start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }
                    }
                }

                const { start, end } = getCoords(direction)
                gradient = new FillGradient({
                    start,
                    end,
                    colorStops: [
                        { offset: 0, color: startColor },
                        { offset: 1, color: endColor },
                    ],
                })
            }

            this.backgroundFill.setFillStyle(gradient)
            this.backgroundFill.rect(0, 0, outputWidth, outputHeight)
            this.backgroundFill.fill()
        } else {
            this.backgroundFill.rect(0, 0, outputWidth, outputHeight)
            this.backgroundFill.fill({ color: fallbackColor })
        }

        const hasValidImage =
            !!preloadedBgImage &&
            preloadedBgImage.complete &&
            preloadedBgImage.naturalWidth > 0 &&
            preloadedBgImage.naturalHeight > 0

        const useImageTexture =
            (backgroundState.type === 'image' || backgroundState.type === 'wallpaper') && hasValidImage

        if (useImageTexture) {
            // Render image directly as a Pixi texture (no 2D canvas involved)
            this.backgroundSprite.texture = Texture.from(preloadedBgImage)
            this.backgroundSprite.visible = true
            this.backgroundSprite.alpha = 1
            this.backgroundSprite.width = outputWidth
            this.backgroundSprite.height = outputHeight
        } else {
            this.backgroundSprite.visible = false
            this.backgroundSprite.alpha = 0
        }

    // --- 2. Video Source ---
    const isNewVideo = this.videoTexture.source.resource !== videoElement
    const isValidVideo = videoElement instanceof HTMLVideoElement 
        ? videoElement.readyState >= 2 && videoElement.videoWidth > 0 && videoElement.videoHeight > 0
        : true 

    if (isNewVideo) {
        if (isValidVideo) {
            this.videoTexture = Texture.from(videoElement as any)
            this.videoSprite.texture = this.videoTexture
        }
    } else {
        if (this.videoTexture !== Texture.EMPTY && isValidVideo) {
            // Check if resource dimensions match element dimensions to prevent stretching artifacts
            // This happens if the texture was created when the video was 0x0 or 1x1
            if (videoElement instanceof HTMLVideoElement) {
                if (this.videoTexture.source.width !== videoElement.videoWidth || 
                    this.videoTexture.source.height !== videoElement.videoHeight) {
                    this.videoTexture.source.resize(videoElement.videoWidth, videoElement.videoHeight);
                }
            }
            this.videoTexture.source.update()
        }
    }

    // --- 3. Dimensions & Layout ---
    const { frameStyles, videoDimensions } = state
    const paddingPercent = frameStyles.padding / 100
    const availableWidth = outputWidth * (1 - 2 * paddingPercent)
    const availableHeight = outputHeight * (1 - 2 * paddingPercent)
    const videoAspectRatio = videoDimensions.width / videoDimensions.height

    let frameContentWidth, frameContentHeight
    if (availableWidth / availableHeight > videoAspectRatio) {
      frameContentHeight = availableHeight
      frameContentWidth = frameContentHeight * videoAspectRatio
    } else {
      frameContentWidth = availableWidth
      frameContentHeight = frameContentWidth / videoAspectRatio
    }

    const frameX = (outputWidth - frameContentWidth) / 2
    const frameY = (outputHeight - frameContentHeight) / 2

    // this.contentContainer.position.set(frameX, frameY) <- Overridden later by transform


    // --- 4. Mask & Shadow ---
    this.videoMask.clear()
    this.videoMask.roundRect(0, 0, frameContentWidth, frameContentHeight, frameStyles.borderRadius)
    this.videoMask.fill(0xffffff)

    this.shadowGraphics.clear()
    if (frameStyles.shadowBlur > 0) {
        this.shadowGraphics.rect(0, 0, frameContentWidth, frameContentHeight)
        this.shadowGraphics.fill({ color: frameStyles.shadowColor, alpha: 1 })
        this.shadowGraphics.position.set(frameStyles.shadowOffsetX, frameStyles.shadowOffsetY)
        
        // Apply blur filter
        this.blurFilter.strength = frameStyles.shadowBlur / 2 // Canvas blur is stronger than Pixi sigmas roughly
        this.shadowGraphics.filters = [this.blurFilter]
    } else {
        this.shadowGraphics.filters = []
        if (frameStyles.shadowOffsetX !== 0 || frameStyles.shadowOffsetY !== 0) {
             // Simple offset shadow logic if needed without blur
        }
    }

    // --- 5. Transform ---
    const { scale, translateX, translateY, transformOrigin } = calculateZoomTransform(
        currentTime,
        state.zoomRegions,
        state.metadata,
        state.recordingGeometry || state.videoDimensions,
        { width: frameContentWidth, height: frameContentHeight },
    )
    
    // Convert logic: Apply zoom to ContentContainer (Video+Border) to get "Monitor Zoom" effect.
    // Webcam is separate (layer above) and does NOT zoom.
    
    const [originXStr, originYStr] = transformOrigin.split(' ')
    const originXMul = parseFloat(originXStr) / 100
    const originYMul = parseFloat(originYStr) / 100
    
    // Pivot relative to the Content Container (local coords)
    const originPxX = originXMul * frameContentWidth
    const originPxY = originYMul * frameContentHeight

    // Apply transform to the whole Content Container
    // This scales the masked video + border + shadow together
    this.contentContainer.pivot.set(originPxX, originPxY)
    this.contentContainer.scale.set(scale)
    
    // Position needs to account for the frame's initial offset on the canvas (frameX, frameY)
    // Position = Where the Pivot Point lands in the Parent (Root)
    // Default P_Global = frameX + originPxX
    // New P_Global     = frameX + originPxX + translateX
    this.contentContainer.position.set(frameX + originPxX + translateX, frameY + originPxY + translateY)

    // Reset inner video container (previously scaled)
    this.videoContainer.pivot.set(0, 0)
    this.videoContainer.scale.set(1)
    this.videoContainer.position.set(0, 0)

    const isVideoTextureValid = this.videoTexture !== Texture.EMPTY && this.videoTexture.width > 1; // 1x1 is usually placeholder
    
    if (isVideoTextureValid) {
        this.videoSprite.width = frameContentWidth
        this.videoSprite.height = frameContentHeight
        this.videoSprite.visible = true
    } else {
        this.videoSprite.visible = false
    }

    // --- 6. Border ---
    this.borderGraphics.clear()
    if (frameStyles.borderWidth > 0) {
        this.borderGraphics.roundRect(0, 0, frameContentWidth, frameContentHeight, frameStyles.borderRadius)
        this.borderGraphics.stroke({ width: frameStyles.borderWidth * 2, color: frameStyles.borderColor, alignment: 0.5 }) 
    }

    // --- 7. Clicks ---
    this.clickRippleGraphics.clear()
    if (state.cursorStyles.clickRippleEffect && state.recordingGeometry) {
        const { clickRippleDuration, clickRippleSize, clickRippleColor } = state.cursorStyles
        const rippleEasing = EASING_MAP.Balanced
    
        const recentRippleClicks = state.metadata.filter(
          (event) =>
            event.type === 'click' &&
            event.pressed &&
            currentTime >= event.timestamp &&
            currentTime < event.timestamp + clickRippleDuration,
        )
    
        for (const click of recentRippleClicks) {
          const progress = (currentTime - click.timestamp) / clickRippleDuration
          const easedProgress = rippleEasing(progress)
          const currentRadius = easedProgress * clickRippleSize
          const currentOpacity = 1 - easedProgress
    
          const cursorX = (click.x / state.recordingGeometry.width) * frameContentWidth
          const cursorY = (click.y / state.recordingGeometry.height) * frameContentHeight
          
          this.clickRippleGraphics.circle(cursorX, cursorY, currentRadius)
          this.clickRippleGraphics.fill({ color: clickRippleColor, alpha: currentOpacity }) 
        }
    }

    // --- 8. Cursor ---
    const lastEventIndex = findLastMetadataIndex(state.metadata, currentTime)
    if (state.cursorStyles.showCursor && lastEventIndex > -1 && state.recordingGeometry) {
        const event = state.metadata[lastEventIndex]
        if (event && currentTime - event.timestamp < 0.1) {
             const cursorData = state.cursorBitmapsToRender.get(event.cursorImageKey!)
             if (cursorData && cursorData.imageBitmap && cursorData.width > 0) {
                 const cursorX = (event.x / state.recordingGeometry.width) * frameContentWidth
                 const cursorY = (event.y / state.recordingGeometry.height) * frameContentHeight
                 const drawX = Math.round(cursorX - cursorData.xhot)
                 const drawY = Math.round(cursorY - cursorData.yhot)
                 
                 if (this.cursorSprite.texture.source.resource !== cursorData.imageBitmap) {
                     this.cursorSprite.texture = Texture.from(cursorData.imageBitmap)
                 }

                 this.cursorSprite.position.set(drawX, drawY)
                 
                 let cursorScale = 1
                 if (state.cursorStyles.clickScaleEffect) {
                     const { clickScaleDuration, clickScaleAmount, clickScaleEasing } = state.cursorStyles
                     const mostRecentClick = state.metadata.filter(e => e.type === 'click' && e.pressed && e.timestamp <= currentTime && e.timestamp > currentTime - clickScaleDuration).pop()
                     if (mostRecentClick) {
                         const progress = (currentTime - mostRecentClick.timestamp) / clickScaleDuration
                         const easingFn = EASING_MAP[clickScaleEasing as keyof typeof EASING_MAP] || EASING_MAP.Balanced
                         const easedProgress = easingFn(progress)
                         cursorScale = 1 - (1 - clickScaleAmount) * Math.sin(easedProgress * Math.PI)
                     }
                 }
                 
                 // Pivot around hotspot to scale correctly
                 this.cursorSprite.pivot.set(cursorData.xhot, cursorData.yhot)
                 // Adjust position to be cursor point
                 this.cursorSprite.position.set(cursorX, cursorY)
                 this.cursorSprite.scale.set(cursorScale)

                 this.cursorSprite.visible = true
                 
             } else {
                 this.cursorSprite.visible = false
             }
        } else {
            this.cursorSprite.visible = false
        }
    } else {
        this.cursorSprite.visible = false
    }

    // --- 9. Webcam ---
    const { webcamPosition, webcamStyles, isWebcamVisible } = state
    const wDims = webcamDimensions || (webcamVideoElement as any) 
    let wWidth = 0, wHeight = 0
    if (wDims) {
        if('videoWidth' in wDims) { wWidth = wDims.videoWidth; wHeight = wDims.videoHeight }
        else if('displayWidth' in wDims) { wWidth = wDims.displayWidth; wHeight = wDims.displayHeight }
        else if (wDims.width) { wWidth = wDims.width; wHeight = wDims.height }
    }

    if (isWebcamVisible && webcamVideoElement && wWidth > 0 && state.recordingGeometry) {
        this.webcamContainer.visible = true
    
        // Calculate Interpolated Size
         let startSize = webcamStyles.size;
         let targetSize = webcamStyles.sizeOnZoom;
         let t = 0;
         if (webcamStyles.scaleOnZoom) {
             const activeZoomRegion = Object.values(state.zoomRegions).find(
                (r) => currentTime >= r.startTime && currentTime < r.startTime + r.duration,
             )
             if (activeZoomRegion) {
                 const { startTime, duration, transitionDuration } = activeZoomRegion
                  const zoomInEndTime = startTime + transitionDuration;
                  const zoomOutStartTime = startTime + duration - transitionDuration;
                  const easingFn = EASING_MAP[activeZoomRegion.easing as keyof typeof EASING_MAP] || EASING_MAP.Balanced
                   if (currentTime < zoomInEndTime) {
                      t = easingFn((currentTime - startTime) / transitionDuration);
                    } else if (currentTime >= zoomOutStartTime) {
                      t = easingFn((currentTime - zoomOutStartTime) / transitionDuration);
                      [startSize, targetSize] = [targetSize, startSize]; // Reverse
                    } else {
                      startSize = targetSize;
                      t = 1;
                    }
             }
         }
         
         const baseSize = Math.min(outputWidth, outputHeight)
         let webcamW, webcamH;
         if (webcamStyles.shape === 'rectangle') {
            webcamW = baseSize * (lerp(startSize, targetSize, t) / 100);
            webcamH = webcamW * (9/16);
         } else {
            webcamW = baseSize * (lerp(startSize, targetSize, t) / 100);
            webcamH = webcamW;
         }
         
         // Use Output (Canvas) dimensions to position webcam relative to the whole scene
         const rect = getWebcamRectForPosition(webcamPosition.pos, webcamW, webcamH, outputWidth, outputHeight)
         
         // Update Texture
         const isNewWebcam = this.webcamTexture.source.resource !== webcamVideoElement
         const isValidWebcam = webcamVideoElement instanceof HTMLVideoElement
            ? webcamVideoElement.readyState >= 2 && webcamVideoElement.videoWidth > 0 
            : !!webcamVideoElement

         if (isNewWebcam) {
             if (isValidWebcam) {
                this.webcamTexture = Texture.from(webcamVideoElement as any)
                this.webcamSprite.texture = this.webcamTexture
             }
         } else {
             if (this.webcamTexture !== Texture.EMPTY && isValidWebcam) {
                 // Check resized
                 const vEl = webcamVideoElement as HTMLVideoElement;
                 if (vEl.videoWidth && (this.webcamTexture.source.width !== vEl.videoWidth || this.webcamTexture.source.height !== vEl.videoHeight)) {
                      this.webcamTexture.source.resize(vEl.videoWidth, vEl.videoHeight)
                 }
                this.webcamTexture.source.update()
             }
         }
         
         // Flip & Position
         this.webcamContent.position.set(0, 0) // Content is at 0,0 of container
         
         // We need to fit texture into the rect size (rect.width, rect.height)
         const webcamAR = wWidth / wHeight
         const targetAR = rect.width / rect.height
         
         // The webcamContainer is positioned relative to the Scene (which is 0,0 aligned with Canvas)
         this.webcamContainer.position.set(rect.x, rect.y)

         // Scale sprite to Cover
         if (webcamAR > targetAR) {
             this.webcamSprite.height = rect.height
             this.webcamSprite.width = rect.height * webcamAR
             this.webcamSprite.y = 0
             this.webcamSprite.x = -(this.webcamSprite.width - rect.width) / 2
         } else {
             this.webcamSprite.width = rect.width
             this.webcamSprite.height = rect.width / webcamAR
             this.webcamSprite.x = 0
             this.webcamSprite.y = -(this.webcamSprite.height - rect.height) / 2
         }
         
         // Flipped? 
         if (webcamStyles.isFlipped) {
             // Flip around center of rect
             this.webcamContent.pivot.x = rect.width / 2
             this.webcamContent.scale.x = -1
             this.webcamContent.position.x = rect.width / 2 // Move back
         } else {
             this.webcamContent.pivot.x = 0
             this.webcamContent.scale.x = 1
             this.webcamContent.position.x = 0
         }

         // Mask
        const maxRadius = Math.min(rect.width, rect.height) / 2
        const radius = webcamStyles.shape === 'circle' ? maxRadius : maxRadius * (webcamStyles.borderRadius / 50)
        
        this.webcamMask.clear()
        this.webcamMask.roundRect(0, 0, rect.width, rect.height, radius)
        this.webcamMask.fill(0xffffff)
        
        // Shadow
        this.webcamShadow.clear()
        if (webcamStyles.shadowBlur > 0) {
              this.webcamShadow.roundRect(0, 0, rect.width, rect.height, radius)
              this.webcamShadow.fill({ color: webcamStyles.shadowColor, alpha: 1 })
              this.webcamShadow.position.set(webcamStyles.shadowOffsetX, webcamStyles.shadowOffsetY)
              this.webcamBlurFilter.strength = webcamStyles.shadowBlur / 2
              this.webcamShadow.filters = [this.webcamBlurFilter]
        } else {
            this.webcamShadow.filters = []
        }

    } else {
        this.webcamContainer.visible = false
    }

    this.app.render()
  }

  public destroy() {
      this.app.destroy(true, { children: true, texture: false })
  }
}
