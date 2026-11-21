import { z } from 'zod'
import {
  audioSettingsSchema,
  audioTrackSettingsSchema,
  DEFAULT_AUDIO_SETTINGS
} from './audio'
import { captureRegionSchema, sourceRefSchema } from './capture'
import {
  DEFAULT_SHORTCUT_SETTINGS,
  shortcutSettingsSchema
} from './shortcuts'
import {
  ffmpegPresetSchema,
  hardwareAccelerationSchema,
  recordingFpsSchema,
  recordingFormatSchema,
  recordingProfileSchema,
  recordingQualitySchema,
  recordingResolutionSchema,
  videoCodecSchema,
  type RecordingProfile
} from './encoding'

/**
 * Esquema de ajustes persistentes.
 *
 * - Lo que se lee de disco se interpreta de forma tolerante: cada campo inválido o ausente
 *   cae a su valor por defecto, de modo que un archivo corrupto o de una versión anterior
 *   nunca impide arrancar la aplicación.
 * - Lo que llega por IPC (`settingsPatchSchema`) es estricto: se rechaza cualquier clave
 *   desconocida o valor fuera de rango.
 */

export const THEMES = ['dark', 'light', 'system'] as const
export const themeSchema = z.enum(THEMES)
export type Theme = z.infer<typeof themeSchema>

const appearanceSchema = z.object({
  theme: themeSchema.catch('dark'),
  reduceMotion: z.boolean().catch(false)
})

/**
 * La fuente elegida se guarda como referencia, nunca como fuente viva: al reaplicarla se
 * comprueba que siga existiendo (los ids de `desktopCapturer` no son estables).
 */
const captureSettingsSchema = z
  .object({
    source: sourceRefSchema.nullable().catch(null),
    region: captureRegionSchema.nullable().catch(null)
  })
  .catch({ source: null, region: null })

const DEFAULT_RECORDING_SETTINGS = {
  // `null` = carpeta de vídeos del sistema, resuelta en main.
  outputDir: null as string | null,
  showCursor: true,
  quality: 'balanced' as z.infer<typeof recordingQualitySchema>,
  format: 'webm' as z.infer<typeof recordingFormatSchema>,
  resolution: 'original' as z.infer<typeof recordingResolutionSchema>,
  fps: 30 as z.infer<typeof recordingFpsSchema>,
  codec: 'auto' as z.infer<typeof videoCodecSchema>,
  hardware: 'auto' as z.infer<typeof hardwareAccelerationSchema>,
  /** Solo se usa cuando `quality === 'custom'`. */
  bitrate: null as number | null,
  /** Solo se usa en la ruta FFmpeg; `null` = CRF del preset de calidad. */
  crf: null as number | null,
  keyframeInterval: null as number | null,
  preset: null as z.infer<typeof ffmpegPresetSchema> | null,
  /** Cuenta atrás antes de iniciar la grabación (0, 3, 5 o 10 segundos). */
  countdown: 3 as number,
  /** Perfiles creados por el usuario; los integrados se añaden en la interfaz. */
  profiles: [] as RecordingProfile[],
  activeProfileId: null as string | null,
  fileNameTemplate: 'OpenScreen-{date}-{time}',
  // `null` = buscar `ffmpeg` en PATH; si se indica, debe ser un ejecutable real.
  ffmpegPath: null as string | null
}

const recordingSettingsSchema = z
  .object({
    outputDir: z.string().nullable().catch(DEFAULT_RECORDING_SETTINGS.outputDir),
    showCursor: z.boolean().catch(DEFAULT_RECORDING_SETTINGS.showCursor),
    quality: recordingQualitySchema.catch(DEFAULT_RECORDING_SETTINGS.quality),
    format: recordingFormatSchema.catch(DEFAULT_RECORDING_SETTINGS.format),
    resolution: recordingResolutionSchema.catch(DEFAULT_RECORDING_SETTINGS.resolution),
    fps: recordingFpsSchema.catch(DEFAULT_RECORDING_SETTINGS.fps),
    codec: videoCodecSchema.catch(DEFAULT_RECORDING_SETTINGS.codec),
    hardware: hardwareAccelerationSchema.catch(DEFAULT_RECORDING_SETTINGS.hardware),
    bitrate: z.number().int().min(500_000).max(100_000_000).nullable().catch(null),
    crf: z.number().int().min(0).max(51).nullable().catch(null),
    keyframeInterval: z.number().int().min(1).max(600).nullable().catch(null),
    preset: ffmpegPresetSchema.nullable().catch(null),
    countdown: z.number().int().refine((v) => [0, 3, 5, 10].includes(v), 'Cuenta atrás no soportada').optional(),
    profiles: z.array(recordingProfileSchema).catch([]),
    activeProfileId: z.string().nullable().catch(null),
    fileNameTemplate: z.string().min(1).catch(DEFAULT_RECORDING_SETTINGS.fileNameTemplate),
    ffmpegPath: z.string().nullable().catch(DEFAULT_RECORDING_SETTINGS.ffmpegPath)
  })
  .catch(DEFAULT_RECORDING_SETTINGS)

export const LANGUAGES = ['es', 'en'] as const
export const languageSchema = z.enum(LANGUAGES)
export type Language = z.infer<typeof languageSchema>

export const START_PAGES = ['home', 'record', 'library', 'settings'] as const
export const startupPageSchema = z.enum(START_PAGES)
export type StartupPage = z.infer<typeof startupPageSchema>

const notificationSettingsSchema = z
  .object({
    enabled: z.boolean().catch(true),
    recordingComplete: z.boolean().catch(true),
    errors: z.boolean().catch(true)
  })
  .strict()

export const DEFAULT_NOTIFICATION_SETTINGS = {
  enabled: true,
  recordingComplete: true,
  errors: true
}

export const generalSettingsSchema = z
  .object({
    /** Solo se aplica en la app instalada y en plataformas donde Electron lo soporte. */
    startAtLogin: z.boolean().catch(false),
    startMinimized: z.boolean().catch(false),
    minimizeOnClose: z.boolean().catch(false),
    language: languageSchema.catch('es'),
    startupPage: startupPageSchema.catch('home'),
    notifications: notificationSettingsSchema.catch({ ...DEFAULT_NOTIFICATION_SETTINGS })
  })
  .strict()

export const DEFAULT_GENERAL_SETTINGS = {
  startAtLogin: false,
  startMinimized: false,
  minimizeOnClose: false,
  language: 'es' as Language,
  startupPage: 'home' as StartupPage,
  notifications: { ...DEFAULT_NOTIFICATION_SETTINGS }
}

export const performanceSettingsSchema = z
  .object({
    /** Aviso de espacio libre; nunca borra grabaciones del usuario automáticamente. */
    storageWarningGb: z.number().min(0.5).max(100).catch(2),
    thumbnailCacheLimit: z.number().int().min(8).max(100).catch(24),
    errorHistoryLimit: z.number().int().min(10).max(200).catch(50)
  })
  .strict()

export const DEFAULT_PERFORMANCE_SETTINGS = {
  storageWarningGb: 2,
  thumbnailCacheLimit: 24,
  errorHistoryLimit: 50
}

export const settingsSchema = z.object({
  schemaVersion: z.literal(2).catch(2),
  appearance: appearanceSchema.catch({ theme: 'dark', reduceMotion: false }),
  general: generalSettingsSchema.catch(structuredClone(DEFAULT_GENERAL_SETTINGS)),
  capture: captureSettingsSchema,
  recording: recordingSettingsSchema,
  audio: audioSettingsSchema.catch(structuredClone(DEFAULT_AUDIO_SETTINGS)),
  shortcuts: shortcutSettingsSchema.catch(structuredClone(DEFAULT_SHORTCUT_SETTINGS)),
  performance: performanceSettingsSchema.catch(structuredClone(DEFAULT_PERFORMANCE_SETTINGS))
})

export type Settings = z.infer<typeof settingsSchema>

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 2,
  appearance: { theme: 'dark', reduceMotion: false },
  general: structuredClone(DEFAULT_GENERAL_SETTINGS),
  capture: { source: null, region: null },
  recording: { ...DEFAULT_RECORDING_SETTINGS },
  audio: structuredClone(DEFAULT_AUDIO_SETTINGS),
  shortcuts: structuredClone(DEFAULT_SHORTCUT_SETTINGS),
  performance: structuredClone(DEFAULT_PERFORMANCE_SETTINGS)
}

/** Actualización parcial recibida por IPC. Estricta: no admite claves desconocidas. */
export const settingsPatchSchema = z
  .object({
    appearance: z
      .object({
        theme: themeSchema.optional(),
        reduceMotion: z.boolean().optional()
      })
      .strict()
      .optional(),
    general: z
      .object({
        startAtLogin: z.boolean().optional(),
        startMinimized: z.boolean().optional(),
        minimizeOnClose: z.boolean().optional(),
        language: languageSchema.optional(),
        startupPage: startupPageSchema.optional(),
        notifications: notificationSettingsSchema.partial().optional()
      })
      .strict()
      .optional(),
    capture: z
      .object({
        source: sourceRefSchema.nullable().optional(),
        region: captureRegionSchema.nullable().optional()
      })
      .strict()
      .optional(),
    recording: z
      .object({
        outputDir: z.string().nullable().optional(),
        showCursor: z.boolean().optional(),
        quality: recordingQualitySchema.optional(),
        format: recordingFormatSchema.optional(),
        resolution: recordingResolutionSchema.optional(),
        fps: recordingFpsSchema.optional(),
        codec: videoCodecSchema.optional(),
        hardware: hardwareAccelerationSchema.optional(),
        bitrate: z.number().int().min(500_000).max(100_000_000).nullable().optional(),
        crf: z.number().int().min(0).max(51).nullable().optional(),
        keyframeInterval: z.number().int().min(1).max(600).nullable().optional(),
        preset: ffmpegPresetSchema.nullable().optional(),
        countdown: z.number().int().refine((v) => [0, 3, 5, 10].includes(v)).optional(),
        profiles: z.array(recordingProfileSchema).optional(),
        activeProfileId: z.string().nullable().optional(),
        fileNameTemplate: z.string().min(1).optional(),
        ffmpegPath: z.string().nullable().optional()
      })
      .strict()
      .optional(),
    audio: z
      .object({
        microphone: audioTrackSettingsSchema.partial().optional(),
        system: audioSettingsSchema.shape.system.partial().optional(),
        separateTracks: z.boolean().optional()
      })
      .strict()
      .optional(),
    shortcuts: shortcutSettingsSchema.optional(),
    performance: z
      .object({
        storageWarningGb: z.number().min(0.5).max(100).optional(),
        thumbnailCacheLimit: z.number().int().min(8).max(100).optional(),
        errorHistoryLimit: z.number().int().min(10).max(200).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** Interpreta datos de origen no confiable (archivo en disco) y devuelve ajustes válidos. */
export function parseStoredSettings(raw: unknown): Settings {
  return settingsSchema.catch(DEFAULT_SETTINGS).parse(raw)
}

/** Aplica una actualización parcial sin mutar los ajustes actuales. */
export function mergeSettings(current: Settings, patch: SettingsPatch): Settings {
  return {
    ...current,
    appearance: {
      theme: patch.appearance?.theme ?? current.appearance.theme,
      reduceMotion: patch.appearance?.reduceMotion ?? current.appearance.reduceMotion
    },
    general: {
      startAtLogin: patch.general?.startAtLogin ?? current.general.startAtLogin,
      startMinimized: patch.general?.startMinimized ?? current.general.startMinimized,
      minimizeOnClose: patch.general?.minimizeOnClose ?? current.general.minimizeOnClose,
      language: patch.general?.language ?? current.general.language,
      startupPage: patch.general?.startupPage ?? current.general.startupPage,
      notifications: {
        ...current.general.notifications,
        ...patch.general?.notifications
      }
    },
    capture: {
      source: patch.capture?.source !== undefined ? patch.capture.source : current.capture.source,
      region: patch.capture?.region !== undefined ? patch.capture.region : current.capture.region
    },
    recording: {
      outputDir:
        patch.recording?.outputDir !== undefined
          ? patch.recording.outputDir
          : current.recording.outputDir,
      showCursor:
        patch.recording?.showCursor !== undefined
          ? patch.recording.showCursor
          : current.recording.showCursor,
      quality: patch.recording?.quality !== undefined
        ? patch.recording.quality
        : current.recording.quality,
      format: patch.recording?.format !== undefined
        ? patch.recording.format
        : current.recording.format,
      resolution:
        patch.recording?.resolution !== undefined
          ? patch.recording.resolution
          : current.recording.resolution,
      fps: patch.recording?.fps !== undefined ? patch.recording.fps : current.recording.fps,
      codec: patch.recording?.codec !== undefined ? patch.recording.codec : current.recording.codec,
      hardware:
        patch.recording?.hardware !== undefined
          ? patch.recording.hardware
          : current.recording.hardware,
      bitrate:
        patch.recording?.bitrate !== undefined ? patch.recording.bitrate : current.recording.bitrate,
      crf: patch.recording?.crf !== undefined ? patch.recording.crf : current.recording.crf,
      keyframeInterval:
        patch.recording?.keyframeInterval !== undefined
          ? patch.recording.keyframeInterval
          : current.recording.keyframeInterval,
      preset:
        patch.recording?.preset !== undefined ? patch.recording.preset : current.recording.preset,
      countdown:
        patch.recording?.countdown !== undefined ? patch.recording.countdown : (current.recording.countdown ?? 3),
      profiles:
        patch.recording?.profiles !== undefined
          ? patch.recording.profiles
          : current.recording.profiles,
      activeProfileId:
        patch.recording?.activeProfileId !== undefined
          ? patch.recording.activeProfileId
          : current.recording.activeProfileId,
      fileNameTemplate:
        patch.recording?.fileNameTemplate !== undefined
          ? patch.recording.fileNameTemplate
          : current.recording.fileNameTemplate,
      ffmpegPath:
        patch.recording?.ffmpegPath !== undefined
          ? patch.recording.ffmpegPath
          : current.recording.ffmpegPath
    },
    audio: {
      microphone: {
        ...current.audio.microphone,
        ...patch.audio?.microphone
      },
      system: {
        ...current.audio.system,
        ...patch.audio?.system
      },
      separateTracks: patch.audio?.separateTracks ?? current.audio.separateTracks
    },
    shortcuts: patch.shortcuts ?? current.shortcuts,
    performance: {
      ...current.performance,
      ...patch.performance
    }
  }
}
