import { useState } from "react";
import type {
  AppSettings,
  CaptureProfile,
  ForegroundGame,
  ProfileMapEntry,
} from "../lib/types";
import { IconPlus, IconRefresh, IconTrash } from "../components/Icons";

interface ProfilesViewProps {
  settings: AppSettings;
  activeProfileId: string | null;
  foreground: ForegroundGame | null;
  busy: boolean;
  onPatchSettings: (patch: Partial<AppSettings>) => void;
  onApplyProfile: (profileId: string) => void;
  onSaveProfile: (profile: CaptureProfile) => Promise<boolean>;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileMap: (map: ProfileMapEntry[]) => void;
  onRefreshForeground: () => void;
}

const EMPTY_FORM: CaptureProfile = {
  id: "",
  name: "",
  bufferSeconds: 90,
  targetFps: 60,
  bitrateKbps: 20000,
  codec: "h264",
};

export function ProfilesView({
  settings,
  activeProfileId,
  foreground,
  busy,
  onPatchSettings,
  onApplyProfile,
  onSaveProfile,
  onDeleteProfile,
  onSetProfileMap,
  onRefreshForeground,
}: ProfilesViewProps) {
  const [form, setForm] = useState<CaptureProfile>(EMPTY_FORM);
  const [editing, setEditing] = useState(false);
  const [mapExe, setMapExe] = useState("");
  const [mapProfileId, setMapProfileId] = useState(
    settings.profiles[0]?.id ?? "default",
  );

  const handleSaveForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const id =
      form.id.trim() ||
      form.name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
    if (!id || !form.name.trim()) return;
    const ok = await onSaveProfile({ ...form, id, name: form.name.trim() });
    if (ok) {
      setForm(EMPTY_FORM);
      setEditing(false);
    }
  };

  const handleAddMapping = (exeName: string, profileId: string) => {
    const clean = exeName.trim().toLowerCase();
    if (!clean) return;
    const next = [
      ...settings.profileMap.filter((m) => m.exeName.toLowerCase() !== clean),
      { exeName: clean, profileId },
    ];
    onSetProfileMap(next);
    setMapExe("");
  };

  return (
    <div className="flex flex-col gap-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-4xl leading-none text-[#F3ECE4]">
            Capture Profiles
          </h1>
          <p className="mt-1.5 text-xs text-[#B5AA9F]">
            Bind rolling buffer window, FPS, bitrate, and codec per game executable.
          </p>
        </div>

        <label className="flex items-center gap-2.5 rounded-[10px] border border-[#282320] bg-[#12100E] px-3.5 py-2 text-xs text-[#F3ECE4]">
          <input
            type="checkbox"
            checked={settings.autoSwitchProfiles}
            onChange={(e) =>
              onPatchSettings({ autoSwitchProfiles: e.target.checked })
            }
            className="h-4 w-4 accent-[#E6C29F]"
          />
          <span>Auto-switch on game focus</span>
        </label>
      </div>

      {/* Live Foreground Detector */}
      <section aria-label="Foreground Application" className="bezel-outer">
        <div className="bezel-inner flex flex-wrap items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-[#94897E]">
              Active Foreground Window
            </div>
            {foreground ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold text-[#E6C29F]">
                  {foreground.exe}
                </span>
                <span className="truncate max-w-md text-xs text-[#B5AA9F]">
                  {foreground.title || "Untitled Window"}
                </span>
              </div>
            ) : (
              <div className="mt-1 text-xs text-[#94897E]">
                No foreground window detected or query blocked by OS desktop.
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {foreground?.exe && (
              <button
                type="button"
                onClick={() => handleAddMapping(foreground.exe, mapProfileId)}
                className="rounded-full bg-[#E6C29F] px-3.5 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4]"
              >
                Map to Selected Profile
              </button>
            )}
            <button
              type="button"
              onClick={onRefreshForeground}
              className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#1A1715] px-3 py-1.5 text-xs text-[#F3ECE4] hover:border-[#E6C29F]"
            >
              <IconRefresh className="h-3.5 w-3.5" />
              <span>Probe</span>
            </button>
          </div>
        </div>
      </section>

      {/* Profiles Grid */}
      <section aria-label="Saved Profiles" className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-2xl text-[#F3ECE4]">Presets</h2>
          <button
            type="button"
            onClick={() => {
              setForm(EMPTY_FORM);
              setEditing((s) => !s);
            }}
            className="inline-flex items-center gap-1.5 rounded-[8px] border border-[#6E655E] bg-[#12100E] px-3 py-1.5 text-xs font-medium text-[#E6C29F] hover:border-[#E6C29F]"
          >
            <IconPlus className="h-3.5 w-3.5" />
            <span>{editing ? "Close Editor" : "New Profile"}</span>
          </button>
        </div>

        {editing && (
          <form onSubmit={(e) => void handleSaveForm(e)} className="bezel-outer">
            <div className="bezel-inner grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-5">
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[#94897E]">Name</span>
                <input
                  type="text"
                  required
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Competitive 120Hz"
                  className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-2.5 py-1.5 text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[#94897E]">Buffer (sec)</span>
                <input
                  type="number"
                  min={15}
                  max={300}
                  step={15}
                  value={form.bufferSeconds}
                  onChange={(e) =>
                    setForm({ ...form, bufferSeconds: Number(e.target.value) })
                  }
                  className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-2.5 py-1.5 font-mono text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                />
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[#94897E]">FPS</span>
                <select
                  value={form.targetFps}
                  onChange={(e) =>
                    setForm({ ...form, targetFps: Number(e.target.value) })
                  }
                  className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-2.5 py-1.5 font-mono text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                >
                  <option value={30}>30</option>
                  <option value={60}>60</option>
                  <option value={120}>120</option>
                </select>
              </label>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-[#94897E]">Bitrate (Mbps)</span>
                <input
                  type="number"
                  min={4}
                  max={80}
                  step={2}
                  value={Math.round(form.bitrateKbps / 1000)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      bitrateKbps: Number(e.target.value) * 1000,
                    })
                  }
                  className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-2.5 py-1.5 font-mono text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                />
              </label>

              <div className="flex items-end gap-2">
                <select
                  value={form.codec}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      codec: e.target.value as "h264" | "hevc",
                    })
                  }
                  aria-label="Profile codec"
                  className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-2.5 py-1.5 font-mono text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
                >
                  <option value="h264">H.264</option>
                  <option value="hevc">HEVC</option>
                </select>
                <button
                  type="submit"
                  className="flex-1 rounded-full bg-[#E6C29F] px-3 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4]"
                >
                  Save
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {settings.profiles.map((p) => {
            const active = p.id === activeProfileId;
            return (
              <div key={p.id} className="bezel-outer">
                <div
                  className={`bezel-inner flex h-full flex-col justify-between gap-3 p-4 ${
                    active ? "border-[#E6C29F]" : ""
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold text-[#F3ECE4]">
                        {p.name}
                      </h3>
                      {active && (
                        <span className="rounded-[5px] bg-[#E6C29F] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#0A0908]">
                          ACTIVE
                        </span>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 font-mono text-xs tabular-nums text-[#B5AA9F]">
                      <span>{p.bufferSeconds}s</span>
                      <span>/</span>
                      <span>{p.targetFps}fps</span>
                      <span>/</span>
                      <span>{(p.bitrateKbps / 1000).toFixed(0)} Mbps</span>
                      <span>/</span>
                      <span className="uppercase">{p.codec}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#282320]">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => onApplyProfile(p.id)}
                      className="rounded-full bg-[#E6C29F] px-3.5 py-1 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4] disabled:opacity-50"
                    >
                      Apply
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setForm(p);
                          setEditing(true);
                        }}
                        className="rounded-[6px] border border-[#282320] bg-[#1A1715] px-2.5 py-1 text-xs text-[#B5AA9F] hover:text-[#F3ECE4]"
                      >
                        Edit
                      </button>
                      {p.id !== "default" && (
                        <button
                          type="button"
                          onClick={() => onDeleteProfile(p.id)}
                          aria-label={`Delete ${p.name}`}
                          className="grid h-7 w-7 place-items-center rounded-[6px] border border-[#C92A32]/50 bg-[#1A1011] text-[#FF6B6F] hover:border-[#FF6B6F]"
                        >
                          <IconTrash className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Process Mappings */}
      <section aria-label="Game Mappings" className="bezel-outer">
        <div className="bezel-inner flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="font-display text-2xl text-[#F3ECE4]">
                Executable Mappings
              </h2>
              <p className="text-xs text-[#94897E]">
                Add `.exe` names to apply a profile automatically when that window gains focus.
              </p>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAddMapping(mapExe, mapProfileId);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="text"
              value={mapExe}
              onChange={(e) => setMapExe(e.target.value)}
              placeholder="e.g. cs2.exe"
              aria-label="Executable file name"
              className="min-w-[180px] flex-1 rounded-[8px] border border-[#282320] bg-[#0A0908] px-3 py-1.5 font-mono text-xs text-[#F3ECE4] placeholder:text-[#94897E] focus:border-[#E6C29F] focus:outline-none"
            />
            <select
              value={mapProfileId}
              onChange={(e) => setMapProfileId(e.target.value)}
              aria-label="Target profile"
              className="rounded-[8px] border border-[#282320] bg-[#0A0908] px-3 py-1.5 text-xs text-[#F3ECE4] focus:border-[#E6C29F] focus:outline-none"
            >
              {settings.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="submit"
              className="rounded-full bg-[#E6C29F] px-4 py-1.5 text-xs font-semibold text-[#0A0908] hover:bg-[#F0D2B4]"
            >
              Add Rule
            </button>
          </form>

          {settings.profileMap.length === 0 ? (
            <div className="rounded-[8px] border border-[#282320] bg-[#0D0B0A] p-4 text-xs text-[#94897E]">
              No game executable rules configured yet.
            </div>
          ) : (
            <div className="divide-y divide-[#282320] rounded-[8px] border border-[#282320] bg-[#0D0B0A]">
              {settings.profileMap.map((entry) => {
                const prof = settings.profiles.find((p) => p.id === entry.profileId);
                return (
                  <div
                    key={entry.exeName}
                    className="flex items-center justify-between gap-2 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-mono font-medium text-[#F3ECE4]">
                        {entry.exeName}
                      </span>
                      <span className="text-[#94897E]">-&gt;</span>
                      <span className="text-[#E6C29F]">
                        {prof?.name ?? entry.profileId}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        onSetProfileMap(
                          settings.profileMap.filter(
                            (m) => m.exeName !== entry.exeName,
                          ),
                        )
                      }
                      aria-label={`Remove mapping for ${entry.exeName}`}
                      className="grid h-7 w-7 place-items-center rounded-[6px] text-[#94897E] hover:bg-[#1A1011] hover:text-[#FF6B6F]"
                    >
                      <IconTrash className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
