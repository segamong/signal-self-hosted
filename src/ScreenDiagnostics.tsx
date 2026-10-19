import { useEffect, useState } from 'react';
import { LocalVideoTrack, RemoteVideoTrack } from 'livekit-client';
import './screen-diagnostics.css';

type Stat = Record<string, unknown>;
interface Counters {
  id: string;
  timestamp: number;
  bytes?: number;
  frames?: number;
  packets?: number;
  lost?: number;
  freezes?: number;
  drops?: number;
  processingTime?: number;
}
interface Measurement {
  active?: boolean;
  fps?: number;
  mbps?: number;
  width?: number;
  height?: number;
  codec?: string;
  limitation?: 'cpu' | 'bandwidth';
  rtt?: number;
  loss?: number;
  transport?: 'UDP' | 'TCP';
  relay?: boolean;
  freezes?: number;
  drops?: number;
  recentFreezes?: number;
  recentDrops?: number;
  processingMs?: number;
}

function number(stat: Stat | undefined, field: string): number | undefined {
  const value = stat?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function referenced(report: RTCStatsReport, stat: Stat | undefined, field: string): Stat | undefined {
  const id = stat?.[field];
  return typeof id === 'string' ? report.get(id) as Stat | undefined : undefined;
}

function delta(current?: number, previous?: number): number | undefined {
  return current !== undefined && previous !== undefined && current >= previous ? current - previous : undefined;
}

function codecName(stat: Stat | undefined): string | undefined {
  const mime = stat?.mimeType;
  if (typeof mime !== 'string') return undefined;
  return ({ 'video/vp8': 'VP8', 'video/vp9': 'VP9', 'video/h264': 'H.264', 'video/av1': 'AV1' } as Record<string, string>)[mime.toLowerCase()];
}

export default function ScreenDiagnostics({ track, local, targetFps }: {
  track: LocalVideoTrack | RemoteVideoTrack;
  local: boolean;
  targetFps?: number;
}) {
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: Counters | undefined;
    setMeasurement(null);
    const sample = async () => {
      try {
        // Public SDK reports contain connection addresses and codec metadata.
        // Select only numerical media counters and a small codec allowlist;
        // never render, persist or log the raw report.
        const report = await track.getRTCStatsReport();
        if (cancelled) return;
        if (report) {
          const mediaStats: Stat[] = [];
          report.forEach((entry: Stat) => {
            if (entry.type !== (local ? 'outbound-rtp' : 'inbound-rtp')) return;
            if (entry.kind !== 'video' && entry.mediaType !== 'video' && number(entry, local ? 'framesEncoded' : 'framesDecoded') === undefined) return;
            const codec = referenced(report, entry, 'codecId');
            if (codec?.mimeType === 'video/rtx' || codec?.mimeType === 'video/red' || codec?.mimeType === 'video/ulpfec') return;
            mediaStats.push(entry);
          });
          const rtp = mediaStats.sort((left, right) => {
            if (left.active === false && right.active !== false) return 1;
            if (right.active === false && left.active !== false) return -1;
            return (number(right, local ? 'bytesSent' : 'bytesReceived') ?? 0) - (number(left, local ? 'bytesSent' : 'bytesReceived') ?? 0);
          })[0];
          if (rtp) {
            const remote = referenced(report, rtp, 'remoteId');
            const transport = referenced(report, rtp, 'transportId');
            const pair = referenced(report, transport, 'selectedCandidatePairId');
            const localCandidate = referenced(report, pair, 'localCandidateId');
            const remoteCandidate = referenced(report, pair, 'remoteCandidateId');
            const protocol = [localCandidate?.protocol, remoteCandidate?.protocol].find(value => value === 'udp' || value === 'tcp');
            const counters: Counters = {
              id: typeof rtp.id === 'string' ? rtp.id : '',
              timestamp: number(rtp, 'timestamp') ?? 0,
              bytes: number(rtp, local ? 'bytesSent' : 'bytesReceived'),
              frames: number(rtp, local ? 'framesEncoded' : 'framesDecoded'),
              packets: number(rtp, local ? 'packetsSent' : 'packetsReceived'),
              lost: number(local ? remote : rtp, 'packetsLost'),
              freezes: number(rtp, 'freezeCount'),
              drops: number(rtp, 'framesDropped'),
              processingTime: number(rtp, local ? 'totalEncodeTime' : 'totalDecodeTime'),
            };
            const baseline = previous?.id === counters.id ? previous : undefined;
            const elapsed = baseline ? (counters.timestamp - baseline.timestamp) / 1000 : 0;
            const frames = elapsed > 0 ? delta(counters.frames, baseline?.frames) : undefined;
            const bytes = elapsed > 0 ? delta(counters.bytes, baseline?.bytes) : undefined;
            const packets = elapsed > 0 ? delta(counters.packets, baseline?.packets) : undefined;
            const lost = elapsed > 0 ? delta(counters.lost, baseline?.lost) : undefined;
            const processing = elapsed > 0 ? delta(counters.processingTime, baseline?.processingTime) : undefined;
            const reportedFps = number(rtp, 'framesPerSecond');
            const lossDenominator = packets !== undefined && lost !== undefined ? packets + lost : 0;
            const fractionLost = local ? number(remote, 'fractionLost') : undefined;
            setMeasurement({
              active: typeof rtp.active === 'boolean' ? rtp.active : undefined,
              fps: frames !== undefined ? frames / elapsed : reportedFps,
              mbps: bytes !== undefined ? bytes * 8 / elapsed / 1_000_000 : undefined,
              width: number(rtp, 'frameWidth'), height: number(rtp, 'frameHeight'),
              codec: codecName(referenced(report, rtp, 'codecId')),
              limitation: rtp.qualityLimitationReason === 'cpu' || rtp.qualityLimitationReason === 'bandwidth' ? rtp.qualityLimitationReason : undefined,
              rtt: number(local ? remote : pair, local ? 'roundTripTime' : 'currentRoundTripTime') ?? number(pair, 'currentRoundTripTime'),
              // RTCP remote counters update less often than the local sender.
              // Never divide them by a local interval's packetsSent delta.
              loss: local
                ? fractionLost !== undefined && fractionLost <= 1 ? fractionLost * 100 : undefined
                : lossDenominator > 0 && lost !== undefined ? Math.min(100, lost / lossDenominator * 100) : undefined,
              transport: protocol === 'udp' ? 'UDP' : protocol === 'tcp' ? 'TCP' : undefined,
              relay: localCandidate?.candidateType === 'relay' || remoteCandidate?.candidateType === 'relay',
              freezes: counters.freezes, drops: counters.drops,
              recentFreezes: delta(counters.freezes, baseline?.freezes),
              recentDrops: delta(counters.drops, baseline?.drops),
              processingMs: processing !== undefined && frames !== undefined && frames > 0 ? processing / frames * 1000 : undefined,
            });
            previous = counters;
          }
        }
      } catch {
        // Some browsers do not expose every counter. Media must keep playing.
      } finally {
        if (!cancelled) timer = setTimeout(() => { void sample(); }, 1500);
      }
    };
    void sample();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [track, local]);

  const stats = measurement;
  return <div className="screen-diagnostics" aria-label="Измеренные показатели демонстрации">
    <div className="screen-diagnostics-values">
      <strong title={local ? 'Отчёт основного кодека. При переключении на резервный кодек проверьте фактический приём у зрителя.' : undefined}>{local ? 'Отправка · основной поток' : 'Приём'}</strong>
      {stats?.codec && <span>{stats.codec}</span>}
      {stats?.width && stats.height ? <span>{stats.width} × {stats.height}</span> : null}
      <span>{stats?.fps !== undefined ? `${stats.fps.toFixed(1)} кадр/с` : 'Измеряем частоту…'}</span>
      {stats?.mbps !== undefined && <span>{stats.mbps.toFixed(1)} Мбит/с</span>}
      {stats?.rtt !== undefined && <span title="Время обмена пакетами с медиасервером; не полная задержка видео">Отклик {Math.round(stats.rtt * 1000)} мс</span>}
      {stats?.loss !== undefined && <span>Потери {stats.loss.toFixed(1)}%</span>}
      {stats?.transport && <span title="Транспорт WebRTC до медиасервера. VPN может использовать собственный протокол.">WebRTC: {stats.transport}{stats.relay ? ' · через ретранслятор' : ''}</span>}
      {!local && stats?.freezes !== undefined && <span>Замираний {stats.freezes}</span>}
      {!local && stats?.drops !== undefined && <span>Пропущено кадров {stats.drops}</span>}
      {stats?.processingMs !== undefined && <span title="Среднее время обработки кадра за последний интервал">{local ? 'Кодирование' : 'Декодирование'} {stats.processingMs.toFixed(1)} мс/кадр</span>}
      {local && targetFps !== undefined && <span className="screen-target">Цель: до {targetFps} кадр/с</span>}
    </div>
  </div>;
}
