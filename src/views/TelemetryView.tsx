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

function MetricCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "default" | "ok" | "warn" | "rec";
}) {
  const valueColor =
    tone === "ok"
      ? "text-[#4ADE80]"
      : tone === "warn"
        ? "text-[#F5B971]"
        : tone === "rec"
          ? "text-[#FF6B6F]"
          : "text-[#F3ECE4]";

  return (
    <div className="bezel-outer">
      <div className="bezel-inner flex flex-col justify-between gap-2 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[#94897E]">
          {label}
        </div>
        <div className={`font-mono text-2xl font-semibold tabular-nums ${valueColor}`}>
          {value}
        </div>
        <div className="text-xs text-[#B5AA9F]">{sub}</div>
      </div>
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
  const driftTone =
    Math.abs(stats.audio_drift_ms) > 35
      ? "warn"
      : Math.abs(stats.audio_drift_ms) > 0
        ? "ok"
        : "default";

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-none text-[#F3ECE4]">
            Engine Telemetry
          </h1>
          <p className="mt-1.5 text-xs text-[#B5AA9F]">
            Live hardware pipeline timings, COM/ring memory footprint, A/V sync drift, and storage health.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onSimulateDeviceLoss}
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#F5B971] hover:border-[#F5B971] disabled:opacity-50"
          >
            <IconShield className="h-3.5 w-3.5" />
            <span>Test Device Recovery</span>
          </button>
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

      {/* Diagnostic Alert Banners */}
      {(stats.last_error || stats.audio_error) && (
        <div className="flex flex-col gap-2">
          {stats.last_error && (
            <div className="rounded-[12px] border border-[#FF6B6F]/50 bg-[#241112] px-4 py-3 text-xs text-[#F3ECE4]">
              <span className="font-semibold text-[#FF6B6F]">Video Pipeline Notice: </span>
              {stats.last_error}
            </div>
          )}
          {stats.audio_error && (
            <div className="rounded-[12px] border border-[#F5B971]/50 bg-[#1B1610] px-4 py-3 text-xs text-[#F3ECE4]">
              <span className="font-semibold text-[#F5B971]">Audio Subsystem Notice: </span>
              {stats.audio_error}
            </div>
          )}
        </div>
      )}

      {/* Primary KPI Grid */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Capture Cadence"
          value={`${stats.capture_fps.toFixed(1)} fps`}
          sub={`Target ${stats.target_fps} fps (${stats.width}x${stats.height})`}
          tone={stats.state === "buffering" ? "ok" : "default"}
        />
        <MetricCard
          label="Encode Latency"
          value={`${stats.encode_ms_avg.toFixed(2)} ms`}
          sub={`GPU submit ${stats.gpu_submit_ms_avg.toFixed(2)} ms/frame`}
        />
        <MetricCard
          label="Memory Footprint"
          value={formatBytes(stats.process_rss_bytes)}
          sub={`Ring buffer ${formatBytes(stats.ring_bytes)} (${stats.ring_frames} pkts)`}
        />
        <MetricCard
          label="Audio Sync Drift"
          value={`${stats.audio_drift_ms >= 0 ? "+" : ""}${stats.audio_drift_ms.toFixed(1)} ms`}
          sub={`System: ${stats.audio_system ? "On" : "Off"} / Mic: ${stats.audio_mic ? "On" : "Off"}`}
          tone={driftTone}
        />
        <MetricCard
          label="Dropped Frames"
          value={String(stats.dropped_frames)}
          sub={`Device resets: ${stats.device_resets}`}
          tone={stats.dropped_frames > 0 ? "warn" : "default"}
        />
        <MetricCard
          label="Direct Recording"
          value={stats.recording_active ? formatDuration(stats.recording_seconds) : "Standby"}
          sub={
            stats.recording_active
              ? `${formatBytes(stats.recording_bytes)} written`
              : "0 MB buffer overhead when idle"
          }
          tone={stats.recording_active ? "rec" : "default"}
        />
        <MetricCard
          label="Disk Free Space"
          value={diskFreeBytes !== null ? formatBytes(diskFreeBytes) : "Unavailable"}
          sub="Output directory free capacity"
        />
        <MetricCard
          label="Engine Uptime"
          value={formatDuration(stats.uptime_seconds)}
          sub={stats.performance_mode ? "Game Performance Mode: ON" : "Standard GPU Mode"}
        />
      </div>

      {/* Hardware Adapter Detail Card */}
      <section aria-label="Hardware Pipeline Details" className="bezel-outer">
        <div className="bezel-inner p-5">
          <h2 className="font-display text-2xl text-[#F3ECE4]">
            Hardware Adapter and Encoder
          </h2>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-xs">
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Encoder Backend</dt>
              <dd className="mt-1 font-medium text-[#F3ECE4]">
                {VENDOR_LABEL[stats.encoder.vendor]} ({stats.encoder.friendly_name})
              </dd>
            </div>
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Display Adapter</dt>
              <dd className="mt-1 font-medium text-[#F3ECE4]">
                {stats.encoder.adapter_name}
              </dd>
            </div>
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Codec and Bitrate</dt>
              <dd className="mt-1 font-mono tabular-nums text-[#E6C29F]">
                {stats.encoder.codec} at {(stats.bitrate_kbps / 1000).toFixed(0)} Mbps
              </dd>
            </div>
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Adapter Dedicated VRAM</dt>
              <dd className="mt-1 font-mono tabular-nums text-[#F3ECE4]">
                {stats.encoder.dedicated_vram_mb} MB ({stats.integrated_gpu ? "Integrated GPU" : "Discrete GPU"})
              </dd>
            </div>
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Hardware Acceleration</dt>
              <dd className="mt-1 font-medium text-[#4ADE80]">
                {stats.encoder.hardware ? "Zero-Copy D3D11 + MFT Hardware" : "Software Fallback"}
              </dd>
            </div>
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-3">
              <dt className="text-[#94897E]">Privacy Gate</dt>
              <dd className="mt-1 font-medium text-[#F3ECE4]">
                {stats.privacy_active ? "Paused on Desktop / Deck" : "Inactive"}
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}
