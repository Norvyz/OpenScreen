import { create } from 'zustand'
import type { Unsubscribe } from '@shared/api'
import type { AudioSettings, AudioSupport, AudioTrackKind } from '@shared/audio'
import type { SourceRef } from '@shared/capture'
import {
  EMPTY_ENCODING_CAPABILITIES,
  EMPTY_RENDERER_CAPABILITIES,
  RESOLUTION_SIZES,
  type EncodingCapabilities,
  type RendererEncodingCapabilities
} from '@shared/encoding'
import type { Settings } from '@shared/settings'
import {
  elapsedMs,
  EMPTY_RECORDING_STATUS,
  type RecordingOptions,
  type RecordingStatus
} from '@shared/recording'
import { buildEncodingPlan, captureLimits, recorderBitrate } from '@/encoding/model'
import {
  measureDeliveredFps,
  probeMediaRecorderCapabilities
} from '@/encoding/mediaRecorderProbe'
import {
  pauseAudioEngine,
  resumeAudioEngine,
  startAudioEngine,
  stopAudioEngine
} from '@/audio/audioEngine'
import { getApi } from '@/services/ipc'
import { toMessage } from '@/utils/errors'

export interface StartRecordingInput {
  source: SourceRef
  options: RecordingOptions
  /** Preferencias persistentes de codificación; el plan final usa capacidades reales. */
  preferences: Settings['recording']
  audio: AudioSettings
  support: AudioSupport
}

interface RecordingState {
  status: RecordingStatus
  error: string | null
  busy: boolean
  countdownRemaining: number | null
  ffmpegAvailable: boolean | null
  cursorHonored: boolean | null
  encodingCapabilities: EncodingCapabilities | null
  rendererCapabilities: RendererEncodingCapabilities | null
  planWarnings: string[]
  init: () => Promise<void>
  start: (input: StartRecordingInput) => Promise<void>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  cancel: () => Promise<void>
  checkFfmpeg: () => Promise<boolean>
  refreshCapabilities: () => Promise<void>
}

let unsubscribeStatus: Unsubscribe | null = null
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let activeSessionId: string | null = null
let currentMimeType = ''
let chunkIndex = 0
let appendChain: Promise<void> = Promise.resolve()
let audioAppendChain: Promise<void> = Promise.resolve()
let appendFailure: string | null = null
let discardCurrent = false

type CursorValue = 'always' | 'never'

function cursorSettings(track: MediaStreamTrack): { cursor?: string } {
  return track.getSettings() as MediaTrackSettings & { cursor?: string }
}

/**
 * Chromium expone el constraint no estándar `cursor`. Si la plataforma no lo aplica, lo
 * detectamos y lo comunicamos: nunca afirmamos que el cursor se ocultó si sigue visible.
 */
async function applyCursor(track: MediaStreamTrack, show: boolean): Promise<boolean> {
  const desired: CursorValue = show ? 'always' : 'never'
  if (cursorSettings(track).cursor === desired) return true

  try {
    await track.applyConstraints({
      advanced: [{ cursor: desired }]
    } as unknown as MediaTrackConstraints)
  } catch {
    // Plataforma sin soporte: se refleja en `cursorHonored`.
  }
  return cursorSettings(track).cursor === desired
}

/**
 * Pide tamaño y cadencia como `ideal`: un `exact` incompatible hace que Chromium entregue un
 * stream vacío. Después se comprueban `getSettings()` y los frames realmente recibidos.
 */
function captureVideoConstraints(options: {
  showCursor: boolean
  width: number
  height: number
  fps: number
}): MediaTrackConstraints {
  return {
    width: { ideal: options.width },
    height: { ideal: options.height },
    frameRate: { ideal: options.fps },
    cursor: options.showCursor ? 'always' : 'never'
  } as MediaTrackConstraints
}

async function applyCaptureTargets(
  track: MediaStreamTrack,
  target: { width: number; height: number; fps: number }
): Promise<void> {
  try {
    await track.applyConstraints({
      width: { ideal: target.width },
      height: { ideal: target.height },
      frameRate: { ideal: target.fps }
    })
  } catch {
    // Chromium puede ignorar los constraints; el plan final usa los valores informados.
  }
}

function stopTracks(): void {
  stream?.getTracks().forEach((track) => track.stop())
}

function cleanup(): void {
  if (recorder) {
    recorder.ondataavailable = null
    recorder.onerror = null
    recorder.onpause = null
    recorder.onresume = null
    recorder.onstop = null
    if (recorder.state !== 'inactive') recorder.stop()
  }
  stopTracks()
  recorder = null
  stream = null
  activeSessionId = null
  currentMimeType = ''
  chunkIndex = 0
  appendChain = Promise.resolve()
  audioAppendChain = Promise.resolve()
  appendFailure = null
  discardCurrent = false
}

function reportAudioState(
  track: AudioTrackKind,
  report: { active: boolean; label: string | null; error: string | null }
): void {
  const sessionId = activeSessionId
  if (!sessionId) return
  void getApi()
    .recording.reportAudioState({ sessionId, track, ...report })
    .catch(() => undefined)
}

/** Dueño del `MediaRecorder` del renderer. El archivo y el estado los controla main. */
export const useRecordingStore = create<RecordingState>((set) => ({
  status: { ...EMPTY_RECORDING_STATUS },
  error: null,
  busy: false,
  countdownRemaining: null,
  ffmpegAvailable: null,
  cursorHonored: null,
  encodingCapabilities: null,
  rendererCapabilities: null,
  planWarnings: [],

  init: async () => {
    try {
      const api = getApi()
      unsubscribeStatus?.()
      unsubscribeStatus = api.recording.onStatusChange((status) => set({ status }))
      const [status, ffmpegAvailable] = await Promise.all([
        api.recording.getStatus(),
        api.recording.checkFfmpeg()
      ])
      set({ status, ffmpegAvailable, error: null })
      await useRecordingStore.getState().refreshCapabilities()
    } catch (error) {
      set({ error: toMessage(error) })
    }
  },

  checkFfmpeg: async () => {
    try {
      const api = getApi()
      const ffmpegAvailable = await api.recording.checkFfmpeg()
      const encodingCapabilities = await api.recording.getEncodingCapabilities()
      set({ ffmpegAvailable, encodingCapabilities })
      return ffmpegAvailable
    } catch (error) {
      set({ error: toMessage(error) })
      return false
    }
  },

  refreshCapabilities: async () => {
    try {
      const api = getApi()
      const [snapshot, encodingCapabilities] = await Promise.all([
        api.capture.getSnapshot(),
        api.recording.getEncodingCapabilities()
      ])
      const rendererCapabilities = await probeMediaRecorderCapabilities(captureLimits(snapshot))
      set({ encodingCapabilities, rendererCapabilities })
    } catch (error) {
      set({ error: toMessage(error) })
    }
  },

  start: async ({ source, options, preferences, audio, support }) => {
    if (recorder || activeSessionId) {
      set({ error: 'Ya hay una grabación en curso.' })
      return
    }
    if (!navigator.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') {
      set({ error: 'Este entorno no permite capturar pantalla con MediaRecorder.' })
      return
    }

    set({ busy: true, error: null, planWarnings: [], countdownRemaining: null })
    let acquired: MediaStream | null = null

    try {
      const api = getApi()
      const requestedSize = RESOLUTION_SIZES[preferences.resolution]
      const captureTarget = {
        width: requestedSize?.width ?? source.width ?? 1920,
        height: requestedSize?.height ?? source.height ?? 1080,
        fps: preferences.fps
      }
      const wantsSystemAudio =
        audio.system.enabled &&
        audio.system.mode === 'auto' &&
        support.systemAudio !== 'unavailable'
      // Debe ser la PRIMERA operación asíncrona: cualquier IPC previo consume la activación
      // transitoria del gesto y Chromium rechaza `getDisplayMedia`. Main concede la fuente
      // ya elegida y, en Windows, el loopback del sistema si la pista está activada.
      const countdownSeconds = preferences.countdown ?? 0
      acquired = await navigator.mediaDevices.getDisplayMedia({
        video: captureVideoConstraints({
          showCursor: options.showCursor,
          ...captureTarget
        }),
        audio: wantsSystemAudio,
        systemAudio: wantsSystemAudio ? 'include' : 'exclude',
        surfaceSwitching: 'exclude'
      } as DisplayMediaStreamOptions)
      stream = acquired

      if (countdownSeconds > 0) {
        for (let remaining = countdownSeconds; remaining > 0; remaining -= 1) {
          set({ countdownRemaining: remaining })
          await new Promise<void>((resolve) => {
            window.setTimeout(resolve, 1000)
          })
        }
        set({ countdownRemaining: null })
      }

      const track = acquired.getVideoTracks()[0]
      if (!track) throw new Error('El stream de captura no contiene vídeo.')

      // Solo después de capturar se consultan capacidades: no afectan al gesto del usuario.
      const snapshot = await api.capture.getSnapshot()
      const limits = captureLimits(snapshot)
      let renderer = useRecordingStore.getState().rendererCapabilities
      let ffmpeg = useRecordingStore.getState().encodingCapabilities ?? EMPTY_ENCODING_CAPABILITIES
      if (!renderer) {
        await useRecordingStore.getState().refreshCapabilities()
        renderer = useRecordingStore.getState().rendererCapabilities ?? EMPTY_RENDERER_CAPABILITIES
        ffmpeg = useRecordingStore.getState().encodingCapabilities ?? EMPTY_ENCODING_CAPABILITIES
      }

      const cursorHonored = await applyCursor(track, options.showCursor)
      set({ cursorHonored })

      await applyCaptureTargets(track, captureTarget)
      const measuredFps = await measureDeliveredFps(acquired)
      const settings = track.getSettings()
      const capabilities = track.getCapabilities?.() as MediaTrackCapabilities | undefined
      const planResult = buildEncodingPlan({
        preferences,
        limits: {
          width: limits.width ?? capabilities?.width?.max ?? settings.width ?? null,
          height: limits.height ?? capabilities?.height?.max ?? settings.height ?? null,
          fps: limits.fps ?? capabilities?.frameRate?.max ?? null
        },
        actual: {
          width: settings.width ?? null,
          height: settings.height ?? null,
          fps: settings.frameRate ?? null,
          measuredFps
        },
        renderer,
        ffmpeg
      })
      set({ planWarnings: planResult.warnings })
      const { plan, mimeType } = planResult

      const begun = await api.recording.begin({
        source,
        options,
        audio,
        encoding: plan,
        mimeType,
        extension: plan.format
      })
      activeSessionId = begun.sessionId
      currentMimeType = mimeType
      chunkIndex = 0
      appendFailure = null
      discardCurrent = false
      appendChain = Promise.resolve()
      audioAppendChain = Promise.resolve()
      set({ status: begun })

      const finalStream = await startAudioEngine({
        plan: audio,
        support,
        displayStream: acquired,
        callbacks: {
          onChunk: (audioTrack, index, data) => {
            const sessionId = activeSessionId
            if (!sessionId || discardCurrent || appendFailure) return
            const bytes = data.arrayBuffer()
            audioAppendChain = audioAppendChain.then(async () => {
              try {
                await getApi().recording.appendAudio({
                  sessionId,
                  track: audioTrack,
                  index,
                  data: new Uint8Array(await bytes)
                })
              } catch (error) {
                appendFailure = toMessage(error)
                set({ error: appendFailure })
                discardCurrent = true
                if (recorder && recorder.state !== 'inactive') recorder.stop()
              }
            })
          },
          onReport: (audioTrack, report) => reportAudioState(audioTrack, report)
        }
      })

      const nextRecorder = new MediaRecorder(finalStream, {
        mimeType,
        videoBitsPerSecond: recorderBitrate(plan),
        audioBitsPerSecond: 128_000
      })
      recorder = nextRecorder

      nextRecorder.ondataavailable = (event) => {
        const sessionId = activeSessionId
        if (!sessionId || event.data.size === 0 || appendFailure) return
        const index = chunkIndex
        chunkIndex += 1
        const bytes = event.data.arrayBuffer()
        appendChain = appendChain.then(async () => {
          try {
            const data = new Uint8Array(await bytes)
            await getApi().recording.appendChunk({ sessionId, index, data })
          } catch (error) {
            appendFailure = toMessage(error)
            set({ error: appendFailure })
            if (nextRecorder.state !== 'inactive') nextRecorder.stop()
          }
        })
      }

      nextRecorder.onerror = () => {
        set({ error: 'El motor de captura encontró un error y detuvo la grabación.' })
        discardCurrent = true
        if (nextRecorder.state !== 'inactive') nextRecorder.stop()
      }

      nextRecorder.onstop = async () => {
        const sessionId = activeSessionId
        const mime = currentMimeType
        await appendChain
        await stopAudioEngine()
        await audioAppendChain

        if (!sessionId || discardCurrent || appendFailure) {
          if (sessionId && (discardCurrent || appendFailure)) {
            try {
              await getApi().recording.cancel({ sessionId })
            } catch {
              // El estado de main ya puede haber cambiado; no ocultamos el error original.
            }
          }
          cleanup()
          set({ busy: false, countdownRemaining: null })
          return
        }

        try {
          const current = await getApi().recording.getStatus()
          await getApi().recording.finish({
            sessionId,
            durationMs: elapsedMs(current),
            mimeType: mime
          })
        } catch (error) {
          set({ error: toMessage(error) })
          try {
            await getApi().recording.getStatus().then((latest) => {
              if (latest.sessionId === sessionId) {
                return getApi().recording.cancel({ sessionId })
              }
              return undefined
            })
          } catch {
            // Ya se mostró el error principal.
          }
        } finally {
          cleanup()
          set({ busy: false, countdownRemaining: null })
        }
      }

      track.addEventListener('ended', () => {
        if (nextRecorder.state !== 'inactive') nextRecorder.stop()
      })

      nextRecorder.start(1000)
      set({ busy: false })
    } catch (error) {
      if (activeSessionId) {
        const sessionId = activeSessionId
        try {
          await getApi().recording.cancel({ sessionId })
        } catch {
          // Se limpia igualmente el estado local.
        }
      }
      await stopAudioEngine()
      stopTracks()
      cleanup()
      set({ busy: false, countdownRemaining: null, error: toMessage(error) })
    }
  },

  pause: async () => {
    if (!recorder || recorder.state !== 'recording') return
    set({ busy: true })
    try {
      recorder.pause()
      pauseAudioEngine()
      set({ status: await getApi().recording.pause() })
    } catch (error) {
      set({ error: toMessage(error) })
    } finally {
      set({ busy: false })
    }
  },

  resume: async () => {
    if (!recorder || recorder.state !== 'paused') return
    set({ busy: true })
    try {
      recorder.resume()
      resumeAudioEngine()
      set({ status: await getApi().recording.resume() })
    } catch (error) {
      set({ error: toMessage(error) })
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    if (!recorder || recorder.state === 'inactive') return
    set({ busy: true })
    try {
      recorder.stop()
    } catch (error) {
      await stopAudioEngine()
      set({ error: toMessage(error), busy: false })
    }
  },

  cancel: async () => {
    const sessionId = activeSessionId
    if (!sessionId) return
    discardCurrent = true
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    await stopAudioEngine()
    try {
      set({ status: await getApi().recording.cancel({ sessionId }) })
    } catch (error) {
      set({ error: toMessage(error) })
    } finally {
      cleanup()
    }
  }
}))
