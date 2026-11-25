import { formatBytes } from "../lib/format";
import { VENDOR_LABEL, type EngineStats } from "../lib/types";
import {
  IconLibrary,
  IconProfiles,
  IconSettings,
  IconStudio,
  IconTelemetry,
  KageLogo,
} from "./Icons";

export type AppTab = "studio" | "library" | "profiles" | "telemetry" | "settings";

interface SidebarProps {
  tab: AppTab;
  onTabChange: (next: AppTab) => void;
  clipCount: number;
  stats: EngineStats;
  diskFreeBytes: number | null;
  activeProfileName: string | null;
  ecoActive: boolean;
}

const NAV_ITEMS: Array<{
  id: AppTab;
  label: string;
  Icon: typeof IconStudio;
}> = [
  { id: "studio", label: "Studio", Icon: IconStudio },
  { id: "library", label: "Library", Icon: IconLibrary },
  { id: "profiles", label: "Profiles", Icon: IconProfiles },
  { id: "telemetry", label: "Telemetry", Icon: IconTelemetry },
  { id: "settings", label: "Settings", Icon: IconSettings },
];

export function Sidebar({
  tab,
  onTabChange,
  clipCount,
  stats,
  diskFreeBytes,
  activeProfileName,
  ecoActive,
}: SidebarProps) {
  const vendor = VENDOR_LABEL[stats.encoder.vendor] ?? stats.encoder.codec;

  return (
    <aside className="flex w-[204px] shrink-0 flex-col justify-between border-r border-[#282320] bg-[#0D0B0A] p-3">
      <div className="flex flex-col gap-5">
        {/* Brand Identity */}
        <div className="flex items-center gap-2.5 px-1.5 pt-1">
          <KageLogo className="h-8 w-8 shrink-0" />
          <div className="min-w-0">
            <div className="font-display text-[22px] leading-none tracking-[0.04em] text-[#F3ECE4]">
              KAGE
            </div>
            <div className="mt-0.5 text-[10px] font-semibold tracking-[0.2em] text-[#94897E] uppercase">
              Studio Engine
            </div>
          </div>
        </div>

        {/* Navigation Rail */}
        <nav aria-label="Main sections" className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ id, label, Icon }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onTabChange(id)}
                aria-current={active ? "page" : undefined}
                className={`group flex items-center justify-between rounded-[10px] px-3 py-2 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-[#1A1715] text-[#F3ECE4] border border-[#6E655E]"
                    : "border border-transparent text-[#B5AA9F] hover:bg-[#141210] hover:text-[#F3ECE4]"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 ${
                      active ? "text-[#E6C29F]" : "text-[#94897E] group-hover:text-[#F3ECE4]"
                    }`}
                  />
                  <span>{label}</span>
                </span>
                {id === "library" && (
                  <span className="rounded-md bg-[#12100E] border border-[#282320] px-1.5 py-0.5 text-[10px] tabular-nums text-[#B5AA9F]">
                    {clipCount}
                  </span>
                )}
                {id === "telemetry" && stats.last_error && (
                  <span
                    title={stats.last_error}
                    className="h-2 w-2 rounded-full bg-[#FF6B6F]"
                  />
                )}
              </button>
            );
          })}
        </nav>

        {(activeProfileName || ecoActive) && (
          <div className="flex flex-col gap-1.5 px-1">
            {activeProfileName && (
              <div className="rounded-[8px] border border-[#282320] bg-[#12100E] px-2.5 py-1.5 text-[11px]">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[#94897E]">
                  Active Profile
                </div>
                <div className="truncate font-medium text-[#E6C29F]">
                  {activeProfileName}
                </div>
              </div>
            )}
            {ecoActive && (
              <div className="rounded-[8px] border border-[#F5B971]/40 bg-[#1B1610] px-2.5 py-1 text-[11px] font-medium text-[#F5B971]">
                ECO Capture Active
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Hardware & Storage Footprint */}
      <div className="rounded-[12px] border border-[#282320] bg-[#12100E] p-3 text-[11px]">
        <div className="flex items-center justify-between text-[#94897E]">
          <span>Encoder</span>
          <span className="font-medium text-[#F3ECE4] truncate max-w-[104px]" title={stats.encoder.friendly_name}>
            {vendor}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[#94897E]">
          <span>Ring RAM</span>
          <span className="tabular-nums font-medium text-[#B5AA9F]">
            {formatBytes(stats.ring_bytes)}
          </span>
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[#94897E]">
          <span>App RSS</span>
          <span className="tabular-nums font-medium text-[#B5AA9F]">
            {formatBytes(stats.process_rss_bytes)}
          </span>
        </div>
        {diskFreeBytes !== null && (
          <div className="mt-1.5 flex items-center justify-between text-[#94897E]">
            <span>Disk Free</span>
            <span className="tabular-nums font-medium text-[#F3ECE4]">
              {formatBytes(diskFreeBytes)}
            </span>
          </div>
        )}
      </div>
    </aside>
  );
}
