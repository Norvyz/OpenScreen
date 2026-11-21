import { useEffect, useState } from 'react'
import { Circle, Mic, MicOff, Pause, Play, Square, Volume2, VolumeX, X } from 'lucide-react'
import { elapsedMs } from '@shared/recording'
import type { AudioTrackKind } from '@shared/audio'
import { Badge } from '@/components/ui/Badge'
import { startRecordingWithCurrentSettings } from '@/services/recordingActions'
import { useAudioStore } from '@/store/audioStore'
import { useCaptureStore } from '@/store/captureStore'
import { useRecordingStore } from '@/store/recordingStore'
import { useSettingsStore } from '@/store/settingsStore'
import { cn } from '@/utils/cn'
import { formatDuration } from '@/utils/format'

function statusLabel(state: string): string {
  switch (state) {
    case 'recording':
      return 'Grabando'
    case 'paused':
      return 'En pausa'
    case 'starting':
      return 'Preparando'
    case 'stopping':
      return 'Finalizando'
    case 'error':
      return 'Error'
    default:
      return 'Listo'
  }
}

const TRACK_NAMES: Record<AudioTrackKind, string> = {
  microphone: 'Micrófono',
  system: 'Audio del sistema'
}

/**
 * Acceso rápido a una pista de audio. Antes de grabar enciende/apaga la captura; durante la
 * grabación solo silencia (el dispositivo no puede cambiarse en caliente).
 */
function AudioToggle({ kind, recordingActive }: { kind: AudioTrackKind; recordingActive: boolean }) {
  const audio = useSettingsStore((state) => state.settings?.audio)
  const support = useAudioStore((state) => state.support)
  const updateTrack = useAudioStore((state) => state.updateTrack)
  if (!audio) return null

  const track = audio[kind]
  const unavailable =
    kind === 'system' && audio.system.mode === 'auto' && support?.systemAudio === 'unavailable'
  const on = track.enabled && !track.muted
  const name = TRACK_NAMES[kind]
  const disabled = unavailable || (recordingActive && !track.enabled)
  const Icon = kind === 'microphone' ? (on ? Mic : MicOff) : on ? Volume2 : VolumeX

  const toggle = (): void => {
    if (on) {
      void updateTrack(kind, recordingActive ? { muted: true } : { enabled: false })
    } else {
      void updateTrack(kind, { enabled: true, muted: false })
    }
  }

  const label = unavailable
    ? `${name}: no disponible en esta plataforma`
    : on
      ? recordingActive
        ? `Silenciar ${name}`
        : `Desactivar ${name}`
      : `Activar ${name}`

  return (
    <button
      type="button"
      className={cn('dock__toggle', on && 'dock__toggle--on')}
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={toggle}
    >
      <Icon size={20} />
    </button>
  )
}

/** Barra de control: tiempo, audio rápido y acciones de grabación. Main es la fuente de verdad. */
export function RecordingDock() {
  const [, forceTick] = useState(0)
  const snapshot = useCaptureStore((state) => state.snapshot)
  const support = useAudioStore((state) => state.support)
  const { status, busy, countdownRemaining, pause, resume, stop, cancel } = useRecordingStore()
  const active = status.state === 'recording' || status.state === 'paused'
  const selection = snapshot?.selection ?? null
  const canStart =
    (status.state === 'idle' || status.state === 'error') &&
    Boolean(selection && snapshot?.selectionAvailable && support) &&
    !busy

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => forceTick((value) => value + 1), 250)
    return () => window.clearInterval(timer)
  }, [active])

  return (
    <div className={cn('dock', status.state === 'recording' && 'dock--recording')}>
      <div className="dock__left">
        <div className="dock__audio" role="group" aria-label="Audio rápido">
          <AudioToggle kind="microphone" recordingActive={active} />
          <AudioToggle kind="system" recordingActive={active} />
        </div>
      </div>

      <div className="dock__time" aria-label="Duración de la grabación">
        <span className="dock__clock">
          {countdownRemaining !== null ? countdownRemaining : formatDuration(elapsedMs(status))}
        </span>
        <Badge tone={countdownRemaining !== null ? 'warning' : active ? 'accent' : 'neutral'}>
          {countdownRemaining !== null ? 'Cuenta atrás' : statusLabel(status.state)}
        </Badge>
      </div>

      <div className="dock__actions">
        {!active ? (
          <button
            type="button"
            className="btn-record"
            onClick={() => void startRecordingWithCurrentSettings()}
            disabled={!canStart}
          >
            <Circle size={14} fill="currentColor" />
            Iniciar grabación
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn-record btn-record--quiet"
              onClick={() => void (status.state === 'recording' ? pause() : resume())}
              disabled={busy}
            >
              {status.state === 'recording' ? (
                <>
                  <Pause size={15} fill="currentColor" /> Pausar
                </>
              ) : (
                <>
                  <Play size={15} fill="currentColor" /> Reanudar
                </>
              )}
            </button>
            <button type="button" className="btn-record" onClick={() => void stop()} disabled={busy}>
              <Square size={13} fill="currentColor" />
              Detener
            </button>
            <button
              type="button"
              className="dock__toggle"
              aria-label="Cancelar grabación"
              title="Cancelar grabación"
              onClick={() => void cancel()}
              disabled={busy}
            >
              <X size={20} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
