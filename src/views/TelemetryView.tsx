import { kage } from "../lib/bridge";
import { formatBytes, formatDuration } from "../lib/format";
import { VENDOR_LABEL, type EngineStats } from "../lib/types";
import { IconRefresh, IconShield } from "../components/Icons";

interface TelemetryViewProps {
  stats: EngineStats;
  diskFreeBytes: number | null;
  busy: boolean;
  onRestartEngine: () => void;
  onSimulateDeviceLoss: () => void;
}

function StageStatRow({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "ok" | "warn" | "rec";
}) {
  const valueClass =
    tone === "ok"
      ? "text-[#4ADE80]"
      : tone === "warn"
        ? "text-[#F5B971]"
        : tone === "rec"
          ? "text-[#FF6B6F]"
          : "text-[#F3ECE4]";

  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[#282320] py-2 last:border-b-0">
      <dt className="text-xs text-[#94897E]">{label}</dt>
      <dd className={`select-text text-right font-mono text-xs font-medium tabular-nums ${valueClass}`}>
        {value}
      </dd>
    </div>
  );
}

export function TelemetryView({
  stats,
  diskFreeBytes,
  busy,
  onRestartEngine,
  onSimulateDeviceLoss,
}: TelemetryViewProps) {
  const idle = stats.state === "idle";
  const isDev = Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  const showSimLoss = !kage.isTauri() || isDev;
  const driftMs = stats.audio_drift_ms;
  const driftClampedPct = Math.min(50, Math.max(-50, (driftMs / 50) * 50));
  const driftTone = idle
    ? "default"
    : Math.abs(driftMs) > 35
      ? "warn"
      : "ok";

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-none text-[#F3ECE4]">
            Signal Flow Telemetry
          </h1>
          <p className="mt-1.5 text-xs text-[#B5AA9F]">
            Three-stage hardware capture inspection from DXGI duplication to AAC/MP4 output.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {showSimLoss && (
            <button
              type="button"
              disabled={busy}
              onClick={onSimulateDeviceLoss}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#F5B971] hover:border-[#F5B971] disabled:opacity-50"
            >
              <IconShield className="h-3.5 w-3.5" />
              <span>Test Device Recovery</span>
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onRestartEngine}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:opacity-50"
          >
            <IconRefresh className="h-3.5 w-3.5" />
            <span>Restart Engine</span>
          </button>
        </div>
      </div>

      {(stats.last_error || stats.audio_error) && (
        <div className="flex flex-col gap-2">
          {stats.last_error && (
            <div
              role="alert"
              className="select-text rounded-[12px] border border-[#FF6B6F]/50 bg-[#241112] px-4 py-3 text-xs text-[#F3ECE4]"
            >
              <span className="font-semibold text-[#FF6B6F]">Video Pipeline Notice: </span>
              {stats.last_error}
            </div>
          )}
          {stats.audio_error && (
            <div
              role="alert"
              className="select-text rounded-[12px] border border-[#F5B971]/50 bg-[#1B1610] px-4 py-3 text-xs text-[#F3ECE4]"
            >
              <span className="font-semibold text-[#F5B971]">Audio Subsystem Notice: </span>
              {stats.audio_error}
            </div>
          )}
        </div>
      )}

      {/* 3-Stage Signal Flow Pipeline */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Stage 1: Capture & Display */}
        <section aria-label="Stage 1 Capture and Display" className="bezel-outer">
          <div className="bezel-inner flex h-full flex-col justify-between gap-4 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E6C29F]">
                  Stage 01 / Capture
                </span>
                <span
                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${
                    idle
                      ? "border border-[#282320] bg-[#0D0B0A] text-[#94897E]"
                      : stats.state === "error"
                        ? "border border-[#FF6B6F]/40 bg-[#241112] text-[#FF6B6F]"
                        : "border border-[#4ADE80]/30 bg-[#101A14] text-[#4ADE80]"
                  }`}
                >
                  {stats.state}
                </span>
              </div>
              <h2 className="font-display mt-2 text-2xl text-[#F3ECE4]">
                DXGI Desktop Duplication
              </h2>
              <div className="select-text mt-3 font-mono text-2xl font-semibold tabular-nums text-[#F3ECE4]">
                {idle ? "Standby" : `${stats.capture_fps.toFixed(1)} fps`}
              </div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#94897E]">
                {idle || stats.width === 0
                  ? `Target ${stats.target_fps} fps`
                  : `${stats.width}x${stats.height} targeting ${stats.target_fps} fps`}
              </div>
            </div>

            <dl className="rounded-[10px] border border-[#282320] bg-[#0D0B0A] px-3.5 py-1">
              <StageStatRow
                label="Display Adapter"
                value={idle ? "--" : stats.encoder.adapter_name}
              />
              <StageStatRow
                label="Adapter VRAM"
                value={
                  idle
                    ? "--"
                    : `${stats.encoder.dedicated_vram_mb} MB (${stats.integrated_gpu ? "iGPU" : "dGPU"})`
                }
              />
              <StageStatRow
                label="Dropped Frames"
                value={idle ? "--" : String(stats.dropped_frames)}
                tone={!idle && stats.dropped_frames > 0 ? "warn" : "default"}
              />
              <StageStatRow
                label="Device Resets"
                value={idle ? "--" : String(stats.device_resets)}
              />
              <StageStatRow
                label="Privacy Gate"
                value={stats.privacy_active ? "Paused" : "Pass-through"}
                tone={stats.privacy_active ? "warn" : "default"}
              />
            </dl>
          </div>
        </section>

        {/* Stage 2: Hardware Encoder & Memory */}
        <section aria-label="Stage 2 Encoder and Storage" className="bezel-outer">
          <div className="bezel-inner flex h-full flex-col justify-between gap-4 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E6C29F]">
                  Stage 02 / Encoder
                </span>
                <span className="font-mono text-[10px] text-[#B5AA9F]">
                  {idle ? "Idle" : stats.encoder.hardware ? "GPU MFT" : "CPU MFT"}
                </span>
              </div>
              <h2 className="font-display mt-2 text-2xl text-[#F3ECE4]">
                NV12 Transform and MP4 Sink
              </h2>
              <div className="select-text mt-3 font-mono text-2xl font-semibold tabular-nums text-[#F3ECE4]">
                {idle ? "--" : `${stats.encode_ms_avg.toFixed(2)} ms`}
              </div>
              <div className="mt-0.5 font-mono text-[11px] tabular-nums text-[#94897E]">
                {idle
                  ? "No active frame encode timings"
                  : `GPU submit ${stats.gpu_submit_ms_avg.toFixed(2)} ms/frame`}
              </div>
            </div>

            <dl className="rounded-[10px] border border-[#282320] bg-[#0D0B0A] px-3.5 py-1">
              <StageStatRow
                label="Encoder Backend"
                value={idle ? "Standby" : VENDOR_LABEL[stats.encoder.vendor]}
              />
              <StageStatRow
                label="Codec & Bitrate"
                value={
                  idle
                    ? "--"
                    : `${stats.encoder.codec} @ ${(stats.bitrate_kbps / 1000).toFixed(0)} Mbps`
                }
              />
              <StageStatRow
                label="Ring / Process RSS"
                value={`${formatBytes(stats.ring_bytes)} / ${formatBytes(stats.process_rss_bytes)}`}
              />
              <StageStatRow
                label="Direct Stream"
                value={
                  stats.recording_active
                    ? `${formatDuration(stats.recording_seconds)} (${formatBytes(stats.recording_bytes)})`
                    : "Standby"
                }
                tone={stats.recording_active ? "rec" : "default"}
              />
              <StageStatRow
                label="Disk Free Space"
                value={diskFreeBytes !== null ? formatBytes(diskFreeBytes) : "Unavailable"}
              />
            </dl>
          </div>
        </section>

        {/* Stage 3: Audio Sync & Runtime */}
        <section aria-label="Stage 3 Audio Sync and Runtime" className="bezel-outer">
          <div className="bezel-inner flex h-full flex-col justify-between gap-4 p-5">
            <div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E6C29F]">
                  Stage 03 / Audio & Sync
                </span>
                <span className="font-mono text-[10px] text-[#B5AA9F]">
                  48 kHz AAC
                </span>
              </div>
              <h2 className="font-display mt-2 text-2xl text-[#F3ECE4]">
                QPC Clock Alignment
              </h2>
              <div
                className={`select-text mt-3 font-mono text-2xl font-semibold tabular-nums ${
                  driftTone === "warn"
                    ? "text-[#F5B971]"
                    : driftTone === "ok"
                      ? "text-[#4ADE80]"
                      : "text-[#F3ECE4]"
                }`}
              >
                {idle ? "--" : `${driftMs >= 0 ? "+" : ""}${driftMs.toFixed(1)} ms`}
              </div>

              {/* Centered Drift Tolerance Meter (-50ms to +50ms) */}
              <div className="mt-2">
                <div className="relative h-2 w-full overflow-hidden rounded-full border border-[#282320] bg-[#0D0B0A]">
                  <div className="absolute inset-y-0 left-1/2 w-px bg-[#6E655E]" />
                  {!idle && (
                    <div
                      className={`absolute inset-y-0 w-2 -translate-x-1/2 rounded-full ${
                        Math.abs(driftMs) > 35 ? "bg-[#F5B971]" : "bg-[#4ADE80]"
                      }`}
                      style={{ left: `${50 + driftClampedPct}%` }}
                    />
                  )}
                </div>
                <div className="mt-1 flex justify-between font-mono text-[10px] text-[#94897E]">
                  <span>-50 ms</span>
                  <span>0 ms lock</span>
                  <span>+50 ms</span>
                </div>
              </div>
            </div>

            <dl className="rounded-[10px] border border-[#282320] bg-[#0D0B0A] px-3.5 py-1">
              <StageStatRow
                label="System Loopback"
                value={stats.audio_system ? "Enabled" : "Muted"}
                tone={stats.audio_system ? "ok" : "default"}
              />
              <StageStatRow
                label="Microphone Mix"
                value={stats.audio_mic ? "Enabled" : "Off"}
                tone={stats.audio_mic ? "ok" : "default"}
              />
              <StageStatRow
                label="Ring Packets"
                value={stats.ring_enabled ? `${stats.ring_frames} pkts` : "0 (Direct Only)"}
              />
              <StageStatRow
                label="Game Performance"
                value={stats.performance_mode ? "ON (Low Overhead)" : "Standard"}
              />
              <StageStatRow
                label="Engine Uptime"
                value={idle ? "--" : formatDuration(stats.uptime_seconds)}
              />
            </dl>
          </div>
        </section>
      </div>
    </div>
  );
}
