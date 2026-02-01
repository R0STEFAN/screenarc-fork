/* eslint-disable @typescript-eslint/no-explicit-any */
// Contains core business logic for recording, stopping, and cleanup.

import log from 'electron-log/main'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fsPromises from 'node:fs/promises'
import { app, Menu, Tray, nativeImage, screen, ipcMain, dialog, systemPreferences } from 'electron'
import { appState } from '../state'
import { getFFmpegPath, ensureDirectoryExists } from '../lib/utils'
import { VITE_PUBLIC } from '../lib/constants'
import { createMouseTracker } from './mouse-tracker'
import { getCursorScale, restoreOriginalCursorScale, resetCursorScale } from './cursor-manager'
import { createEditorWindow, cleanupEditorFiles } from '../windows/editor-window'
import { createSavingWindow, createSelectionWindow } from '../windows/temporary-windows'
import type { RecordingSession, RecordingGeometry } from '../state'

const FFMPEG_PATH = getFFmpegPath()

/**
 * Uses ffprobe to get the precise creation time of the video file.
 * @param videoPath The path to the video file.
 * @returns A promise that resolves to the creation time as a UNIX timestamp (ms).
 */
async function getVideoStartTime(videoPath: string): Promise<number> {
  try {
    const stats = await fsPromises.stat(videoPath)
    return stats.birthtimeMs
  } catch (error) {
    log.error(`[getVideoStartTime] Error getting file stats for ${videoPath}:`, error)
    throw error
  }
}

/**
 * Validates the generated recording files to ensure they exist and are not empty.
 * @param session - The recording session containing file paths to validate.
 * @returns A promise that resolves to true if files are valid, false otherwise.
 */
async function validateRecordingFiles(session: RecordingSession): Promise<boolean> {
  log.info('[Validation] Validating recorded files...')
  const filesToValidate = [session.screenVideoPath]
  if (session.webcamVideoPath) {
    filesToValidate.push(session.webcamVideoPath)
  }
  if (session.audioPath) {
    filesToValidate.push(session.audioPath)
  }

  for (const filePath of filesToValidate) {
    try {
      const stats = await fsPromises.stat(filePath)
      if (stats.size === 0) {
        const errorMessage = `The recording produced an empty video file (${path.basename(filePath)}). This could be due to incorrect permissions, lack of disk space, or a hardware issue.`
        log.error(`[Validation] ${errorMessage}`)
        dialog.showErrorBox('Recording Validation Failed', errorMessage)
        return false
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const errorMessage = `The recording process failed to create the video file: ${path.basename(filePath)}.`
        log.error(`[Validation] ${errorMessage}`)
        dialog.showErrorBox('Recording Validation Failed', errorMessage)
      } else {
        const errorMessage = `Could not access the recorded file (${path.basename(filePath)}). Error: ${(error as Error).message}`
        log.error(`[Validation] ${errorMessage}`, error)
        dialog.showErrorBox('File Error', errorMessage)
      }
      return false
    }
  }

  log.info('[Validation] All recorded files appear valid (exist and are not empty).')
  return true
}

/**
 * Trims the audio file by removing the specified amount from the beginning.
 * @param audioPath - Path to the audio file to trim
 * @param trimMs - Amount to trim from the beginning in milliseconds (default 1000ms)
 * @returns Promise that resolves to the path of the trimmed audio file
 */
async function trimAudioFile(audioPath: string, trimMs: number = 1000): Promise<string> {
  const trimmedPath = audioPath.replace(/\.aac$/, '-trimmed.aac')
  const trimSeconds = trimMs / 1000

  log.info(`[AudioTrim] Trimming ${trimMs}ms from beginning of ${audioPath}`)

  return new Promise((resolve, reject) => {
    const ffmpegArgs = [
      '-y',
      '-ss',
      trimSeconds.toString(),
      '-i',
      audioPath,
      '-c:a',
      'copy',
      trimmedPath,
    ]

    const ffmpeg = spawn(FFMPEG_PATH, ffmpegArgs)

    ffmpeg.stderr.on('data', (data: any) => {
      log.info(`[AudioTrim FFmpeg]: ${data.toString()}`)
    })

    ffmpeg.on('close', async (code: any) => {
      if (code === 0) {
        log.info(`[AudioTrim] Successfully trimmed audio, replacing original file`)
        try {
          // Replace original file with trimmed version
          await fsPromises.unlink(audioPath)
          await fsPromises.rename(trimmedPath, audioPath)
          resolve(audioPath)
        } catch (error) {
          log.error(`[AudioTrim] Error replacing audio file:`, error)
          reject(error)
        }
      } else {
        log.error(`[AudioTrim] FFmpeg exited with code ${code}`)
        reject(new Error(`Audio trim failed with code ${code}`))
      }
    })

    ffmpeg.on('error', (error: any) => {
      log.error(`[AudioTrim] FFmpeg error:`, error)
      reject(error)
    })
  })
}

/**
 * The core function that spawns FFmpeg and the mouse tracker to begin recording.
 * @param inputArgs - Platform-specific FFmpeg input arguments.
 * @param hasWebcam - Flag indicating if webcam recording is enabled.
 * @param hasMic - Flag indicating if microphone recording is enabled.
 * @param recordingGeometry - The logical dimensions and position of the recording area.
 * @param scaleFactor - The display scale factor (for Windows DPI scaling).
 */
async function startActualRecording(
  inputArgs: string[],
  hasWebcam: boolean,
  hasMic: boolean,
  recordingGeometry: RecordingGeometry,
  scaleFactor: number = 1,
) {
  const recordingDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.screenarc')
  await ensureDirectoryExists(recordingDir)
  const baseName = `ScreenArc-recording-${Date.now()}`

  const screenVideoPath = path.join(recordingDir, `${baseName}-screen.mp4`)
  const webcamVideoPath = hasWebcam ? path.join(recordingDir, `${baseName}-webcam.mp4`) : undefined
  const audioPath = hasMic ? path.join(recordingDir, `${baseName}-audio.aac`) : undefined
  const metadataPath = path.join(recordingDir, `${baseName}.json`)

  // Store recordingGeometry and scaleFactor in the session
  appState.currentRecordingSession = { screenVideoPath, webcamVideoPath, audioPath, metadataPath, recordingGeometry, scaleFactor }
  appState.recorderWin?.minimize()

  // Reset state for the new session
  appState.recordingStartTime = Date.now()
  appState.recordedMouseEvents = []
  appState.runtimeCursorImageMap = new Map()
  appState.mouseTracker = createMouseTracker()

  if (appState.mouseTracker) {
    appState.mouseTracker.on('data', (data: any) => {
      // Normalize mouse coordinates based on platform
      // On Windows, mouse events come in physical pixels (with DPI scaling)
      // On other platforms, they're in logical pixels
      let normalizedX = data.x
      let normalizedY = data.y
      
      if (process.platform === 'win32') {
        normalizedX = data.x / scaleFactor
        normalizedY = data.y / scaleFactor
      }
      
      // Check if the mouse event is within the recording geometry bounds
      if (
        normalizedX >= recordingGeometry.x &&
        normalizedX <= recordingGeometry.x + recordingGeometry.width &&
        normalizedY >= recordingGeometry.y &&
        normalizedY <= recordingGeometry.y + recordingGeometry.height
      ) {
        const absoluteEvent = {
          ...data,
          x: normalizedX - recordingGeometry.x,
          y: normalizedY - recordingGeometry.y,
          timestamp: data.timestamp,
        }
        appState.recordedMouseEvents.push(absoluteEvent)
      }
    })
    // Check if tracker started successfully
    const trackerStarted = await appState.mouseTracker.start(appState.runtimeCursorImageMap)
    if (!trackerStarted) {
      log.error('[RecordingManager] Mouse tracker failed to start, likely due to permissions. Aborting recording.')
      appState.recorderWin?.show()
      await cleanupAndDiscard()
      return { canceled: true }
    }
  }

  const finalArgs = buildFfmpegArgs(inputArgs, hasWebcam, hasMic, screenVideoPath, webcamVideoPath, audioPath)
  log.info(`[FFMPEG] Starting FFmpeg with args: ${finalArgs.join(' ')}`)
  appState.ffmpegProcess = spawn(FFMPEG_PATH, finalArgs)

  // Monitor FFmpeg's stderr for progress, errors, and sync timing
  appState.ffmpegProcess.stderr.on('data', (data: any) => {
    const message = data.toString()
    log.warn(`[FFMPEG stderr]: ${message}`)

    // Early detection of fatal errors to provide immediate feedback
    const fatalErrorKeywords = [
      'Cannot open display',
      'Invalid argument',
      'Device not found',
      'Unknown input format',
      'error opening device',
    ]
    if (fatalErrorKeywords.some((keyword) => message.toLowerCase().includes(keyword.toLowerCase()))) {
      log.error(`[FFMPEG] Fatal error detected: ${message}`)
      dialog.showErrorBox(
        'Recording Failed',
        `A critical error occurred while starting the recording process:\n\n${message}\n\nPlease check your device permissions and configurations.`,
      )
      setTimeout(() => cleanupAndDiscard(), 100)
    }
  })

  // Notify the recorder window that recording has started
  appState.recorderWin?.webContents.send('recording-started')

  createTray()
  return { canceled: false, ...appState.currentRecordingSession }
}

/**
 * Constructs the final FFmpeg command arguments by mapping input streams to output files.
 */
function buildFfmpegArgs(
  inputArgs: string[],
  hasWebcam: boolean,
  hasMic: boolean,
  screenOut: string,
  webcamOut?: string,
  audioOut?: string,
): string[] {
  const finalArgs = [...inputArgs]
  // Determine the index of each input stream (mic, webcam, screen)
  const micIndex = hasMic ? 0 : -1
  const webcamIndex = hasMic ? (hasWebcam ? 1 : -1) : hasWebcam ? 0 : -1
  const screenIndex = (hasMic ? 1 : 0) + (hasWebcam ? 1 : 0)

  // Map screen video stream (video only, no audio)
  finalArgs.push(
    '-map',
    `${screenIndex}:v`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast', // Keep ultrafast for low CPU usage during recording
    '-crf', '18', // High quality (visually lossless)
    '-pix_fmt',
    'yuv420p',
    screenOut,
  )

  // Map audio stream to separate file if present
  if (hasMic && audioOut) {
    finalArgs.push('-map', `${micIndex}:a`, '-c:a', 'aac', '-b:a', '192k', audioOut)
  }

  // Map webcam video stream if present
  if (hasWebcam && webcamOut) {
    finalArgs.push(
      '-map',
      `${webcamIndex}:v`,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      webcamOut,
    )
  }

  return finalArgs
}

/**
 * Creates the system tray icon and context menu for controlling an active recording.
 */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(VITE_PUBLIC, 'screenarc-appicon-tray.png'))
  appState.tray = new Tray(icon)
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Stop Recording',
      click: async () => {
        await stopRecording()
      },
    },
    {
      label: 'Cancel Recording',
      click: async () => {
        await cancelRecording()
      },
    },
  ])
  appState.tray.setToolTip('ScreenArc is recording...')
  appState.tray.setContextMenu(contextMenu)
}

/**
 * Orchestrates the start of a recording based on user options from the renderer.
 * @param options - The recording configuration selected by the user.
 */
export async function startRecording(options: any) {
  const { source, displayId, mic, webcam } = options
  log.info('[RecordingManager] Received start recording request with options:', options)

  // macOS Permissions Check
  if (process.platform === 'darwin') {
    // 1. Check Screen Recording Permissions
    let screenAccess = systemPreferences.getMediaAccessStatus('screen')
    if (screenAccess === 'not-determined') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const iohook = require('iohook-macos')
        const permissions = iohook.checkAccessibilityPermissions()
        screenAccess = permissions.hasPermissions ? 'granted' : 'denied'
      } catch (e) {
        log.error('[MouseTracker] Failed to load macOS-specific modules. Mouse tracking on macOS will be disabled.', e)
      }
    }
    if (screenAccess !== 'granted') {
      dialog.showErrorBox(
        'Screen Recording Permission Required',
        'Accessibility permissions required. Please go to System Preferences > Security & Privacy > Privacy > Accessibility and enable this application.',
      )
      return { canceled: true }
    }

    // 2. Check Microphone Permissions (if requested)
    if (mic) {
      let micAccess = systemPreferences.getMediaAccessStatus('microphone')
      if (micAccess === 'not-determined') {
        micAccess = (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied'
      }
      if (micAccess !== 'granted') {
        dialog.showErrorBox(
          'Microphone Permission Required',
          'Microphone permissions required. Please go to System Preferences > Security & Privacy > Privacy > Microphone and enable this application.',
        )
        return { canceled: true }
      }
    }
  }

  const display = process.env.DISPLAY || ':0.0'
  const baseFfmpegArgs: string[] = []
  let recordingGeometry: RecordingGeometry
  let recordingScaleFactor = 1  // Default to 1 for non-Windows or 100% scaling

  // --- Add Microphone and Webcam inputs first ---
  if (mic) {
    switch (process.platform) {
      case 'linux':
        baseFfmpegArgs.push('-f', 'alsa', '-i', 'default')
        break
      case 'win32':
        baseFfmpegArgs.push('-f', 'dshow', '-i', `audio=${mic.deviceLabel}`)
        break
      case 'darwin':
        baseFfmpegArgs.push('-f', 'avfoundation', '-i', `:${mic.index}`)
        break
    }
  }
  if (webcam) {
    switch (process.platform) {
      case 'linux':
        baseFfmpegArgs.push('-f', 'v4l2', '-framerate', '30', '-i', `/dev/video${webcam.index}`)
        break
      case 'win32':
        baseFfmpegArgs.push('-f', 'dshow', '-framerate', '30', '-i', `video=${webcam.deviceLabel}`)
        break
      case 'darwin':
        baseFfmpegArgs.push('-f', 'avfoundation', '-framerate', '30', '-i', `${webcam.index}:none`)
        break
    }
  }

  // --- Add Screen input last ---
  if (source === 'fullscreen') {
    const allDisplays = screen.getAllDisplays()
    const targetDisplay = allDisplays.find((d) => d.id === displayId) || screen.getPrimaryDisplay()
    const { x, y, width, height } = targetDisplay.bounds
    const scaleFactor = targetDisplay.scaleFactor || 1
    recordingScaleFactor = scaleFactor  // Store for metadata processing
    
    // For Windows, we need to use physical pixels for gdigrab
    const physicalWidth = process.platform === 'win32' ? Math.floor((width * scaleFactor) / 2) * 2 : Math.floor(width / 2) * 2
    const physicalHeight = process.platform === 'win32' ? Math.floor((height * scaleFactor) / 2) * 2 : Math.floor(height / 2) * 2
    const physicalX = process.platform === 'win32' ? Math.floor(x * scaleFactor) : x
    const physicalY = process.platform === 'win32' ? Math.floor(y * scaleFactor) : y
    
    // Store the logical dimensions for mouse tracking
    const safeWidth = Math.floor(width / 2) * 2
    const safeHeight = Math.floor(height / 2) * 2
    recordingGeometry = { x, y, width: safeWidth, height: safeHeight }
    
    switch (process.platform) {
      case 'linux':
        baseFfmpegArgs.push(
          '-f',
          'x11grab',
          '-framerate', '60',
          '-draw_mouse',
          '0',
          '-video_size',
          `${safeWidth}x${safeHeight}`,
          '-i',
          `${display}+${x},${y}`,
        )
        break
      case 'win32':
        baseFfmpegArgs.push(
          '-f',
          'gdigrab',
          '-framerate', '60',
          '-draw_mouse',
          '0',
          '-offset_x',
          physicalX.toString(),
          '-offset_y',
          physicalY.toString(),
          '-video_size',
          `${physicalWidth}x${physicalHeight}`,
          '-i',
          'desktop',
        )
        break
      case 'darwin':
        baseFfmpegArgs.push(
          '-f',
          'avfoundation',
          '-framerate', '60',
          '-i',
          `${allDisplays.findIndex((d) => d.id === targetDisplay.id) || 0}:none`,
        )
        break
    }
  } else if (source === 'area') {
    appState.recorderWin?.hide()
    createSelectionWindow()
    const selectedGeometry = await new Promise<any | undefined>((resolve) => {
      ipcMain.once('selection:complete', (_e, geo) => {
        appState.selectionWin?.close()
        resolve(geo)
      })
      ipcMain.once('selection:cancel', () => {
        appState.selectionWin?.close()
        appState.recorderWin?.show()
        resolve(undefined)
      })
    })
    if (!selectedGeometry) return { canceled: true }

    const safeWidth = Math.floor(selectedGeometry.width / 2) * 2
    const safeHeight = Math.floor(selectedGeometry.height / 2) * 2
    recordingGeometry = { x: selectedGeometry.x, y: selectedGeometry.y, width: safeWidth, height: safeHeight }

    // Get scale factor for the display containing the selection
    const allDisplays = screen.getAllDisplays()
    const containingDisplay = allDisplays.find((d) => {
      const b = d.bounds
      return selectedGeometry.x >= b.x && selectedGeometry.y >= b.y &&
             selectedGeometry.x + selectedGeometry.width <= b.x + b.width &&
             selectedGeometry.y + selectedGeometry.height <= b.y + b.height
    }) || screen.getPrimaryDisplay()
    const scaleFactor = containingDisplay.scaleFactor || 1
    recordingScaleFactor = scaleFactor  // Store for metadata processing

    // For Windows, convert to physical pixels
    const physicalWidth = process.platform === 'win32' ? Math.floor((safeWidth * scaleFactor) / 2) * 2 : safeWidth
    const physicalHeight = process.platform === 'win32' ? Math.floor((safeHeight * scaleFactor) / 2) * 2 : safeHeight
    const physicalX = process.platform === 'win32' ? Math.floor(selectedGeometry.x * scaleFactor) : selectedGeometry.x
    const physicalY = process.platform === 'win32' ? Math.floor(selectedGeometry.y * scaleFactor) : selectedGeometry.y

    switch (process.platform) {
      case 'linux':
        baseFfmpegArgs.push(
          '-f',
          'x11grab',
          '-framerate', '60',
          '-draw_mouse',
          '0',
          '-video_size',
          `${safeWidth}x${safeHeight}`,
          '-i',
          `${display}+${selectedGeometry.x},${selectedGeometry.y}`,
        )
        break
      case 'win32':
        baseFfmpegArgs.push(
          '-f',
          'gdigrab',
          '-framerate', '60',
          '-draw_mouse',
          '0',
          '-offset_x',
          physicalX.toString(),
          '-offset_y',
          physicalY.toString(),
          '-video_size',
          `${physicalWidth}x${physicalHeight}`,
          '-i',
          'desktop',
        )
        break
      case 'darwin':
        // Note: macOS avfoundation doesn't support area capture like gdigrab/x11grab
        // Area selection on macOS would require a different approach
        log.warn('[RecordingManager] Area selection not supported on macOS')
        appState.recorderWin?.show()
        return { canceled: true }
    }
  } else {
    return { canceled: true }
  }

  // Only get/store original cursor scale on Linux
  if (process.platform === 'linux') {
    appState.originalCursorScale = await getCursorScale()
  }
  log.info('[RecordingManager] Starting actual recording with args:', baseFfmpegArgs)
  return startActualRecording(baseFfmpegArgs, !!webcam, !!mic, recordingGeometry, recordingScaleFactor)
}

/**
 * Handles the graceful stop of a recording, saves files, validates them, and opens the editor.
 */
export async function stopRecording() {
  restoreOriginalCursorScale()
  log.info('Stopping recording, preparing to save...')
  appState.tray?.destroy()
  appState.tray = null
  createSavingWindow()

  // Step 1: Wait for FFmpeg and tracker to finish
  await cleanupAndSave()
  log.info('FFmpeg process finished and file is finalized.')

  const session = appState.currentRecordingSession
  if (!session) {
    log.error('[StopRecord] No recording session found after cleanup. Aborting.')
    appState.savingWin?.close()
    appState.recorderWin?.show()
    return
  }

  // Notify recorder window that the recording has finished, allowing it to reset its UI
  appState.recorderWin?.webContents.send('recording-finished', { canceled: false, ...session })

  // Step 2: Trim audio file if present
  if (session.audioPath) {
    try {
      log.info('[StopRecord] Trimming audio file by 1000ms...')
      await trimAudioFile(session.audioPath, 1000)
      log.info('[StopRecord] Audio file trimmed successfully.')
    } catch (error) {
      log.error('[StopRecord] Failed to trim audio file:', error)
      // Continue anyway - audio is trimmed but not critical
    }
  }

  // Step 3: Process and save metadata (after video file is complete)
  await processAndSaveMetadata(session)

  // Step 4: Validate file
  const isValid = await validateRecordingFiles(session)
  if (!isValid) {
    log.error('[StopRecord] Recording validation failed. Discarding files.')
    await cleanupEditorFiles(session)
    appState.currentRecordingSession = null
    appState.savingWin?.close()
    resetCursorScale()
    appState.recorderWin?.show()
    return
  }

  await new Promise((resolve) => setTimeout(resolve, 500))
  appState.savingWin?.close()
  resetCursorScale()

  appState.currentRecordingSession = null
  if (session) {
    createEditorWindow(
      session.screenVideoPath,
      session.metadataPath,
      session.recordingGeometry,
      session.webcamVideoPath,
      session.audioPath,
      session.scaleFactor,
    )
  }
  appState.recorderWin?.close()
}

/**
 * Cancels the recording and discards all associated files and processes.
 */
export async function cancelRecording() {
  log.info('Cancelling recording and deleting files...')
  await cleanupAndDiscard()
  appState.recorderWin?.webContents.send('recording-finished', { canceled: true })
  appState.recorderWin?.show()
}

/**
 * Stops trackers, writes metadata, and gracefully shuts down FFmpeg.
 */
async function cleanupAndSave(): Promise<void> {
  if (appState.mouseTracker) {
    appState.mouseTracker.stop()
    appState.mouseTracker = null
  }

  return new Promise((resolve) => {
    if (appState.ffmpegProcess) {
      const ffmpeg = appState.ffmpegProcess
      appState.ffmpegProcess = null
      ffmpeg.on('close', (code: any) => {
        log.info(`FFmpeg process exited with code ${code}`)
        resolve()
      })
      // Send 'q' for graceful shutdown on Windows, SIGINT on others
      if (process.platform === 'win32') {
        ffmpeg.stdin?.write('q')
        ffmpeg.stdin?.end()
      } else {
        ffmpeg.kill('SIGINT')
      }
    } else {
      resolve()
    }
  })
}

/**
 * Processes mouse events against the final video start time and saves the metadata file.
 * @param session The current recording session.
 * @returns A promise that resolves to true on success, false on failure.
 */
/**
 * Helper function to scale recording geometry for Windows high-DPI displays
 */
function getScaledGeometry(geometry: RecordingGeometry, scaleFactor: number): RecordingGeometry {
  if (process.platform !== 'win32' || scaleFactor === 1) {
    return geometry
  }
  return {
    x: Math.floor(geometry.x * scaleFactor),
    y: Math.floor(geometry.y * scaleFactor),
    width: Math.floor(geometry.width * scaleFactor),
    height: Math.floor(geometry.height * scaleFactor),
  }
}

/**
 * Processes mouse events against the final video start time and saves the metadata file.
 * @param session The current recording session.
 * @returns A promise that resolves to true on success, false on failure.
 */
async function processAndSaveMetadata(session: RecordingSession): Promise<boolean> {
  try {
    const videoStartTime = await getVideoStartTime(session.screenVideoPath)
    log.info(`[SYNC] Precise video start time from ffprobe: ${new Date(videoStartTime).toISOString()}`)

    // On Windows, scale mouse coordinates to match physical video dimensions
    const scaleFactor = session.scaleFactor || 1
    const finalEvents = appState.recordedMouseEvents.map((event) => {
      const scaledX = process.platform === 'win32' ? event.x * scaleFactor : event.x
      const scaledY = process.platform === 'win32' ? event.y * scaleFactor : event.y
      return {
        ...event,
        x: scaledX,
        y: scaledY,
        timestamp: Math.max(0, event.timestamp - videoStartTime),
      }
    })

    // On Windows, also scale the recording geometry to match video dimensions
    const scaledGeometry = getScaledGeometry(session.recordingGeometry, scaleFactor)

    const primaryDisplay = screen.getPrimaryDisplay()
    const finalMetadata = {
      platform: process.platform,
      screenSize: primaryDisplay.size,
      geometry: scaledGeometry,
      syncOffset: 0,
      cursorImages: Object.fromEntries(appState.runtimeCursorImageMap || []),
      events: finalEvents,
    }

    await fsPromises.writeFile(session.metadataPath, JSON.stringify(finalMetadata))
    log.info(`[SYNC] Metadata saved to ${session.metadataPath}`)
    return true
  } catch (err) {
    log.error(`Failed to process and save metadata: ${err}`)
    // Write an empty metadata file to avoid Editor crash
    const scaledGeometry = getScaledGeometry(session.recordingGeometry, session.scaleFactor || 1)
    const errorMetadata = {
      platform: process.platform,
      events: [],
      cursorImages: {},
      geometry: scaledGeometry,
      screenSize: screen.getPrimaryDisplay().size,
      syncOffset: 0,
    }
    await fsPromises.writeFile(session.metadataPath, JSON.stringify(errorMetadata))
    return false
  }
}

/**
 * Forcefully terminates all recording processes and deletes any temporary files.
 */
export async function cleanupAndDiscard() {
  if (!appState.currentRecordingSession) return
  log.warn('[Cleanup] Discarding current recording session.')
  const sessionToDiscard = { ...appState.currentRecordingSession }
  appState.currentRecordingSession = null

  appState.ffmpegProcess?.kill('SIGKILL')
  appState.ffmpegProcess = null

  appState.mouseTracker?.stop()
  appState.mouseTracker = null

  appState.recordedMouseEvents = []
  appState.runtimeCursorImageMap = new Map()

  restoreOriginalCursorScale()
  appState.tray?.destroy()
  appState.tray = null

  // Asynchronously delete files to not block the UI
  setTimeout(async () => {
    await cleanupEditorFiles(sessionToDiscard)
  }, 200)
}

/**
 * Scans the recording directory for leftover files from crashed sessions and deletes them.
 */
export async function cleanupOrphanedRecordings() {
  log.info('[Cleanup] Starting orphaned recording cleanup...')
  const recordingDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.screenarc')
  const protectedFiles = new Set<string>()

  // Protect files from the currently active editor or recording session
  if (appState.currentEditorSessionFiles) {
    Object.values(appState.currentEditorSessionFiles).forEach((file) => file && protectedFiles.add(file))
  }
  if (appState.currentRecordingSession) {
    Object.values(appState.currentRecordingSession).forEach((file) => file && protectedFiles.add(String(file)))
  }

  try {
    const allFiles = await fsPromises.readdir(recordingDir)
    const filePattern = /^ScreenArc-recording-\d+(-screen\.mp4|-webcam\.mp4|\.json)$/
    const filesToDelete = allFiles
      .filter((file) => filePattern.test(file))
      .map((file) => path.join(recordingDir, file))
      .filter((fullPath) => !protectedFiles.has(fullPath))

    if (filesToDelete.length === 0) {
      log.info('[Cleanup] No orphaned files found.')
      return
    }
    log.warn(`[Cleanup] Found ${filesToDelete.length} orphaned files to delete.`)
    for (const filePath of filesToDelete) {
      try {
        await fsPromises.unlink(filePath)
        log.info(`[Cleanup] Deleted orphaned file: ${filePath}`)
      } catch (unlinkError) {
        log.error(`[Cleanup] Failed to delete orphaned file: ${filePath}`, unlinkError)
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.error('[Cleanup] Error during orphaned file cleanup:', error)
    }
  }
}

/**
 * Event handler for application quit, ensuring recordings are cleaned up before exit.
 */
export async function onAppQuit(event: Electron.Event) {
  if (appState.currentRecordingSession && !appState.isCleanupInProgress) {
    log.warn('[AppQuit] Active session detected. Cleaning up before exit...')
    event.preventDefault()
    appState.isCleanupInProgress = true
    try {
      await cleanupAndDiscard()
      log.info('[AppQuit] Cleanup finished.')
    } catch (error) {
      log.error('[AppQuit] Error during cleanup:', error)
    } finally {
      app.quit()
    }
  }
}

/**
 * Opens a file dialog to allow the user to import an existing video file for editing.
 */
export async function loadVideoFromFile() {
  log.info('[RecordingManager] Received load video from file request.')
  const recorderWindow = appState.recorderWin
  if (!recorderWindow) return { canceled: true }

  const { canceled, filePaths } = await dialog.showOpenDialog(recorderWindow, {
    title: 'Select a video file to edit',
    properties: ['openFile'],
    filters: [{ name: 'Videos', extensions: ['mp4', 'mov', 'webm', 'mkv'] }],
  })

  if (canceled || filePaths.length === 0) return { canceled: true }

  const sourceVideoPath = filePaths[0]
  log.info(`[RecordingManager] User selected video file: ${sourceVideoPath}`)
  recorderWindow.hide()
  createSavingWindow()

  try {
    const recordingDir = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.screenarc')
    await ensureDirectoryExists(recordingDir)
    const baseName = `ScreenArc-recording-${Date.now()}`
    const screenVideoPath = path.join(recordingDir, `${baseName}-screen.mp4`)
    const metadataPath = path.join(recordingDir, `${baseName}.json`)

    await fsPromises.copyFile(sourceVideoPath, screenVideoPath)
    await fsPromises.writeFile(
      metadataPath,
      JSON.stringify({
        platform: process.platform,
        events: [],
        cursorImages: {},
        syncOffset: 0,
      }),
      'utf-8',
    )

    // A "fake" geometry is needed for imported videos. It will match the video dimensions.
    const session: RecordingSession = {
      screenVideoPath,
      metadataPath,
      webcamVideoPath: undefined,
      recordingGeometry: { x: 0, y: 0, width: 0, height: 0 },
      scaleFactor: 1,  // No scaling for imported videos
    }
    const isValid = await validateRecordingFiles(session)
    if (!isValid) {
      await cleanupEditorFiles(session)
      appState.savingWin?.close()
      recorderWindow.show()
      return { canceled: true }
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
    appState.savingWin?.close()
    createEditorWindow(screenVideoPath, metadataPath, session.recordingGeometry, undefined, undefined, session.scaleFactor)
    recorderWindow.close()
    return { canceled: false, filePath: screenVideoPath }
  } catch (error) {
    log.error('[RecordingManager] Error loading video from file:', error)
    dialog.showErrorBox('Error Loading Video', `An error occurred while loading the video: ${(error as Error).message}`)
    appState.savingWin?.close()
    if (recorderWindow && !recorderWindow.isDestroyed()) {
      recorderWindow.show()
    }
    return { canceled: true }
  }
}
