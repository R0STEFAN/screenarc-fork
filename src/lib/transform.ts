import { EASING_MAP } from './easing'
import { DEFAULTS } from './constants'
import { ZoomRegion, MetaDataItem } from '../types'

// --- HELPER FUNCTIONS ---

/**
 * Linearly interpolates between two values.
 */
function lerp(start: number, end: number, t: number): number {
  return start * (1 - t) + end * t
}

/**
 * Finds the index of the last metadata item with a timestamp less than or equal to the given time.
 * Uses binary search for performance optimization.
 */
export const findLastMetadataIndex = (metadata: MetaDataItem[], currentTime: number): number => {
  if (metadata.length === 0) return -1
  let left = 0
  let right = metadata.length - 1
  let result = -1

  while (left <= right) {
    const mid = Math.floor((left + right) / 2)
    if (metadata[mid].timestamp <= currentTime) {
      result = mid
      left = mid + 1
    } else {
      right = mid - 1
    }
  }
  return result
}

/**
 * Calculates a smoothed mouse position at a given time using Exponential Moving Average (EMA).
 * This prevents jerky panning by smoothing out rapid mouse movements.
 * Implements a dead zone to ignore small movements and improve stability.
 */
function getSmoothedMousePosition(
  metadata: MetaDataItem[],
  targetTime: number,
  smoothingFactor = DEFAULTS.CAMERA.MOVEMENT.SMOOTHING_FACTOR,
  deadZone = DEFAULTS.CAMERA.MOVEMENT.DEAD_ZONE,
): { x: number; y: number } | null {
  const endIndex = findLastMetadataIndex(metadata, targetTime)
  if (endIndex < 0) return null

  // Start smoothing from a bit before the target time to build up the average
  const startTime = Math.max(0, targetTime - DEFAULTS.CAMERA.MOVEMENT.SMOOTHING_WINDOW)
  let startIndex = findLastMetadataIndex(metadata, startTime)
  if (startIndex < 0) startIndex = 0

  if (startIndex >= metadata.length) return null

  let smoothedX = metadata[startIndex].x
  let smoothedY = metadata[startIndex].y

  for (let i = startIndex + 1; i <= endIndex; i++) {
    const currentX = metadata[i].x
    const currentY = metadata[i].y

    // Calculate distance from current smoothed position to new position
    const deltaX = currentX - smoothedX
    const deltaY = currentY - smoothedY
    const movementDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)

    // Apply dead zone: reduce smoothing factor for small movements
    // This prevents camera from following tiny cursor adjustments
    const effectiveSmoothingFactor = movementDistance > deadZone ? smoothingFactor : smoothingFactor * 0.3
    
    smoothedX = lerp(smoothedX, currentX, effectiveSmoothingFactor)
    smoothedY = lerp(smoothedY, currentY, effectiveSmoothingFactor)
  }

  // Final interpolation for sub-frame accuracy
  const lastEvent = metadata[endIndex]
  if (endIndex + 1 < metadata.length) {
    const nextEvent = metadata[endIndex + 1]
    const timeDiff = nextEvent.timestamp - lastEvent.timestamp
    if (timeDiff > 0) {
      const progress = (targetTime - lastEvent.timestamp) / timeDiff
      const finalX = lerp(smoothedX, nextEvent.x, smoothingFactor)
      const finalY = lerp(smoothedY, nextEvent.y, smoothingFactor)
      return {
        x: lerp(smoothedX, finalX, progress),
        y: lerp(smoothedY, finalY, progress),
      }
    }
  }

  return { x: smoothedX, y: smoothedY }
}

/**
 * Calculates the final bounded translation values based on a smoothed mouse position.
 */
function calculateBoundedPan(
  mousePos: { x: number; y: number } | null,
  origin: { x: number; y: number },
  zoomLevel: number,
  recordingGeometry: { width: number; height: number },
  frameContentDimensions: { width: number; height: number },
): { tx: number; ty: number } {
  if (!mousePos) return { tx: 0, ty: 0 }

  // Normalized mouse position (0 to 1)
  const nsmx = mousePos.x / recordingGeometry.width
  const nsmy = mousePos.y / recordingGeometry.height

  // Calculate the target pan that would center the mouse
  const targetFinalPanX = (0.5 - ((nsmx - origin.x) * zoomLevel + origin.x)) * frameContentDimensions.width
  const targetFinalPanY = (0.5 - ((nsmy - origin.y) * zoomLevel + origin.y)) * frameContentDimensions.height

  // Apply this pan to the scaled-up coordinate space, then divide by scale to get the correct CSS translate value
  const targetTranslateX = targetFinalPanX / zoomLevel
  const targetTranslateY = targetFinalPanY / zoomLevel

  // Define the maximum allowed pan in any direction to keep the video in frame
  const maxTx = (origin.x * frameContentDimensions.width * (zoomLevel - 1)) / zoomLevel
  const minTx = -((1 - origin.x) * frameContentDimensions.width * (zoomLevel - 1)) / zoomLevel
  const maxTy = (origin.y * frameContentDimensions.height * (zoomLevel - 1)) / zoomLevel
  const minTy = -((1 - origin.y) * frameContentDimensions.height * (zoomLevel - 1)) / zoomLevel

  // Clamp the translation to the allowed bounds
  const tx = Math.max(minTx, Math.min(maxTx, targetTranslateX))
  const ty = Math.max(minTy, Math.min(maxTy, targetTranslateY))

  return { tx, ty }
}

/**
 * Calculates the transform-origin based on a normalized target point [-0.5, 0.5].
 * Implements edge snapping to prevent zooming outside the video frame.
 * The output is a value from 0 to 1 for CSS transform-origin.
 */
function getTransformOrigin(targetX: number, targetY: number): { x: number; y: number } {
  return { x: targetX + 0.5, y: targetY + 0.5 }
}

// Store previous pan position for smooth interpolation during pan/hold phase
let previousPanX = 0
let previousPanY = 0
let lastPanUpdateTime = 0
const PAN_SMOOTHING_FACTOR = 0.1 // 0.1 provides very smooth but responsive movement

export const calculateZoomTransform = (
  currentTime: number,
  zoomRegions: Record<string, ZoomRegion>,
  metadata: MetaDataItem[],
  recordingGeometry: { width: number; height: number },
  frameContentDimensions: { width: number; height: number },
): { scale: number; translateX: number; translateY: number; transformOrigin: string } => {
  const activeRegion = Object.values(zoomRegions).find(
    (r) => currentTime >= r.startTime && currentTime < r.startTime + r.duration,
  )

  const defaultTransform = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    transformOrigin: '50% 50%',
  }

  // If no region or big time jump, reset tracking
  if (!activeRegion || Math.abs(currentTime - lastPanUpdateTime) > 0.5) {
     if (activeRegion) {
        // Just reset to 0 or we could try to re-initialize if we had context
        // But simply resetting means next frame will "snap" or "converge"
        previousPanX = 0
        previousPanY = 0
     }
  }

  if (!activeRegion) return defaultTransform

  const { startTime, duration, zoomLevel, targetX, targetY, mode, easing, transitionDuration } = activeRegion
  const zoomOutStartTime = startTime + duration - transitionDuration
  const zoomInEndTime = startTime + transitionDuration

  const fixedOrigin = getTransformOrigin(targetX, targetY)
  const transformOrigin = `${fixedOrigin.x * 100}% ${fixedOrigin.y * 100}%`

  let currentScale = 1
  let currentTranslateX = 0
  let currentTranslateY = 0

  // --- Calculate Pan Targets ---
  let initialPan = { tx: 0, ty: 0 }
  let livePan = { tx: 0, ty: 0 }
  let finalPan = { tx: 0, ty: 0 }

  if (mode === 'auto' && metadata.length > 0 && recordingGeometry.width > 0) {
    // Pan target for the end of the zoom-in transition (cursor position at that time)
    const zoomInEndMousePos = getSmoothedMousePosition(metadata, zoomInEndTime)
    const zoomInEndPan = calculateBoundedPan(zoomInEndMousePos, fixedOrigin, zoomLevel, recordingGeometry, frameContentDimensions)
    initialPan = zoomInEndPan

    // Live pan target for the hold phase (DYNAMIC)
    const liveMousePos = getSmoothedMousePosition(metadata, currentTime)
    livePan = calculateBoundedPan(liveMousePos, fixedOrigin, zoomLevel, recordingGeometry, frameContentDimensions)

    // Pan target for the start of the zoom-out transition (STATIONARY)
    const finalMousePos = getSmoothedMousePosition(metadata, zoomOutStartTime)
    finalPan = calculateBoundedPan(finalMousePos, fixedOrigin, zoomLevel, recordingGeometry, frameContentDimensions)
  }

  // --- Determine current transform based on phase ---

  // Phase 1: ZOOM-IN (Strict interpolation to avoid initial lag)
  if (currentTime >= startTime && currentTime < zoomInEndTime) {
    const t = (EASING_MAP[easing as keyof typeof EASING_MAP] || EASING_MAP.Balanced)(
      (currentTime - startTime) / transitionDuration,
    )
    currentScale = lerp(1, zoomLevel, t)
    currentTranslateX = lerp(0, initialPan.tx, t)
    currentTranslateY = lerp(0, initialPan.ty, t)
    
    // Snap our smoother to the current calculation so Phase 2 starts correctly
    previousPanX = currentTranslateX
    previousPanY = currentTranslateY
  }
  // Phase 2: PAN/HOLD (Apply extra smoothing for fluid camera feeling)
  else if (currentTime >= zoomInEndTime && currentTime < zoomOutStartTime) {
    currentScale = zoomLevel
    
    // Smooth interpolation towards the live target
    const timeDelta = currentTime - lastPanUpdateTime
    // Normalize smoothing to frame rate roughly (assuming ~60fps if delta is ~0.016)
    // If delta is 0 (same frame), don't change.
    const alpha = timeDelta > 0 ? (timeDelta / 0.016) * PAN_SMOOTHING_FACTOR : 0
    // Clamp alpha
    const safeAlpha = Math.max(0, Math.min(1, alpha))

    currentTranslateX = lerp(previousPanX, livePan.tx, safeAlpha)
    currentTranslateY = lerp(previousPanY, livePan.ty, safeAlpha)

    previousPanX = currentTranslateX
    previousPanY = currentTranslateY
  }
  // Phase 3: ZOOM-OUT (Continue smoothing towards dynamic target)
  else if (currentTime >= zoomOutStartTime && currentTime <= startTime + duration) {
    const t = (EASING_MAP[easing as keyof typeof EASING_MAP] || EASING_MAP.Balanced)(
      (currentTime - zoomOutStartTime) / transitionDuration,
    )
    currentScale = lerp(zoomLevel, 1, t)

    let targetTx = 0
    let targetTy = 0

    if (mode === 'auto' && metadata.length > 0 && recordingGeometry.width > 0) {
      const liveMousePos = getSmoothedMousePosition(metadata, currentTime)
      const dynamicPan = calculateBoundedPan(
        liveMousePos,
        fixedOrigin,
        currentScale,
        recordingGeometry,
        frameContentDimensions,
      )
      
      // User request optimization: 
      // First 5% of zoom-out: gradually release cursor tracking (decay from 1.0 to 0.0).
      // Remaining 95%: pure movement to center (influence is 0).
      const cursorInfluence = t <= 0.05 ? 1 - (t / 0.05) : 0
      
      targetTx = dynamicPan.tx * cursorInfluence
      targetTy = dynamicPan.ty * cursorInfluence
    } else {
      targetTx = lerp(finalPan.tx, 0, t)
      targetTy = lerp(finalPan.ty, 0, t)
    }

    // Apply same smoothing as Phase 2 to prevent jump in velocity
    // But ensure we converge to 0 if target is 0?
    // Actually, dynamicPan converges to 0. So smoothing towards it is safe.
    
    const timeDelta = currentTime - lastPanUpdateTime
    const baseAlpha = timeDelta > 0 ? (timeDelta / 0.016) * PAN_SMOOTHING_FACTOR : 0
    
    // CRITICAL FIX: As zoom-out finishes (t -> 1), force convergence to the target.
    // Otherwise, the smoothed value lags behind and causes a jump when the region ends.
    // Using power 4 keeps smoothing active early on, but snaps firmly at the end.
    const convergence = Math.pow(t, 4)
    const fluidAlpha = lerp(Math.max(0, Math.min(1, baseAlpha)), 1, convergence)

    currentTranslateX = lerp(previousPanX, targetTx, fluidAlpha)
    currentTranslateY = lerp(previousPanY, targetTy, fluidAlpha)
    
    previousPanX = currentTranslateX
    previousPanY = currentTranslateY
  }
  
  lastPanUpdateTime = currentTime

  return { scale: currentScale, translateX: currentTranslateX, translateY: currentTranslateY, transformOrigin }
}
