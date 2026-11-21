import { useEffect } from 'react'
import { FolderOpen, Video } from 'lucide-react'
import { StorageInfoPanel } from '@/components/recordings/StorageInfoPanel'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EncodingSettings } from '@/components/recording/EncodingSettings'
import { Select } from '@/components/ui/Select'
import { SettingRow } from '@/components/ui/SettingRow'
import { Switch } from '@/components/ui/Switch'
import { getApi } from '@/services/ipc'
import { useRecordingStore } from '@/store/recordingStore'
import { useRecordingsStore } from '@/store/recordingsStore'
import { useSettingsStore } from '@/store/settingsStore'
import { toMessage } from '@/utils/errors'

/** Ajustes reales del motor de grabación; se persisten con `settings:update`. */
export function RecordingSection() {
  const { settings, update, error } = useSettingsStore()
  const ffmpegAvailable = useRecordingStore((state) => state.ffmpegAvailable)
  const storage = useRecordingsStore((state) => state.storage)
  const tempFiles = useRecordingsStore((state) => state.tempFiles)
  const storageBusy = useRecordingsStore((state) => state.busy)
  const refreshStorage = useRecordingsStore((state) => state.refresh)
  const cleanupTemp = useRecordingsStore((state) => state.cleanupTemp)
  const outputDir = settings?.recording.outputDir ?? null

  useEffect(() => {
    void refreshStorage()
  }, [refreshStorage, outputDir])

  if (!settings) return null
  const recording = settings.recording

  const chooseOutputDir = async (): Promise<void> => {
    try {
      const dir = await getApi().recording.pickOutputDir()
      if (dir) await update({ recording: { outputDir: dir } })
    } catch (cause) {
      useRecordingStore.setState({ error: toMessage(cause) })
    }
  }

  return (
    <>
      {error && <p className="notice notice--error">{error}</p>}
      <Card title="Salida de vídeo" icon={<Video size={18} />}>
        <SettingRow label="Mostrar cursor" description="Incluye el puntero cuando la API de captura lo permite.">
          <Switch
            label="Mostrar cursor"
            checked={recording.showCursor}
            onChange={(showCursor) => void update({ recording: { showCursor } })}
          />
        </SettingRow>
        <SettingRow label="Cuenta atrás" description="Espera unos segundos antes de empezar a grabar.">
          <Select
            label="Cuenta atrás"
            hideLabel
            value={String(recording.countdown ?? 0)}
            options={[
              { value: '0', label: 'Sin cuenta atrás' },
              { value: '3', label: '3 segundos' },
              { value: '5', label: '5 segundos' },
              { value: '10', label: '10 segundos' }
            ]}
            onChange={(value) => void update({ recording: { countdown: Number(value) } })}
          />
        </SettingRow>
        <EncodingSettings />
        <SettingRow
          label="FFmpeg"
          description={ffmpegAvailable === null ? 'Comprobando…' : ffmpegAvailable ? 'Disponible en PATH o en la ruta configurada.' : 'No disponible. WebM sigue funcionando.'}
        >
          <Badge tone={ffmpegAvailable ? 'success' : ffmpegAvailable === null ? 'neutral' : 'warning'}>
            {ffmpegAvailable === null ? '…' : ffmpegAvailable ? 'Sí' : 'No'}
          </Badge>
        </SettingRow>
        <div className="field">
          <label className="field__label" htmlFor="ffmpeg-path">Ruta de FFmpeg (opcional)</label>
          <input
            id="ffmpeg-path"
            className="input"
            value={recording.ffmpegPath ?? ''}
            placeholder="ffmpeg"
            onChange={(event) =>
              void update({ recording: { ffmpegPath: event.target.value || null } })
            }
          />
          <span className="field__hint">Vacío = buscar `ffmpeg` en PATH. Se ejecuta con argumentos, nunca con shell.</span>
        </div>
      </Card>

      <Card title="Destino" icon={<FolderOpen size={18} />}>
        <SettingRow
          label="Carpeta de grabaciones"
          description={recording.outputDir ?? 'Carpeta de vídeos del sistema'}
        >
          <Button icon={<FolderOpen size={14} />} onClick={() => void chooseOutputDir()}>
            Elegir
          </Button>
        </SettingRow>
        <div className="field">
          <label className="field__label" htmlFor="file-template">Plantilla de nombre</label>
          <input
            id="file-template"
            className="input"
            value={recording.fileNameTemplate}
            onChange={(event) =>
              void update({ recording: { fileNameTemplate: event.target.value } })
            }
          />
          <span className="field__hint">Tokens: {'{source}'}, {'{date}'}, {'{time}'}, {'{ext}'}</span>
        </div>
        <StorageInfoPanel
          storage={storage}
          tempFiles={tempFiles}
          busy={storageBusy}
          onCleanup={() => void cleanupTemp()}
          showChangeLink={false}
          warningGb={settings.performance.storageWarningGb}
        />
      </Card>
    </>
  )
}
