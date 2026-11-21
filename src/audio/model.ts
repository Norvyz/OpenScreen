import type { AudioTrackKind, AudioTrackSettings } from '@shared/audio'

/** Subconjunto de `MediaTrackConstraints` que no depende de los tipos DOM en pruebas Node. */
export interface AudioInputConstraints {
  deviceId?: { exact: string }
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
}

/** Opus dentro de WebM: es el códec de audio nativo de MediaRecorder en Chromium. */
const AUDIO_MIME_PREFERENCES = [
  'audio/webm;codecs=opus',
  'audio/webm'
] as const

export function chooseAudioMimeType(isSupported: (type: string) => boolean): string | null {
  return AUDIO_MIME_PREFERENCES.find(isSupported) ?? null
}

export function microphoneConstraints(
  deviceId: string | null,
  noiseSuppression = true
): AudioInputConstraints {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression,
    autoGainControl: true
  }
}

/** Un dispositivo virtual que transporta audio del sistema no debe procesarse como voz. */
export function virtualDeviceConstraints(deviceId: string): AudioInputConstraints {
  return {
    deviceId: { exact: deviceId },
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
}

export function audioStateLabel(kind: AudioTrackKind): string {
  return kind === 'microphone' ? 'Micrófono' : 'Audio del sistema'
}

export function isAudible(settings: AudioTrackSettings): boolean {
  return settings.enabled && !settings.muted && settings.volume > 0
}
