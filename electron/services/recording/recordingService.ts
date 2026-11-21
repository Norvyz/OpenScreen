import { randomUUID } from 'node:crypto'
import { constants as fsConstants, readdirSync } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
  type FileHandle
} from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import {
  assertEncodingPlan,
  EMPTY_ENCODING_CAPABILITIES,
  RESOLUTION_SIZES,
  type EncodingCapabilities,
  type EncodingPlan
} from '../../../shared/encoding'
import type {
  AudioSupport,
  AudioTrackFile,
  AudioTrackKind
} from '../../../shared/audio'
import type { CaptureSnapshot, SourceRef } from '../../../shared/capture'
import type {
  RecordingAudioChunk,
  RecordingAudioState,
  RecordingBeginRequest,
  RecordingChunk,
  RecordingFile,
  RecordingFinishRequest,
  RecordingFormat,
  RecordingLibrarySnapshot,
  RecordingMetadataStatus,
  RecordingSessionRequest,
  RecordingStatus,
  RecordingStorageInfo
} from '../../../shared/recording'
import {
  EMPTY_RECORDING_AUDIO_STATUS,
  RECORDING_METADATA_VERSION,
  recordingFormatForName,
  recordingMetadataSchema,
  type RecordingAudioStatus,
  type RecordingMetadata
} from '../../../shared/recording'
import type { SettingsService } from '../settings/settingsService'
import {
  audioTempPathFor,
  audioTrackPathFor,
  buildRecordingName,
  canFinish,
  canPause,
  canResume,
  canStart,
  type FfmpegArgsOptions,
  isFinalRecordingFile,
  isManagedTempFileName,
  isPathInside,
  mediaUrlFor,
  metadataPathFor,
  mimeTypeForRecordingName,
  normalizeExtension,
  normalizedRecordingName,
  resolveOutputDir,
  tempPathFor,
  validateRecordingName,
  withUniqueSuffix
} from './model'

export interface FfmpegPort {
  isAvailable(): Promise<boolean>
  transcode(options: FfmpegArgsOptions): Promise<void>
  getEncodingCapabilities?(): Promise<EncodingCapabilities>
}

export interface CapturePort {
  getSnapshot(): Promise<CaptureSnapshot>
}

export interface RecordingServiceOptions {
  settings: SettingsService
  capture: CapturePort
  getVideosPath: () => string
  getAudioSupport: () => AudioSupport
  now?: () => number
  ffmpeg?: FfmpegPort
  reveal?: (path: string) => void
  open?: (path: string) => void
}

const AUDIO_TRACKS: readonly AudioTrackKind[] = ['microphone', 'system']

function emptyAudioStatus(): RecordingAudioStatus {
  return {
    support: { ...EMPTY_RECORDING_AUDIO_STATUS.support, notes: [...EMPTY_RECORDING_AUDIO_STATUS.support.notes] },
    microphone: { ...EMPTY_RECORDING_AUDIO_STATUS.microphone },
    system: { ...EMPTY_RECORDING_AUDIO_STATUS.system },
    separateTracks: EMPTY_RECORDING_AUDIO_STATUS.separateTracks,
    sidecars: []
  }
}

function emptyStatus(): RecordingStatus {
  return {
    state: 'idle',
    sessionId: null,
    source: null,
    startedAt: null,
    pausedAt: null,
    pausedMs: 0,
    bytesWritten: 0,
    outputPath: null,
    tempPath: null,
    mimeType: null,
    encoding: null,
    error: null,
    lastRecording: null,
    audio: emptyAudioStatus()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Error desconocido al grabar.'
}

interface ParsedMetadata {
  status: RecordingMetadataStatus
  durationMs: number | null
  mimeType: string | null
  tracks: AudioTrackFile[]
  encoding: EncodingPlan | null
  raw: RecordingMetadata | null
  /** Texto original, para restaurarlo byte a byte si un renombrado se interrumpe. */
  rawText: string | null
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Dueño del estado de grabación y de los archivos. El renderer informa de los eventos del
 * MediaRecorder y del estado de cada pista de audio; aquí se decide si una acción es válida,
 * se escriben los chunks y se publica el estado. Esto evita grabaciones duplicadas y estados
 * inconsistentes.
 */
export class RecordingService {
  private readonly now: () => number
  private readonly ffmpeg: FfmpegPort
  private readonly revealFile: (path: string) => void
  private readonly openFile: (path: string) => void
  private readonly listeners = new Set<(status: RecordingStatus) => void>()
  private status: RecordingStatus = emptyStatus()
  private handle: FileHandle | null = null
  private expectedChunk = 0
  private currentFormat: RecordingFormat = 'webm'
  private currentPlan: EncodingPlan | null = null
  private transcodePath: string | null = null
  private readonly audioHandles: Partial<Record<AudioTrackKind, FileHandle>> = {}
  private readonly expectedAudioChunk: Partial<Record<AudioTrackKind, number>> = {}
  private readonly audioTemps: Partial<Record<AudioTrackKind, string>> = {}

  constructor(private readonly options: RecordingServiceOptions) {
    this.now = options.now ?? Date.now
    this.ffmpeg = options.ffmpeg ?? {
      isAvailable: async () => false,
      transcode: async () => undefined
    }
    this.revealFile = options.reveal ?? (() => undefined)
    this.openFile = options.open ?? (() => undefined)
  }

  getStatus(): RecordingStatus {
    return { ...this.status, audio: { ...this.status.audio, sidecars: [...this.status.audio.sidecars] } }
  }

  onStatusChange(listener: (status: RecordingStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getOutputDir(): string {
    return resolveOutputDir(this.options.settings.get().recording.outputDir, this.options.getVideosPath())
  }

  /** Contadores reales para el panel de recursos; nunca valores estimados. */
  getResourceCounts(): {
    activeRecordings: number
    openFileHandles: number
    managedTempFiles: number
  } {
    let managedTempFiles = 0
    try {
      managedTempFiles = readdirSync(this.getOutputDir(), { withFileTypes: true }).filter(
        (entry) => entry.isFile() && isManagedTempFileName(entry.name)
      ).length
    } catch {
      // Carpeta todavía no creada o sin permisos: no inventamos un número.
      managedTempFiles = 0
    }
    return {
      activeRecordings: this.status.sessionId ? 1 : 0,
      openFileHandles:
        (this.handle ? 1 : 0) + Object.values(this.audioHandles).filter(Boolean).length,
      managedTempFiles
    }
  }

  async checkFfmpeg(): Promise<boolean> {
    return this.ffmpeg.isAvailable()
  }

  /** Codificadores y formatos detectados de verdad; nunca una lista estimada. */
  async getEncodingCapabilities(): Promise<EncodingCapabilities> {
    return (await this.ffmpeg.getEncodingCapabilities?.()) ?? EMPTY_ENCODING_CAPABILITIES
  }

  /** Reserva la sesión y crea el archivo temporal. Falla si ya hay una grabación activa. */
  async begin(request: RecordingBeginRequest): Promise<RecordingStatus> {
    if (!canStart(this.status.state)) {
      throw new Error('Ya hay una grabación en curso. Termínala antes de empezar otra.')
    }
    if (
      normalizeExtension(request.extension) !== request.options.format ||
      request.encoding.format !== request.options.format
    ) {
      throw new Error('La extensión, el formato y el plan de codificación no coinciden.')
    }
    const ffmpegNeeded = request.encoding.transcode
    if (ffmpegNeeded) {
      const capabilities = await this.getEncodingCapabilities()
      const problem = assertEncodingPlan(request.encoding, capabilities)
      if (problem) throw new Error(problem)
      if (!(await this.ffmpeg.isAvailable())) {
        throw new Error('La combinación elegida requiere FFmpeg. Instálalo o elige WebM nativo.')
      }
    }

    const support = this.options.getAudioSupport()
    if (
      request.audio.system.enabled &&
      request.audio.system.mode === 'auto' &&
      support.systemAudio === 'unavailable'
    ) {
      throw new Error(
        'La captura automática del audio del sistema no está disponible en esta plataforma. Elige un dispositivo virtual en modo «Dispositivo» o desactiva esa pista.'
      )
    }
    if (request.audio.system.enabled && request.audio.system.mode === 'device' && !request.audio.system.deviceId) {
      throw new Error('Selecciona el dispositivo virtual que transporta el audio del sistema.')
    }

    const snapshot = await this.options.capture.getSnapshot()
    if (
      !snapshot.selectionAvailable ||
      snapshot.selection?.id !== request.source.id ||
      snapshot.selection?.kind !== request.source.kind
    ) {
      throw new Error('La fuente seleccionada ya no está disponible. Vuelve a elegirla.')
    }

    const finalPath = await this.reservePath(request)
    const tempPath = tempPathFor(finalPath)
    this.handle = await open(tempPath, 'w')

    // Los archivos de pistas se crean solo cuando llega el primer chunk: una grabación sin
    // audio no deja temporales vacíos.
    this.expectedChunk = 0
    this.currentFormat = request.options.format
    this.currentPlan = request.encoding
    this.transcodePath = null
    const audio = emptyAudioStatus()
    audio.support = support
    audio.separateTracks = request.audio.separateTracks
    audio.microphone = {
      kind: 'microphone',
      enabled: request.audio.microphone.enabled,
      active: false,
      deviceId: request.audio.microphone.deviceId,
      label: null,
      error: null
    }
    audio.system = {
      kind: 'system',
      enabled: request.audio.system.enabled,
      active: false,
      deviceId: request.audio.system.deviceId,
      label: null,
      error: null
    }

    this.status = {
      ...emptyStatus(),
      state: 'recording',
      sessionId: randomUUID(),
      source: request.source,
      startedAt: this.now(),
      outputPath: finalPath,
      tempPath,
      mimeType: request.mimeType,
      encoding: request.encoding,
      audio
    }
    this.emit()
    return this.getStatus()
  }

  async pause(): Promise<RecordingStatus> {
    if (!canPause(this.status.state)) throw new Error('Solo se puede pausar una grabación activa.')
    this.status = { ...this.status, state: 'paused', pausedAt: this.now() }
    this.emit()
    return this.getStatus()
  }

  async resume(): Promise<RecordingStatus> {
    if (!canResume(this.status.state)) throw new Error('La grabación no está pausada.')
    const pausedAt = this.status.pausedAt
    const pausedMs = this.status.pausedMs + (pausedAt === null ? 0 : Math.max(0, this.now() - pausedAt))
    this.status = { ...this.status, state: 'recording', pausedAt: null, pausedMs }
    this.emit()
    return this.getStatus()
  }

  /** Escribe un chunk de vídeo en orden. Los eventos desordenados se rechazan. */
  async appendChunk(chunk: RecordingChunk): Promise<RecordingStatus> {
    this.assertSession(chunk.sessionId)
    if (!canFinish(this.status.state) || !this.handle) {
      throw new Error('La grabación no está recibiendo datos.')
    }
    if (chunk.index !== this.expectedChunk) {
      throw new Error(`Chunk fuera de orden: se esperaba ${this.expectedChunk} y llegó ${chunk.index}.`)
    }

    await this.handle.write(chunk.data)
    this.expectedChunk += 1
    this.status = {
      ...this.status,
      bytesWritten: this.status.bytesWritten + chunk.data.byteLength
    }
    this.emit()
    return this.getStatus()
  }

  /** Escribe un chunk de una pista de audio independiente, también en orden. */
  async appendAudio(chunk: RecordingAudioChunk): Promise<RecordingStatus> {
    this.assertSession(chunk.sessionId)
    if (!canFinish(this.status.state) || !this.status.audio.separateTracks || !this.status.audio[chunk.track].enabled) {
      throw new Error(`La pista ${chunk.track} no está recibiendo datos.`)
    }
    const expected = this.expectedAudioChunk[chunk.track] ?? 0
    if (chunk.index !== expected) {
      throw new Error(`Chunk de ${chunk.track} fuera de orden: se esperaba ${expected} y llegó ${chunk.index}.`)
    }

    let handle = this.audioHandles[chunk.track]
    if (!handle) {
      const finalPath = this.status.outputPath
      if (!finalPath) throw new Error('Falta la ruta de la grabación.')
      const path = audioTempPathFor(finalPath, chunk.track)
      handle = await open(path, 'w')
      this.audioHandles[chunk.track] = handle
      this.audioTemps[chunk.track] = path
    }

    await handle.write(chunk.data)
    this.expectedAudioChunk[chunk.track] = expected + 1
    return this.getStatus()
  }

  /** El renderer informa de desconexiones y errores sin tumbar toda la grabación. */
  async reportAudioState(state: RecordingAudioState): Promise<RecordingStatus> {
    this.assertSession(state.sessionId)
    const current = state.track === 'microphone' ? this.status.audio.microphone : this.status.audio.system
    const updated = {
      ...current,
      active: state.active,
      label: state.label,
      error: state.error
    }
    this.status = {
      ...this.status,
      audio: {
        ...this.status.audio,
        [state.track]: updated
      }
    }
    this.emit()
    return this.getStatus()
  }

  /** Cierra, finaliza el contenedor y publica la grabación terminada. */
  async finish(request: RecordingFinishRequest): Promise<RecordingStatus> {
    this.assertSession(request.sessionId)
    if (!canFinish(this.status.state) || !this.handle) {
      throw new Error('La grabación no se puede finalizar desde este estado.')
    }
    if (this.status.bytesWritten === 0) {
      const error = new Error('La grabación no produjo datos.')
      await this.failActive(error)
      throw error
    }

    const tempPath = this.status.tempPath
    const finalPath = this.status.outputPath
    if (!tempPath || !finalPath) throw new Error('Faltan rutas de la grabación.')

    await this.handle.close()
    this.handle = null

    try {
      const tracks = await this.finishAudioTracks(finalPath)
      const plan = this.currentPlan
      const ffmpegNeeded = plan?.transcode ?? tracks.length > 0
      if (ffmpegNeeded) {
        if (!(await this.ffmpeg.isAvailable())) {
          // Sin FFmpeg solo se puede conservar el contenedor que MediaRecorder ya produjo
          // (WebM o MP4 nativo). Las pistas independientes quedan como archivos Opus/WebM
          // separados; no se afirma que se hayan mezclado en el contenedor final.
          if (!plan?.transcode) {
            await rename(tempPath, finalPath)
            return this.publishFinished(finalPath, request.durationMs, tracks)
          }
          throw new Error('La codificación elegida requiere FFmpeg. Instálalo o elige WebM nativo.')
        }
        const targetSize = plan ? RESOLUTION_SIZES[plan.resolution] : null
        const needsScale = Boolean(
          !plan?.streamCopy &&
            plan &&
            targetSize &&
            (plan.actualWidth !== targetSize.width || plan.actualHeight !== targetSize.height)
        )
        const needsFpsChange = Boolean(
          !plan?.streamCopy &&
            plan &&
            plan.actualFps !== null &&
            Math.abs(plan.actualFps - plan.fps) > 1
        )
        this.transcodePath = `${finalPath}.ffmpeg.part`
        await this.ffmpeg.transcode({
          input: tempPath,
          output: this.transcodePath,
          format: this.currentFormat,
          quality: plan?.quality ?? 'balanced',
          ...(plan?.streamCopy
            ? {}
            : {
                codec: plan?.codec,
                hardware: plan?.hardware,
                bitrate: plan?.bitrate,
                crf: plan?.crf,
                keyframeInterval: plan?.keyframeInterval,
                preset: plan?.preset
              }),
          width: needsScale && targetSize ? targetSize.width : null,
          height: needsScale && targetSize ? targetSize.height : null,
          fps: needsFpsChange ? plan?.fps : null,
          audioInputs: tracks.map((track) => track.path)
        })
        await rename(this.transcodePath, finalPath)
        this.transcodePath = null
        await rm(tempPath, { force: true })
      } else {
        await rename(tempPath, finalPath)
      }

      return await this.publishFinished(finalPath, request.durationMs, tracks)
    } catch (error) {
      await this.failActive(error)
      throw error
    }
  }

  /** Cancela y borra los temporales. No deja el motor en estado `recording`. */
  async cancel(request: RecordingSessionRequest): Promise<RecordingStatus> {
    if (!this.status.sessionId || request.sessionId !== this.status.sessionId) {
      throw new Error('No hay una grabación activa con esa sesión.')
    }
    await this.cleanupActive()
    this.status = emptyStatus()
    this.emit()
    return this.getStatus()
  }

  /** Llamado al salir: nunca deja un archivo a medias ni un handle abierto. */
  async dispose(): Promise<void> {
    if (!this.status.sessionId) return
    await this.cleanupActive()
    this.status = emptyStatus()
    this.emit()
  }

  async list(): Promise<RecordingLibrarySnapshot> {
    const storage = await this.getStorageInfo()
    const dir = this.getOutputDir()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      return this.makeSnapshot([], storage, messageOf(error), [])
    }

    const files: RecordingFile[] = []
    const tempFiles: string[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (isManagedTempFileName(entry.name)) {
        tempFiles.push(entry.name)
        continue
      }
      if (!isFinalRecordingFile(entry.name)) continue
      try {
        files.push(await this.toRecordingFile(resolve(dir, entry.name), entry.name))
      } catch {
        // El archivo pudo borrarse mientras se enumeraba; se ignora.
      }
    }
    return this.makeSnapshot(
      files.sort((a, b) => b.createdAt - a.createdAt),
      storage,
      null,
      tempFiles.sort((a, b) => a.localeCompare(b, 'es'))
    )
  }

  /** Comprueba existencia, permisos y espacio real de la carpeta configurada. */
  async getStorageInfo(): Promise<RecordingStorageInfo> {
    const outputDir = this.getOutputDir()
    let existsDir = false
    let writable = false
    let reason: string | null = null

    try {
      const info = await stat(outputDir)
      if (info.isDirectory()) existsDir = true
      else reason = 'La ruta configurada no es una carpeta.'
    } catch {
      reason = 'La carpeta de grabaciones no existe todavía.'
    }

    if (existsDir) {
      try {
        await access(outputDir, fsConstants.W_OK)
        writable = true
      } catch {
        reason = 'La carpeta de grabaciones no tiene permisos de escritura.'
      }
    }

    if (writable) {
      // Sondeo real: permisos y escritura efectiva pueden divergir (unidades de solo lectura,
      // ACLs, discos compartidos). El archivo se crea y se borra inmediatamente.
      const probe = resolve(outputDir, `.openscreen-write-${randomUUID()}.tmp`)
      try {
        const handle = await open(probe, 'wx')
        await handle.close()
        await unlink(probe)
      } catch (error) {
        writable = false
        reason = `No se pudo escribir en la carpeta: ${messageOf(error)}`
      }
    }

    let freeBytes: number | null = null
    if (existsDir) {
      try {
        const info = await statfs(outputDir)
        freeBytes = Math.max(0, Number(info.bavail) * Number(info.bsize))
      } catch {
        // El espacio libre es informativo; su ausencia no invalida la carpeta.
      }
    }

    const available = existsDir && writable
    return {
      outputDir,
      exists: existsDir,
      writable,
      available,
      freeBytes,
      reason: available ? null : (reason ?? 'La carpeta de grabaciones no está disponible.')
    }
  }

  async reveal(path: string): Promise<void> {
    const target = this.assertRecordingPath(path)
    if (!(await exists(target))) throw new Error('El archivo ya no existe.')
    this.revealFile(target)
  }

  async open(path: string): Promise<void> {
    const target = this.assertRecordingPath(path)
    if (!(await exists(target))) throw new Error('El archivo ya no existe.')
    this.openFile(target)
  }

  async delete(path: string): Promise<RecordingLibrarySnapshot> {
    const target = this.assertRecordingPath(path)
    const metadata = await this.readMetadata(target)
    const removable = new Set<string>([metadataPathFor(target)])
    for (const kind of AUDIO_TRACKS) removable.add(audioTrackPathFor(target, kind))
    // Los paths del sidecar solo se respetan si son exactamente los esperados para este vídeo:
    // un sidecar editado a mano no puede convertir un borrado en borrado de otro archivo.
    for (const track of metadata.tracks) {
      if (AUDIO_TRACKS.includes(track.kind)) removable.add(audioTrackPathFor(target, track.kind))
    }

    await unlink(target)
    for (const pathToRemove of removable) {
      await rm(pathToRemove, { force: true }).catch(() => undefined)
    }
    return this.list()
  }

  /** Renombra vídeo, pistas y sidecar. Rechaza colisiones antes de tocar cualquier archivo. */
  async rename(path: string, name: string): Promise<RecordingLibrarySnapshot> {
    const target = this.assertRecordingPath(path)
    if (!(await exists(target))) throw new Error('El archivo ya no existe.')
    const problem = validateRecordingName(name, extname(target))
    if (problem) throw new Error(problem)

    const newName = normalizedRecordingName(name)
    const newTarget = resolve(this.getOutputDir(), newName)
    if (resolve(target) === resolve(newTarget)) return this.list()

    const metadata = await this.readMetadata(target)
    const trackMoves = AUDIO_TRACKS.map((kind) => ({
      kind,
      from: audioTrackPathFor(target, kind),
      to: audioTrackPathFor(newTarget, kind)
    }))
    const oldMetadataPath = metadataPathFor(target)
    const newMetadataPath = metadataPathFor(newTarget)
    const collisions = [
      newTarget,
      tempPathFor(newTarget),
      `${newTarget}.ffmpeg.part`,
      newMetadataPath,
      ...trackMoves.flatMap((move) => [move.to, `${move.to}.part`])
    ]
    for (const candidate of collisions) {
      if (candidate !== target && (await exists(candidate))) {
        throw new Error(`Ya existe un archivo con el nombre «${basename(candidate)}».`)
      }
    }

    const updatedMetadata: RecordingMetadata = {
      ...(metadata.raw ?? {}),
      version: RECORDING_METADATA_VERSION,
      durationMs: metadata.durationMs,
      mimeType: metadata.mimeType ?? mimeTypeForRecordingName(newName),
      encoding: metadata.encoding,
      tracks: []
    }

    const moved: { from: string; to: string }[] = []
    let metadataMoved = false
    let metadataCreated = false
    try {
      for (const move of trackMoves) {
        if (!(await exists(move.from))) continue
        await rename(move.from, move.to)
        moved.push({ from: move.from, to: move.to })
        const previous = metadata.tracks.find((track) => track.kind === move.kind)
        ;(updatedMetadata.tracks as AudioTrackFile[]).push({
          kind: move.kind,
          path: move.to,
          name: basename(move.to),
          mimeType: previous?.mimeType ?? 'audio/webm;codecs=opus'
        })
      }

      if (await exists(oldMetadataPath)) {
        await rename(oldMetadataPath, newMetadataPath)
        metadataMoved = true
      } else {
        metadataCreated = true
      }
      await writeFile(newMetadataPath, JSON.stringify(updatedMetadata), 'utf8')
      await rename(target, newTarget)
    } catch (error) {
      if (metadataMoved) {
        // La copia nueva puede estar a medias: se elimina y se restaura el original exacto.
        await rm(newMetadataPath, { force: true }).catch(() => undefined)
        if (metadata.rawText !== null) {
          await writeFile(oldMetadataPath, metadata.rawText, 'utf8').catch(() => undefined)
        }
      } else if (metadataCreated) {
        await rm(newMetadataPath, { force: true }).catch(() => undefined)
      }
      for (const item of moved.reverse()) {
        await rename(item.to, item.from).catch(() => undefined)
      }
      throw error
    }

    return this.list()
  }

  /** Elimina temporales huérfanos de un cierre brusco, nunca los de la sesión en curso. */
  async cleanupTempFiles(): Promise<RecordingLibrarySnapshot> {
    const active = new Set(
      [
        this.status.tempPath,
        this.transcodePath,
        ...AUDIO_TRACKS.map((kind) => this.audioTemps[kind])
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => resolve(value))
    )
    const dir = this.getOutputDir()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      return this.makeSnapshot([], await this.getStorageInfo(), messageOf(error), [])
    }

    const stale = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          isManagedTempFileName(entry.name) &&
          !active.has(resolve(dir, entry.name))
      )
      .map((entry) => entry.name)
    for (const name of stale) {
      await rm(resolve(dir, name), { force: true }).catch(() => undefined)
    }
    return this.list()
  }

  /** URL válida solo para un vídeo terminado dentro de la carpeta configurada. */
  async getMediaUrl(path: string): Promise<string> {
    const target = this.assertRecordingPath(path)
    if (!(await exists(target))) throw new Error('El archivo ya no existe.')
    return mediaUrlFor(target)
  }

  private makeSnapshot(
    items: RecordingFile[],
    storage: RecordingStorageInfo,
    error: string | null,
    tempFiles: string[]
  ): RecordingLibrarySnapshot {
    const finalError = error ?? storage.reason
    return {
      items,
      outputDir: storage.outputDir,
      available: storage.available && finalError === null,
      error: finalError,
      tempFiles,
      storage,
      generatedAt: this.now()
    }
  }

  private async toRecordingFile(path: string, name: string): Promise<RecordingFile> {
    const info = await stat(path)
    const metadata = await this.readMetadata(path)
    const plan = metadata.encoding
    return {
      path,
      name,
      size: info.size,
      mimeType: metadata.mimeType ?? mimeTypeForRecordingName(name),
      format: recordingFormatForName(name),
      durationMs: metadata.durationMs,
      createdAt: info.mtimeMs,
      tracks: metadata.tracks,
      metadataStatus: metadata.status,
      codec: plan?.codec ?? null,
      actualWidth: plan?.actualWidth ?? null,
      actualHeight: plan?.actualHeight ?? null,
      actualFps: plan?.actualFps ?? null,
      measuredFps: plan?.measuredFps ?? null,
      encoding: plan
    }
  }

  private assertRecordingPath(path: string): string {
    const target = this.safePath(path)
    if (!isFinalRecordingFile(basename(target))) {
      throw new Error('La ruta no corresponde a una grabación terminada.')
    }
    return target
  }

  private assertSession(sessionId: string): void {
    if (!this.status.sessionId) throw new Error('No hay una grabación activa con esa sesión.')
    if (sessionId !== this.status.sessionId) {
      throw new Error('La sesión pertenece a otra grabación.')
    }
  }

  private async publishFinished(
    finalPath: string,
    durationMs: number,
    tracks: AudioTrackFile[]
  ): Promise<RecordingStatus> {
    const info = await stat(finalPath)
    const mimeType = this.currentFormat === 'webm'
      ? (this.status.mimeType ?? 'video/webm')
      : mimeTypeForRecordingName(finalPath)
    const plan = this.currentPlan
    await writeFile(
      metadataPathFor(finalPath),
      JSON.stringify({
        version: RECORDING_METADATA_VERSION,
        durationMs,
        mimeType,
        tracks,
        encoding: plan
      }),
      'utf8'
    )
    const file: RecordingFile = {
      path: finalPath,
      name: basename(finalPath),
      size: info.size,
      mimeType,
      format: recordingFormatForName(finalPath),
      durationMs,
      createdAt: this.now(),
      tracks,
      metadataStatus: 'ok',
      codec: plan?.codec ?? null,
      actualWidth: plan?.actualWidth ?? null,
      actualHeight: plan?.actualHeight ?? null,
      actualFps: plan?.actualFps ?? null,
      measuredFps: plan?.measuredFps ?? null,
      encoding: plan
    }
    this.status = {
      ...emptyStatus(),
      lastRecording: file,
      audio: {
        ...this.status.audio,
        microphone: { ...this.status.audio.microphone, active: false },
        system: { ...this.status.audio.system, active: false },
        sidecars: [...tracks]
      }
    }
    this.emit()
    return this.getStatus()
  }

  private async finishAudioTracks(finalPath: string): Promise<AudioTrackFile[]> {
    const tracks: AudioTrackFile[] = []
    await this.closeAudioHandles()

    for (const kind of AUDIO_TRACKS) {
      const temp = this.audioTemps[kind]
      if (!temp) continue
      if (!(await exists(temp))) continue
      const info = await stat(temp)
      if (info.size === 0) {
        await rm(temp, { force: true })
        continue
      }
      const path = audioTrackPathFor(finalPath, kind)
      await rename(temp, path)
      tracks.push({
        kind,
        path,
        name: path.split(/[\\/]/).pop() ?? `${kind}.webm`,
        mimeType: 'audio/webm;codecs=opus'
      })
    }
    return tracks
  }

  private async reservePath(request: RecordingBeginRequest): Promise<string> {
    const dir = this.getOutputDir()
    await mkdir(dir, { recursive: true })
    const source: SourceRef = request.source
    const date = new Date(this.now())

    for (let ordinal = 1; ordinal <= 999; ordinal += 1) {
      const name = withUniqueSuffix(
        buildRecordingName({
          template: this.options.settings.get().recording.fileNameTemplate,
          sourceName: source.name,
          date,
          extension: request.extension
        }),
        ordinal
      )
      const candidate = resolve(dir, name)
      const candidates = [
        candidate,
        tempPathFor(candidate),
        `${candidate}.ffmpeg.part`,
        metadataPathFor(candidate),
        ...(request.audio.separateTracks
          ? AUDIO_TRACKS.flatMap((kind) => [
              audioTrackPathFor(candidate, kind),
              audioTempPathFor(candidate, kind)
            ])
          : [])
      ]
      const conflicts = await Promise.all(candidates.map((path) => exists(path)))
      if (!conflicts.some(Boolean)) return candidate
    }
    throw new Error('No se encontró un nombre de archivo libre.')
  }

  /** Parsea el sidecar con Zod: un archivo manipulado no puede convertirse en dato fiable. */
  private async readMetadata(path: string): Promise<ParsedMetadata> {
    const empty: ParsedMetadata = {
      status: 'missing',
      durationMs: null,
      mimeType: null,
      tracks: [],
      encoding: null,
      raw: null,
      rawText: null
    }
    let rawText: string
    try {
      rawText = await readFile(metadataPathFor(path), 'utf8')
    } catch {
      return empty
    }

    let json: unknown
    try {
      json = JSON.parse(rawText)
    } catch {
      return { ...empty, status: 'invalid', rawText }
    }

    const parsed = recordingMetadataSchema.safeParse(json)
    if (!parsed.success) return { ...empty, status: 'invalid', rawText }
    const data = parsed.data
    const durationMs =
      typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0
        ? data.durationMs
        : null
    const tracks = this.sanitizeMetadataTracks(data.tracks, path)
    const status: RecordingMetadataStatus =
      durationMs === null && data.encoding == null && tracks.length === 0 ? 'invalid' : 'ok'
    return {
      status,
      durationMs,
      mimeType: typeof data.mimeType === 'string' && data.mimeType ? data.mimeType : null,
      tracks,
      encoding: data.encoding ?? null,
      raw: data,
      rawText
    }
  }

  /** Solo se aceptan las pistas en su ruta canónica: un sidecar editado no apunta a otro vídeo. */
  private sanitizeMetadataTracks(tracks: unknown, finalPath: string): AudioTrackFile[] {
    if (!Array.isArray(tracks)) return []
    const dir = this.getOutputDir()
    return tracks.filter((track): track is AudioTrackFile => {
      if (typeof track !== 'object' || track === null) return false
      const value = track as Partial<AudioTrackFile>
      if (
        (value.kind !== 'microphone' && value.kind !== 'system') ||
        typeof value.path !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.mimeType !== 'string'
      ) {
        return false
      }
      const expected = audioTrackPathFor(finalPath, value.kind)
      return isPathInside(dir, value.path) && resolve(value.path) === resolve(expected)
    })
  }

  private safePath(path: string): string {
    const target = resolve(path)
    if (!isPathInside(this.getOutputDir(), target)) {
      throw new Error('La ruta está fuera de la carpeta de grabaciones.')
    }
    return target
  }

  private async closeAudioHandles(): Promise<void> {
    for (const kind of AUDIO_TRACKS) {
      const handle = this.audioHandles[kind]
      if (!handle) continue
      await handle.close().catch(() => undefined)
      delete this.audioHandles[kind]
    }
  }

  private async cleanupActive(): Promise<void> {
    if (this.handle) {
      await this.handle.close().catch(() => undefined)
      this.handle = null
    }
    await this.closeAudioHandles()
    const paths = [
      this.status.tempPath,
      this.transcodePath,
      ...AUDIO_TRACKS.map((kind) => this.audioTemps[kind])
    ].filter((value): value is string => Boolean(value))
    for (const path of paths) await rm(path, { force: true }).catch(() => undefined)
    this.expectedChunk = 0
    for (const kind of AUDIO_TRACKS) delete this.expectedAudioChunk[kind]
    for (const kind of AUDIO_TRACKS) delete this.audioTemps[kind]
    this.transcodePath = null
  }

  private async failActive(error: unknown): Promise<void> {
    const lastRecording = this.status.lastRecording
    const audio = this.status.audio
    await this.cleanupActive()
    this.status = { ...emptyStatus(), state: 'error', error: messageOf(error), lastRecording, audio }
    this.emit()
  }

  private emit(): void {
    const status = this.getStatus()
    for (const listener of this.listeners) listener(status)
  }
}
