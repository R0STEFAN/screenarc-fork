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
const PAN_SMOOTHING_FACTOR = 0.15 // Adjust this value (0-1) to control smoothness. Lower = smoother but slower.

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

  // Phase 1: ZOOM-IN (Smoothly pan towards cursor while zooming in)
  if (currentTime >= startTime && currentTime < zoomInEndTime) {
    const t = (EASING_MAP[easing as keyof typeof EASING_MAP] || EASING_MAP.Balanced)(
      (currentTime - startTime) / transitionDuration,
    )
    currentScale = lerp(1, zoomLevel, t)
    currentTranslateX = lerp(0, initialPan.tx, t)
    currentTranslateY = lerp(0, initialPan.ty, t)
    
    // Update tracking for phase 2
    previousPanX = currentTranslateX
    previousPanY = currentTranslateY
    lastPanUpdateTime = currentTime
  }
  // Phase 2: PAN/HOLD (Fully zoomed in, pan follows smoothed mouse with smooth interpolation)
  else if (currentTime >= zoomInEndTime && currentTime < zoomOutStartTime) {
    currentScale = zoomLevel
    
    // At the start of phase 2, initialize previousPan to initialPan (end of zoom-in)
    // This ensures smooth transition without initial jump
    if (lastPanUpdateTime < zoomInEndTime) {
      previousPanX = initialPan.tx
      previousPanY = initialPan.ty
      lastPanUpdateTime = zoomInEndTime
    }
    
    // Smooth interpolation between previous position and target position
    // This creates fluid camera movement without jitter
    const timeDelta = currentTime - lastPanUpdateTime
    const effectiveSmoothingFactor = Math.min(PAN_SMOOTHING_FACTOR, timeDelta > 0 ? 1 : 0)
    
    currentTranslateX = lerp(previousPanX, livePan.tx, effectiveSmoothingFactor)
    currentTranslateY = lerp(previousPanY, livePan.ty, effectiveSmoothingFactor)
    
    // Update for next frame
    previousPanX = currentTranslateX
    previousPanY = currentTranslateY
    lastPanUpdateTime = currentTime
  }
  // Phase 3: ZOOM-OUT (No panning, move from final pan position back to center)
  else if (currentTime >= zoomOutStartTime && currentTime <= startTime + duration) {
    const t = (EASING_MAP[easing as keyof typeof EASING_MAP] || EASING_MAP.Balanced)(
      (currentTime - zoomOutStartTime) / transitionDuration,
    )
    currentScale = lerp(zoomLevel, 1, t)
    currentTranslateX = lerp(finalPan.tx, 0, t)
    currentTranslateY = lerp(finalPan.ty, 0, t)
    
    // Reset tracking for next zoom region
    previousPanX = 0
    previousPanY = 0
    lastPanUpdateTime = currentTime
  }

  return { scale: currentScale, translateX: currentTranslateX, translateY: currentTranslateY, transformOrigin }
}
