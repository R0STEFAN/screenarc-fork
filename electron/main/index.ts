// Entry point of the Electron application.

import { app, BrowserWindow, protocol, ProtocolRequest, ProtocolResponse, Menu, screen, dialog } from 'electron'
import log from 'electron-log/main'
import path from 'node:path'
import fsSync from 'node:fs'
import { VITE_PUBLIC } from './lib/constants'
import { setupLogging } from './lib/logging'
import { registerIpcHandlers } from './ipc'
import { createRecorderWindow } from './windows/recorder-window'
import { onAppQuit, startRecording, loadVideoFromFile } from './features/recording-manager'
import { initializeMouseTrackerDependencies } from './features/mouse-tracker'
import { appState } from './state'

// --- Initialization ---
setupLogging()

// Enable WebCodecs in renderer/worker contexts
app.commandLine.appendSwitch('enable-features', 'WebCodecs,WebCodecsExperimental')
app.commandLine.appendSwitch('enable-blink-features', 'WebCodecs,WebCodecsExperimental')

// --- App Lifecycle Events ---
app.on('window-all-closed', () => {
  log.info('[App] All windows closed. Quitting.')
  app.quit()
})

app.on('before-quit', onAppQuit)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createRecorderWindow()
  }
})

app.whenReady().then(async () => {
  log.info('[App] Ready. Initializing...')

  // Set Dock Menu on macOS
  if (process.platform === 'darwin') {
    const dockMenu = Menu.buildFromTemplate([
      {
        label: 'New Default Recording',
        click: () => {
          if (appState.editorWin && !appState.editorWin.isDestroyed()) {
            dialog.showErrorBox(
              'Action Not Allowed',
              'Please close the current editor session to start a new recording.',
            )
            appState.editorWin.focus()
            return
          }
          if (appState.currentRecordingSession) {
            dialog.showErrorBox('Recording in Progress', 'A recording is already in progress.')
            return
          }

          if (!appState.recorderWin || appState.recorderWin.isDestroyed()) {
            createRecorderWindow()
          }
          appState.recorderWin?.show()

          const primaryDisplay = screen.getPrimaryDisplay()
          startRecording({
            source: 'fullscreen',
            displayId: primaryDisplay.id,
            mic: undefined,
            webcam: undefined,
          })
        },
      },
      {
        label: 'Import Video File...',
        click: () => {
          if (appState.editorWin && !appState.editorWin.isDestroyed()) {
            dialog.showErrorBox('Action Not Allowed', 'Please close the current editor session to import a new video.')
            appState.editorWin.focus()
            return
          }
          if (appState.currentRecordingSession) {
            dialog.showErrorBox('Recording in Progress', 'A recording is already in progress.')
            return
          }

          if (!appState.recorderWin || appState.recorderWin.isDestroyed()) {
            createRecorderWindow()
          }
          appState.recorderWin?.show()
          loadVideoFromFile()
        },
      },
    ])
    app.dock.setMenu(dockMenu)
  }

  // Initialize platform-specific dependencies asynchronously
  initializeMouseTrackerDependencies()

  // Register custom protocol for media files
  protocol.registerFileProtocol(
    'media',
    (request: ProtocolRequest, callback: (response: string | ProtocolResponse) => void) => {
      let url = request.url.replace('media://', '')
      let decodedUrl = decodeURIComponent(url)
      
      // Handle Windows drives (e.g., /C:/Users... => C:/Users...)
      if (process.platform === 'win32' && decodedUrl.startsWith('/') && decodedUrl.includes(':')) {
         decodedUrl = decodedUrl.substring(1)
      }

      const resourcePath = path.join(VITE_PUBLIC, decodedUrl)

      // Add CORS headers to local file response
      const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Allow-Methods': 'GET',
      }

      if (path.isAbsolute(decodedUrl) && fsSync.existsSync(decodedUrl)) {
        return callback({ path: decodedUrl, headers })
      }
      if (fsSync.existsSync(resourcePath)) {
        return callback({ path: resourcePath, headers })
      }
      
      log.error(`[Protocol] Could not find file: ${decodedUrl} (from ${request.url})`)
      return callback({ error: -6 }) // FILE_NOT_FOUND
    },
  )

  registerIpcHandlers()
  createRecorderWindow()
})
