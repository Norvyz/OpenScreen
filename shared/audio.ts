import { z } from 'zod'

/**
 * Contrato del subsistema de audio. El renderer enumera dispositivos con la Web Audio API y
 * main decide qué puede concederse en cada plataforma (permisos y loopback del sistema).
 */
export const AUDIO_TRACK_KINDS = ['microphone', 'system'] as const
export const audioTrackKindSchema = z.enum(AUDIO_TRACK_KINDS)
export type AudioTrackKind = z.infer<typeof audioTrackKindSchema>

export const AUDIO_SYSTEM_MODES = ['auto', 'device'] as const
export const audioSystemModeSchema = z.enum(AUDIO_SYSTEM_MODES)
export type AudioSystemMode = z.infer<typeof audioSystemModeSchema>

export const AUDIO_PLATFORMS = ['win32', 'darwin', 'linux', 'other'] as const
export const audioPlatformSchema = z.enum(AUDIO_PLATFORMS)
export type AudioPlatform = z.infer<typeof audioPlatformSchema>

export const AUDIO_PERMISSIONS = [
  'granted',
  'denied',
  'not-determined',
  'restricted',
  'unsupported',
  'unknown'
] as const
export const audioPermissionSchema = z.enum(AUDIO_PERMISSIONS)
export type AudioPermission = z.infer<typeof audioPermissionSchema>

export const AUDIO_SYSTEM_SUPPORT = ['available', 'unavailable', 'experimental'] as const
export const audioSystemSupportSchema = z.enum(AUDIO_SYSTEM_SUPPORT)
export type AudioSystemSupport = z.infer<typeof audioSystemSupportSchema>

export const AUDIO_SYSTEM_METHODS = ['electron-loopback', 'virtual-device', 'none'] as const
export const audioSystemMethodSchema = z.enum(AUDIO_SYSTEM_METHODS)
export type AudioSystemMethod = z.infer<typeof audioSystemMethodSchema>

/** Ajustes persistentes de una pista. `volume` es ganancia lineal (0 = silencio, 2 = +6 dB). */
export const audioTrackSettingsSchema = z
  .object({
    enabled: z.boolean(),
    deviceId: z.string().nullable(),
    volume: z.number().min(0).max(2),
    muted: z.boolean(),
    /** Supresión de ruido del micrófono (constraint + filtro cuando esté disponible). */
    noiseSuppression: z.boolean().optional()
  })
  .strict()
export type AudioTrackSettings = z.infer<typeof audioTrackSettingsSchema>

export const audioSettingsSchema = z
  .object({
    microphone: audioTrackSettingsSchema,
    system: audioTrackSettingsSchema.extend({
      mode: audioSystemModeSchema,
      muteOnCapture: z.boolean()
    }),
    separateTracks: z.boolean()
  })
  .strict()
export type AudioSettings = z.infer<typeof audioSettingsSchema>

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  microphone: { enabled: true, deviceId: null, volume: 1, muted: false, noiseSuppression: true },
  system: {
    enabled: true,
    deviceId: null,
    volume: 1,
    muted: false,
    mode: 'auto',
    muteOnCapture: true
  },
  separateTracks: true
}

/** Dispositivo real devuelto por `enumerateDevices()`; nunca se inventa uno. */
export const audioDeviceSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    groupId: z.string().nullable(),
    kind: z.literal('audioinput')
  })
  .strict()
export type AudioDevice = z.infer<typeof audioDeviceSchema>

/** Capacidades declaradas por main. Nunca afirma compatibilidad no probada. */
export const audioSupportSchema = z
  .object({
    platform: audioPlatformSchema,
    microphonePermission: audioPermissionSchema,
    systemAudio: audioSystemSupportSchema,
    systemMethod: audioSystemMethodSchema,
    notes: z.array(z.string())
  })
  .strict()
export type AudioSupport = z.infer<typeof audioSupportSchema>

/** Estado de una pista durante la grabación; main solo confirma lo que renderer le informa. */
export const audioTrackRuntimeSchema = z
  .object({
    kind: audioTrackKindSchema,
    enabled: z.boolean(),
    active: z.boolean(),
    deviceId: z.string().nullable(),
    label: z.string().nullable(),
    error: z.string().nullable()
  })
  .strict()
export type AudioTrackRuntime = z.infer<typeof audioTrackRuntimeSchema>

/** Archivo de audio independiente generado junto al vídeo. */
export const audioTrackFileSchema = z
  .object({
    kind: audioTrackKindSchema,
    path: z.string(),
    name: z.string(),
    mimeType: z.string()
  })
  .strict()
export type AudioTrackFile = z.infer<typeof audioTrackFileSchema>

export function gainFor(track: Pick<AudioTrackSettings, 'volume' | 'muted'>): number {
  return track.muted ? 0 : track.volume
}

/** Etiqueta legible para la pista; si el dispositivo no dio nombre, se indica. */
export function trackLabel(kind: AudioTrackKind, devices: readonly AudioDevice[], id: string | null): string {
  if (!id) return kind === 'microphone' ? 'Micrófono predeterminado' : 'Salida del sistema'
  return devices.find((device) => device.id === id)?.label || 'Dispositivo sin nombre'
}
