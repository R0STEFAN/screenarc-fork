// Wallpapers
export const WALLPAPERS = [
  { imageUrl: 'wallpapers/images/wallpaper-0001.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0001.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0002.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0002.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0003.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0003.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0004.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0004.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0005.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0005.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0006.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0006.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0007.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0007.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0008.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0008.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0009.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0009.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0010.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0010.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0011.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0011.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0012.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0012.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0013.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0013.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0014.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0014.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0015.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0015.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0016.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0016.jpg' },
  { imageUrl: 'wallpapers/images/wallpaper-0017.jpg', thumbnailUrl: 'wallpapers/thumbnails/wallpaper-0017.jpg' },
]
export const WALLPAPERS_THUMBNAILS = WALLPAPERS.map((w) => w.thumbnailUrl)

// Resolutions
export const RESOLUTIONS = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
}

// Application-wide constants
export const APP = {
  LAST_PRESET_ID_KEY: 'screenarc_lastActivePresetId',
}

// Timeline specific constants
export const TIMELINE = {
  MINIMUM_REGION_DURATION: 0.1, // 100ms
  REGION_DELETE_THRESHOLD: 0.05, // 50ms - Regions smaller than this on mouse up are deleted.
}

// Zoom and Pan specific constants
export const ZOOM = {
  DEFAULT_SPEED: 'Mellow',
  SPEED_OPTIONS: {
    Slow: 1.5,
    Mellow: 1.0,
    Quick: 0.7,
    Rapid: 0.4,
  },
  DEFAULT_LEVEL: 1.5, // Default zoom level when adding a new region
  DEFAULT_DURATION: 3.0, // Default duration when adding a new region
  DEFAULT_EASING: 'Balanced',

  // --- Auto-Zoom Generation ---
  AUTO_ZOOM_PRE_CLICK_OFFSET: 1.0, // Time to start zoom before the first click
  AUTO_ZOOM_POST_CLICK_PADDING: 0.9, // Time to hold zoom after the last click
  AUTO_ZOOM_MIN_DURATION: 3.0, // Minimum duration for an auto-generated zoom region
  PAN_EASING: 'Balanced', // Easing function for pan transitions
}

// --- Editor Defaults ---
export const DEFAULTS = {
  FRAME: {
    PADDING: { min: 0, max: 30, step: 1, defaultValue: 5 },
    RADIUS: { min: 0, max: 100, step: 1, defaultValue: 16 },
    SHADOW: {
      BLUR: { min: 0, max: 100, step: 1, defaultValue: 35 },
      OFFSET_X: { min: -50, max: 50, step: 1, defaultValue: 0 },
      OFFSET_Y: { min: -50, max: 50, step: 1, defaultValue: 15 },
      OPACITY: { min: 0, max: 1, step: 0.01, defaultValue: 0.8 },
      DEFAULT_COLOR_HEX: '#000000',
      DEFAULT_COLOR_RGBA: 'rgba(0, 0, 0, 0.8)',
    },
    BORDER: {
      WIDTH: { min: 0, max: 20, step: 1, defaultValue: 4 },
      DEFAULT_COLOR_HEX: '#ffffff',
      DEFAULT_COLOR_RGBA: 'rgba(255, 255, 255, 0.2)',
    },
  },
  CAMERA: {
    STYLE: {
      SHAPE: { defaultValue: 'square' as const, values: ['circle', 'square', 'rectangle'] as const },
      RADIUS: { min: 0, max: 50, step: 1, defaultValue: 35 },
      FLIP: { defaultValue: false },
      SCALE_ON_ZOOM: { defaultValue: true },
    },
    PLACEMENT: {
      SIZE: { min: 10, max: 50, step: 1, defaultValue: 40 },
      POSITION: { defaultValue: 'bottom-right' },
    },
    EFFECTS: {
      BLUR: { min: 0, max: 80, step: 1, defaultValue: 20 },
      OFFSET_X: { min: -40, max: 40, step: 1, defaultValue: 0 },
      OFFSET_Y: { min: -40, max: 40, step: 1, defaultValue: 10 },
      OPACITY: { min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
      DEFAULT_COLOR_RGBA: 'rgba(0, 0, 0, 0.4)',
    },
    SMART_POSITION: {
      ENABLED: { defaultValue: true },
      LOOKAHEAD_TIME: 0.1, // seconds
      TRANSITION_DURATION: 0.5, // 300ms for a smooth transition
      EASING: 'Balanced',
    },
    SCALE_ON_ZOOM_AMOUNT: 0.8,
    // Camera movement smoothing parameters
    MOVEMENT: {
      DEAD_ZONE: 10, // pixels - minimum movement threshold before camera follows
      SMOOTHING_FACTOR: 0.03, // Lower value = smoother/slower response (was 0.05)
      SMOOTHING_WINDOW: 0.5, // seconds - time window for smoothing calculation
    },
  },
  AUDIO: {
    VOLUME: { min: 0, max: 1, step: 0.01, defaultValue: 1 },
    MUTED: { defaultValue: false },
  },
  ANIMATION: {
    SPEED: { defaultValue: ZOOM.DEFAULT_SPEED },
    EASING: { defaultValue: ZOOM.DEFAULT_EASING },
    ZOOM_LEVEL: { min: 1, max: 3, step: 0.1, defaultValue: ZOOM.DEFAULT_LEVEL },
  },
  CURSOR: {
    THEME: { defaultValue: 'Default' },
    SCALE: { defaultValue: 2 },
    SHOW_CURSOR: { defaultValue: true },
    SHADOW: {
      BLUR: { min: 0, max: 20, step: 1, defaultValue: 6 },
      OFFSET_X: { min: -20, max: 20, step: 1, defaultValue: 3 },
      OFFSET_Y: { min: -20, max: 20, step: 1, defaultValue: 3 },
      OPACITY: { min: 0, max: 1, step: 0.01, defaultValue: 0.4 },
      DEFAULT_COLOR_RGBA: 'rgba(0, 0, 0, 0.4)',
    },
    CLICK_RIPPLE: {
      ENABLED: { defaultValue: false },
      SIZE: { min: 10, max: 80, step: 1, defaultValue: 30 },
      DURATION: { min: 0.1, max: 2.0, step: 0.05, defaultValue: 0.5 },
      COLOR: { defaultValue: 'rgba(255, 255, 255, 0.8)' },
    },
    CLICK_SCALE: {
      ENABLED: { defaultValue: true },
      AMOUNT: { min: 0.5, max: 1.5, step: 0.05, defaultValue: 0.8 },
      DURATION: { min: 0.1, max: 1, step: 0.05, defaultValue: 0.4 },
      EASING: { defaultValue: 'Balanced' },
    },
  },
}
