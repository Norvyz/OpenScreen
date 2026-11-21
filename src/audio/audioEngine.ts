import type {
  AudioSettings,
  AudioSupport,
  AudioTrackKind,
  AudioTrackSettings
} from '@shared/audio'
import {
  chooseAudioMimeType,
  microphoneConstraints,
  virtualDeviceConstraints
} from './model'

export interface AudioEngineReport {
  active: boolean
  label: string | null
  error: string | null
}

export interface AudioEngineCallbacks {
  onChunk(track: AudioTrackKind, index: number, data: Blob): void
  onReport(track: AudioTrackKind, report: AudioEngineReport): void
}

export interface StartAudioEngineInput {
  plan: AudioSettings
  support: AudioSupport
  displayStream: MediaStream
  callbacks: AudioEngineCallbacks
}

interface TrackRuntime {
  settings: AudioTrackSettings
  tracks: MediaStreamTrack[]
  label: string | null
  gain: GainNode | null
  analyser: AnalyserNode | null
  recorder: MediaRecorder | null
  destination: MediaStreamAudioDestinationNode | null
  chunkIndex: number
}

const AUDIO_BITRATE = 128_000
const EMPTY_LEVELS: Record<AudioTrackKind, number> = { microphone: 0, system: 0 }

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido de audio.'
}

/**
 * Motor de audio del renderer. Capta micrófono y audio del sistema, alimenta una pista mezclada
 * para el vídeo y, cuando se pide, graba cada fuente en su propio WebM/Opus.
 */
export class AudioEngine {
  private context: AudioContext | null = null
  private readonly runtimes: Record<AudioTrackKind, TrackRuntime>
  private readonly levels: Record<AudioTrackKind, number> = { ...EMPTY_LEVELS }
  private readonly levelData: Partial<Record<AudioTrackKind, Float32Array<ArrayBuffer>>> = {}
  private started = false

  constructor(private readonly callbacks: AudioEngineCallbacks) {
    const empty = (): TrackRuntime => ({
      settings: { enabled: false, deviceId: null, volume: 1, muted: false },
      tracks: [],
      label: null,
      gain: null,
      analyser: null,
      recorder: null,
      destination: null,
      chunkIndex: 0
    })
    this.runtimes = { microphone: empty(), system: empty() }
  }

  async start({ plan, support, displayStream }: StartAudioEngineInput): Promise<MediaStream> {
    const videoTracks = displayStream.getVideoTracks()
    if (videoTracks.length === 0) throw new Error('El stream de captura no contiene vídeo.')
    this.started = true

    if (typeof AudioContext === 'undefined') {
      this.failAll('Este entorno no dispone de Web Audio API.')
      return new MediaStream(videoTracks)
    }

    try {
      this.context = new AudioContext()
      await this.context.resume()
    } catch (error) {
      this.failAll(`No se pudo iniciar el mezclador de audio: ${messageOf(error)}`)
      return new MediaStream(videoTracks)
    }

    const master = this.context.createMediaStreamDestination()
    const kinds: readonly AudioTrackKind[] = ['microphone', 'system']

    for (const kind of kinds) {
      const settings = plan[kind]
      this.runtimes[kind].settings = { ...settings }
      if (!settings.enabled) continue

      let tracks: MediaStreamTrack[] = []
      let label: string | null = null
      try {
        if (kind === 'microphone') {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: microphoneConstraints(settings.deviceId, settings.noiseSuppression ?? true)
          })
          tracks = stream.getAudioTracks()
          label = tracks[0]?.label ?? null
        } else if (plan.system.mode === 'auto') {
          if (support.systemAudio === 'unavailable') {
            throw new Error('La captura automática del sistema no está disponible en esta plataforma.')
          }
          tracks = displayStream.getAudioTracks()
          label = tracks[0]?.label ?? 'Salida del sistema'
        } else {
          if (!settings.deviceId) throw new Error('No se eligió un dispositivo de audio del sistema.')
          const stream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: virtualDeviceConstraints(settings.deviceId)
          })
          tracks = stream.getAudioTracks()
          label = tracks[0]?.label ?? null
        }
        if (tracks.length === 0) throw new Error('El dispositivo no entregó una pista de audio.')
      } catch (error) {
        this.callbacks.onReport(kind, { active: false, label: null, error: messageOf(error) })
        continue
      }

      const source = this.context.createMediaStreamSource(new MediaStream(tracks))
      const gain = this.context.createGain()
      gain.gain.value = settings.muted ? 0 : settings.volume
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 1024
      source.connect(gain)
      source.connect(analyser)
      gain.connect(master)
      if (plan.separateTracks) {
        const destination = this.context.createMediaStreamDestination()
        gain.connect(destination)
        this.runtimes[kind].destination = destination
        this.startSideRecorder(kind, destination.stream)
      }

      this.runtimes[kind] = {
        ...this.runtimes[kind],
        tracks,
        label,
        gain,
        analyser
      }
      this.callbacks.onReport(kind, { active: true, label, error: null })
      tracks.forEach((track) => {
        track.addEventListener('ended', () => {
          this.callbacks.onReport(kind, {
            active: false,
            label,
            error: 'El dispositivo de audio se desconectó durante la grabación.'
          })
        })
      })
    }

    const mixed = master.stream.getAudioTracks()[0]
    return mixed ? new MediaStream([...videoTracks, mixed]) : new MediaStream(videoTracks)
  }

  pause(): void {
    for (const kind of ['microphone', 'system'] as const) {
      const recorder = this.runtimes[kind].recorder
      if (recorder?.state === 'recording') recorder.pause()
    }
  }

  resume(): void {
    for (const kind of ['microphone', 'system'] as const) {
      const recorder = this.runtimes[kind].recorder
      if (recorder?.state === 'paused') recorder.resume()
    }
  }

  setGain(kind: AudioTrackKind, settings: AudioTrackSettings): void {
    const runtime = this.runtimes[kind]
    runtime.settings = { ...settings }
    if (!runtime.gain || !this.context) return
    const value = settings.muted ? 0 : settings.volume
    runtime.gain.gain.setTargetAtTime(value, this.context.currentTime, 0.02)
  }

  getLevel(kind: AudioTrackKind): number {
    const analyser = this.runtimes[kind].analyser
    if (!analyser) return 0
    let data = this.levelData[kind]
    if (!data || data.length !== analyser.fftSize) {
      data = new Float32Array(new ArrayBuffer(analyser.fftSize * Float32Array.BYTES_PER_ELEMENT))
      this.levelData[kind] = data
    }
    analyser.getFloatTimeDomainData(data)
    let sum = 0
    for (const sample of data) sum += sample * sample
    const rms = Math.sqrt(sum / data.length)
    const current = Math.min(1, rms * 4)
    this.levels[kind] = Math.max(current, this.levels[kind] * 0.78)
    return this.levels[kind]
  }

  async stop(): Promise<void> {
    const recorders = (['microphone', 'system'] as const)
      .map((kind) => this.runtimes[kind].recorder)
      .filter((recorder): recorder is MediaRecorder => Boolean(recorder))

    await Promise.all(
      recorders.map(
        (recorder) =>
          new Promise<void>((resolve) => {
            if (recorder.state === 'inactive') return resolve()
            recorder.onstop = () => resolve()
            recorder.stop()
          })
      )
    )

    for (const kind of ['microphone', 'system'] as const) {
      this.runtimes[kind].tracks.forEach((track) => track.stop())
      this.runtimes[kind].recorder = null
      this.runtimes[kind].gain = null
      this.runtimes[kind].analyser = null
      this.runtimes[kind].destination = null
      this.levels[kind] = 0
    }

    if (this.context && this.context.state !== 'closed') {
      await this.context.close().catch(() => undefined)
    }
    this.context = null
    this.started = false
  }

  get isStarted(): boolean {
    return this.started
  }

  private startSideRecorder(kind: AudioTrackKind, stream: MediaStream): void {
    const mimeType = chooseAudioMimeType((type) => MediaRecorder.isTypeSupported(type))
    if (!mimeType) {
      this.callbacks.onReport(kind, {
        active: false,
        label: this.runtimes[kind].label,
        error: 'Chromium no ofrece codificación de audio independiente.'
      })
      return
    }

    const recorder = new MediaRecorder(stream, {
      mimeType,
      audioBitsPerSecond: AUDIO_BITRATE
    })
    this.runtimes[kind].recorder = recorder
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      const index = this.runtimes[kind].chunkIndex
      this.runtimes[kind].chunkIndex += 1
      this.callbacks.onChunk(kind, index, event.data)
    }
    recorder.onerror = () => {
      this.callbacks.onReport(kind, {
        active: false,
        label: this.runtimes[kind].label,
        error: 'El codificador de audio se detuvo por un error.'
      })
    }
    recorder.start(1000)
  }

  private failAll(error: string): void {
    for (const kind of ['microphone', 'system'] as const) {
      if (!this.runtimes[kind].settings.enabled) continue
      this.callbacks.onReport(kind, { active: false, label: null, error })
    }
  }
}

let currentEngine: AudioEngine | null = null

export async function startAudioEngine(input: StartAudioEngineInput): Promise<MediaStream> {
  if (currentEngine) await currentEngine.stop()
  const engine = new AudioEngine(input.callbacks)
  currentEngine = engine
  try {
    return await engine.start(input)
  } catch (error) {
    await engine.stop()
    currentEngine = null
    throw error
  }
}

export function pauseAudioEngine(): void {
  currentEngine?.pause()
}

export function resumeAudioEngine(): void {
  currentEngine?.resume()
}

export function setAudioGain(kind: AudioTrackKind, settings: AudioTrackSettings): void {
  currentEngine?.setGain(kind, settings)
}

export function getAudioLevels(): Record<AudioTrackKind, number> {
  return {
    microphone: currentEngine?.getLevel('microphone') ?? 0,
    system: currentEngine?.getLevel('system') ?? 0
  }
}

export async function stopAudioEngine(): Promise<void> {
  const engine = currentEngine
  currentEngine = null
  if (engine) await engine.stop()
}
