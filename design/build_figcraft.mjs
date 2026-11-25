import fs from "node:fs";
import path from "node:path";

const cmds = [];
let nextId = 2; // Page 1 already exists with id = 1

function addCmd(command, params) {
  cmds.push({ command, params });
}

function addPage(name, bg) {
  const id = nextId++;
  addCmd("page.add", { name });
  if (bg) addCmd("page.setBackground", { id, color: bg });
  return id;
}

function createFrame({ name, x, y, width, height, parent, props = {} }) {
  const id = nextId++;
  addCmd("frame.create", { name, x, y, width, height, ...(parent ? { parent } : {}), props });
  return id;
}

function rect({ name, x, y, width, height, parent, props = {} }) {
  const id = nextId++;
  addCmd("shape.rectangle", { name, x, y, width, height, parent, props });
  return id;
}

function circle({ name, x, y, size, parent, props = {} }) {
  const id = nextId++;
  addCmd("shape.ellipse", { name, x, y, width: size, height: size, parent, props });
  return id;
}

function vector({ name, x, y, path: d, closed = true, parent, props = {} }) {
  const id = nextId++;
  addCmd("vector.create", { name, x, y, path: d, closed, parent, props });
  return id;
}

function text({ name, characters, x, y, width, parent, props = {} }) {
  const id = nextId++;
  addCmd("text.create", {
    name,
    characters,
    x,
    y,
    ...(width ? { width } : {}),
    parent,
    props,
  });
  return id;
}

const C = {
  bg: "#0A0908",
  sidebar: "#0D0B0A",
  surface: "#12100E",
  elevated: "#1A1715",
  slash: "#161311",
  divider: "#282320",
  borderControl: "#6E655E",
  text: "#F3ECE4",
  textSecondary: "#B5AA9F",
  textMuted: "#94897E",
  accent: "#E6C29F",
  rec: "#C92A32",
  recBright: "#E5484D",
  recText: "#FF6B6F",
  ok: "#4ADE80",
  warn: "#F5B971",
  white: "#FFFFFF",
};

// =========================================================================
// PAGE 1: Brand & Logo
// =========================================================================
addCmd("page.rename", { name: "Brand & Logo" });
addCmd("page.setBackground", { id: 1, color: "#070605" });

// 1024x1024 App Icon
const iconFrame = createFrame({
  name: "KAGE-Icon-1024",
  x: 0,
  y: 0,
  width: 1024,
  height: 1024,
  props: {
    fill: C.bg,
    cornerRadius: 224,
    stroke: C.divider,
    strokeWeight: 14,
    strokeAlign: "inside",
    clip: true,
  },
});

// Subtle diagonal plane split (Reference Image 2 homage)
vector({
  name: "DiagonalSurface",
  x: 0,
  y: 0,
  path: "M 560 0 L 1024 0 L 1024 1024 L 220 1024 Z",
  parent: iconFrame,
  props: { fill: C.surface },
});

// Thin structural diagonal hairline
vector({
  name: "DiagonalSeam",
  x: 0,
  y: 0,
  path: "M 556 0 L 564 0 L 224 1024 L 216 1024 Z",
  parent: iconFrame,
  props: { fill: C.divider },
});

// KAGE "K" Monogram: sharp spine + diagonal champagne blades + crimson aperture
vector({
  name: "K-Spine",
  x: 236,
  y: 196,
  path: "M 0 0 L 116 0 L 116 632 L 0 632 Z",
  parent: iconFrame,
  props: { fill: C.text },
});

vector({
  name: "K-UpperBlade",
  x: 352,
  y: 196,
  path: "M 0 316 L 324 0 L 464 0 L 122 334 Z",
  parent: iconFrame,
  props: { fill: C.accent },
});

vector({
  name: "K-LowerBlade",
  x: 352,
  y: 478,
  path: "M 122 0 L 464 350 L 320 350 L 0 34 Z",
  parent: iconFrame,
  props: { fill: C.accent },
});

circle({
  name: "K-RecAperture",
  x: 686,
  y: 452,
  size: 120,
  parent: iconFrame,
  props: { fill: C.recBright },
});

// Brand Wordmark & Palette Sheet
const wordmarkFrame = createFrame({
  name: "KAGE-Wordmark",
  x: 1120,
  y: 0,
  width: 1080,
  height: 360,
  props: {
    fill: C.bg,
    cornerRadius: 24,
    stroke: C.divider,
    strokeWeight: 2,
  },
});

// Mini icon inside wordmark
const miniBox = createFrame({
  name: "MiniMark",
  x: 64,
  y: 64,
  width: 128,
  height: 128,
  parent: wordmarkFrame,
  props: { fill: C.surface, cornerRadius: 28, stroke: C.divider, strokeWeight: 2 },
});
vector({ name: "MiniSpine", x: 30, y: 26, path: "M 0 0 L 15 0 L 15 76 L 0 76 Z", parent: miniBox, props: { fill: C.text } });
vector({ name: "MiniUp", x: 45, y: 26, path: "M 0 38 L 38 0 L 55 0 L 12 43 Z", parent: miniBox, props: { fill: C.accent } });
vector({ name: "MiniDown", x: 47, y: 62, path: "M 11 0 L 53 40 L 35 40 L 0 6 Z", parent: miniBox, props: { fill: C.accent } });
circle({ name: "MiniRec", x: 84, y: 56, size: 16, parent: miniBox, props: { fill: C.recBright } });

text({
  name: "WordmarkTitle",
  characters: "K A G E",
  x: 224,
  y: 66,
  parent: wordmarkFrame,
  props: { fontFamily: "Playfair Display", fontSize: 68, fill: C.text, letterSpacing: 10 },
});
text({
  name: "WordmarkSub",
  characters: "INSTANT REPLAY & DIRECT CAPTURE STUDIO",
  x: 228,
  y: 158,
  parent: wordmarkFrame,
  props: { fontFamily: "Inter", fontSize: 13, fill: C.textSecondary, letterSpacing: 3 },
});

const swatches = [
  { hex: "#0A0908", label: "Obsidian" },
  { hex: "#12100E", label: "Charcoal" },
  { hex: "#E6C29F", label: "Champagne" },
  { hex: "#C92A32", label: "Crimson REC" },
  { hex: "#F3ECE4", label: "Warm Ivory" },
];
swatches.forEach((sw, i) => {
  const sx = 64 + i * 192;
  rect({
    name: `Swatch-${sw.label}`,
    x: sx,
    y: 236,
    width: 172,
    height: 64,
    parent: wordmarkFrame,
    props: { fill: sw.hex, cornerRadius: 10, stroke: C.divider, strokeWeight: 1.5 },
  });
  text({
    name: `SwatchLabel-${sw.label}`,
    characters: `${sw.label}  ${sw.hex}`,
    x: sx,
    y: 310,
    parent: wordmarkFrame,
    props: { fontFamily: "Inter", fontSize: 11, fill: C.textSecondary },
  });
});

// =========================================================================
// PAGE 2: Desktop Screens
// =========================================================================
const screensPage = addPage("Desktop Screens", "#050504");

function buildShell(frameName, xOffset, activeNav, opts = {}) {
  const root = createFrame({
    name: frameName,
    x: xOffset,
    y: 0,
    width: 1280,
    height: 820,
    parent: screensPage,
    props: { fill: C.bg, clip: true },
  });

  // 36px Frameless TitleBar
  const titlebar = createFrame({
    name: "TitleBar",
    x: 0,
    y: 0,
    width: 1280,
    height: 36,
    parent: root,
    props: { fill: C.bg },
  });
  rect({ name: "TitleDivider", x: 0, y: 35, width: 1280, height: 1, parent: titlebar, props: { fill: C.divider } });
  rect({ name: "MiniK", x: 16, y: 10, width: 14, height: 16, parent: titlebar, props: { fill: C.accent, cornerRadius: 3 } });
  text({ name: "AppTitle", characters: "KAGE Studio", x: 38, y: 10, parent: titlebar, props: { fontFamily: "Inter", fontSize: 12, fill: C.text } });
  text({
    name: "EncoderBadge",
    characters: opts.recording ? "DIRECT REC  1080p60  NVENC" : "NVENC H.264  1080p60  GAME MODE",
    x: 138,
    y: 11,
    parent: titlebar,
    props: { fontFamily: "Inter", fontSize: 11, fill: opts.recording ? C.recText : C.textMuted },
  });
  text({ name: "WinCtrls", characters: "Pin    _    []    x", x: 1164, y: 10, parent: titlebar, props: { fontFamily: "Inter", fontSize: 11, fill: C.textSecondary } });

  // 220px Sidebar
  const sidebar = createFrame({
    name: "Sidebar",
    x: 0,
    y: 36,
    width: 220,
    height: 720,
    parent: root,
    props: { fill: C.sidebar },
  });
  rect({ name: "SideBorder", x: 219, y: 0, width: 1, height: 720, parent: sidebar, props: { fill: C.divider } });

  text({ name: "BrandHeader", characters: "KAGE", x: 24, y: 24, parent: sidebar, props: { fontFamily: "Playfair Display", fontSize: 28, fill: C.text, letterSpacing: 4 } });
  text({ name: "BrandVer", characters: "v2.0  LOCAL ONLY", x: 25, y: 60, parent: sidebar, props: { fontFamily: "Inter", fontSize: 10, fill: C.textMuted, letterSpacing: 1.5 } });

  const navs = ["Studio", "Library", "Profiles", "Telemetry", "Settings"];
  navs.forEach((label, idx) => {
    const ny = 108 + idx * 44;
    const isActive = label === activeNav;
    if (isActive) {
      rect({
        name: `NavActive-${label}`,
        x: 14,
        y: ny,
        width: 192,
        height: 36,
        parent: sidebar,
        props: { fill: C.elevated, cornerRadius: 8, stroke: C.divider, strokeWeight: 1 },
      });
      rect({
        name: `NavIndicator-${label}`,
        x: 14,
        y: ny + 8,
        width: 3,
        height: 20,
        parent: sidebar,
        props: { fill: C.accent, cornerRadius: 2 },
      });
    }
    text({
      name: `NavText-${label}`,
      characters: label,
      x: 32,
      y: ny + 10,
      parent: sidebar,
      props: { fontFamily: "Inter", fontSize: 13, fill: isActive ? C.accent : C.textSecondary },
    });
  });

  // Sidebar Hardware Footprint Box
  const hwBox = createFrame({
    name: "HardwareCard",
    x: 14,
    y: 608,
    width: 192,
    height: 92,
    parent: sidebar,
    props: { fill: C.surface, cornerRadius: 10, stroke: C.divider, strokeWeight: 1 },
  });
  text({ name: "HwTitle", characters: "NVIDIA NVENC", x: 14, y: 12, parent: hwBox, props: { fontFamily: "Inter", fontSize: 11, fill: C.text } });
  text({ name: "HwRam", characters: "Process RSS: 114 MB", x: 14, y: 34, parent: hwBox, props: { fontFamily: "Inter", fontSize: 11, fill: C.textSecondary } });
  text({
    name: "HwRing",
    characters: opts.recording ? "Disk Stream: 124.8 MB" : "Ring Buffer: 88.2 MB",
    x: 14,
    y: 54,
    parent: hwBox,
    props: { fontFamily: "Inter", fontSize: 11, fill: opts.recording ? C.recText : C.textMuted },
  });

  // 64px Bottom Transport Bar
  const transport = createFrame({
    name: "TransportBar",
    x: 0,
    y: 756,
    width: 1280,
    height: 64,
    parent: root,
    props: { fill: C.surface },
  });
  rect({ name: "TransDivider", x: 0, y: 0, width: 1280, height: 1, parent: transport, props: { fill: C.divider } });
  circle({ name: "TransDot", x: 24, y: 27, size: 10, parent: transport, props: { fill: opts.recording ? C.recBright : C.ok } });
  text({
    name: "TransState",
    characters: opts.recording ? "Recording MP4  00:42" : "Buffer Armed  58.4 / 60s",
    x: 44,
    y: 23,
    parent: transport,
    props: { fontFamily: "Inter", fontSize: 13, fill: C.text },
  });
  rect({ name: "ProgressBg", x: 236, y: 29, width: 220, height: 6, parent: transport, props: { fill: C.divider, cornerRadius: 3 } });
  rect({
    name: "ProgressFill",
    x: 236,
    y: 29,
    width: opts.recording ? 220 : 206,
    height: 6,
    parent: transport,
    props: { fill: opts.recording ? C.recBright : C.accent, cornerRadius: 3 },
  });

  // Quick Transport Buttons
  rect({ name: "TBtnSave", x: 520, y: 14, width: 148, height: 36, parent: transport, props: { fill: C.accent, cornerRadius: 18 } });
  text({ name: "TBtnSaveTxt", characters: "Save Replay  Alt+C", x: 538, y: 24, parent: transport, props: { fontFamily: "Inter", fontSize: 12, fill: C.bg } });

  rect({
    name: "TBtnRec",
    x: 680,
    y: 14,
    width: 152,
    height: 36,
    parent: transport,
    props: {
      fill: opts.recording ? C.rec : C.elevated,
      cornerRadius: 6,
      stroke: opts.recording ? C.recBright : C.rec,
      strokeWeight: 1.5,
    },
  });
  text({
    name: "TBtnRecTxt",
    characters: opts.recording ? "STOP REC  00:42" : "REC  Alt+R",
    x: opts.recording ? 702 : 722,
    y: 24,
    parent: transport,
    props: { fontFamily: "Inter", fontSize: 12, fill: opts.recording ? C.white : C.recText },
  });

  text({ name: "TransAudio", characters: "Game 100%   |   Mic Off   |   Folder", x: 1030, y: 24, parent: transport, props: { fontFamily: "Inter", fontSize: 12, fill: C.textSecondary } });

  return root;
}

// ---------------- Screen 1: Studio Armed ----------------
const s1 = buildShell("01-Studio-Armed", 0, "Studio", { recording: false });
const s1Main = createFrame({ name: "MainStudio", x: 220, y: 36, width: 1060, height: 720, parent: s1, props: { fill: C.bg } });

// Double-Bezel Hero Deck
const heroOuter = createFrame({
  name: "HeroOuterBezel",
  x: 28,
  y: 22,
  width: 1004,
  height: 360,
  parent: s1Main,
  props: { fill: C.elevated, cornerRadius: 16, stroke: C.divider, strokeWeight: 1 },
});
const heroInner = createFrame({
  name: "HeroInnerCore",
  x: 6,
  y: 6,
  width: 992,
  height: 348,
  parent: heroOuter,
  props: { fill: C.surface, cornerRadius: 12, clip: true },
});
// Diagonal slash geometric motif on right side (LAST inspiration)
vector({
  name: "HeroSlashBg",
  x: 560,
  y: 0,
  path: "M 180 0 L 432 0 L 432 348 L 0 348 Z",
  parent: heroInner,
  props: { fill: C.slash },
});
vector({
  name: "HeroSlashSeam",
  x: 558,
  y: 0,
  path: "M 180 0 L 182 0 L 2 348 L 0 348 Z",
  parent: heroInner,
  props: { fill: C.divider },
});

circle({ name: "StatusDot", x: 32, y: 31, size: 8, parent: heroInner, props: { fill: C.ok } });
text({
  name: "StatusLine",
  characters: "BUFFER ARMED  ·  60S ROLLING  ·  GAME MODE 1080P60",
  x: 48,
  y: 28,
  parent: heroInner,
  props: { fontFamily: "Inter", fontSize: 11, fill: C.textSecondary, letterSpacing: 1.5 },
});
text({
  name: "HeroHeadline",
  characters: "Shadow buffer armed.",
  x: 32,
  y: 60,
  parent: heroInner,
  props: { fontFamily: "Playfair Display", fontSize: 48, fill: C.text },
});
text({
  name: "HeroSub",
  characters: "58.4s cached in GPU-encoded memory. Flush instantly with Alt + C or start direct MP4 streaming with Alt + R.",
  x: 32,
  y: 128,
  width: 680,
  parent: heroInner,
  props: { fontFamily: "Inter", fontSize: 14, fill: C.textSecondary },
});

// Action Row
rect({ name: "BtnSavePrimary", x: 32, y: 186, width: 196, height: 46, parent: heroInner, props: { fill: C.accent, cornerRadius: 23 } });
text({ name: "BtnSaveLabel", characters: "Save Replay  Alt+C", x: 64, y: 201, parent: heroInner, props: { fontFamily: "Inter", fontSize: 14, fill: C.bg } });

const segBox = createFrame({
  name: "DurationSeg",
  x: 242,
  y: 186,
  width: 224,
  height: 46,
  parent: heroInner,
  props: { fill: C.elevated, cornerRadius: 8, stroke: C.divider, strokeWeight: 1 },
});
["15s", "30s", "60s", "Full"].forEach((d, idx) => {
  const dx = 6 + idx * 53;
  if (d === "60s") {
    rect({ name: "SegActive", x: dx, y: 5, width: 50, height: 36, parent: segBox, props: { fill: C.accent, cornerRadius: 6 } });
  }
  text({ name: `Seg-${d}`, characters: d, x: dx + 14, y: 15, parent: segBox, props: { fontFamily: "Inter", fontSize: 12, fill: d === "60s" ? C.bg : C.textSecondary } });
});

rect({ name: "BtnRecTactical", x: 482, y: 186, width: 168, height: 46, parent: heroInner, props: { fill: C.elevated, cornerRadius: 6, stroke: C.rec, strokeWeight: 1.5 } });
circle({ name: "BtnRecDot", x: 502, y: 204, size: 10, parent: heroInner, props: { fill: C.recBright } });
text({ name: "BtnRecLabel", characters: "REC  Alt+R", x: 522, y: 201, parent: heroInner, props: { fontFamily: "Inter", fontSize: 13, fill: C.recText } });

rect({ name: "BtnDisarm", x: 664, y: 186, width: 112, height: 46, parent: heroInner, props: { fill: C.surface, cornerRadius: 8, stroke: C.borderControl, strokeWeight: 1 } });
text({ name: "BtnDisarmLabel", characters: "Disarm", x: 696, y: 201, parent: heroInner, props: { fontFamily: "Inter", fontSize: 13, fill: C.text } });

// Audio Mix Strip inside Hero
rect({ name: "AudioRule", x: 32, y: 264, width: 928, height: 1, parent: heroInner, props: { fill: C.divider } });
text({ name: "GameVolTxt", characters: "Game Audio  100%", x: 32, y: 288, parent: heroInner, props: { fontFamily: "Inter", fontSize: 12, fill: C.textSecondary } });
rect({ name: "GameBarBg", x: 156, y: 293, width: 220, height: 6, parent: heroInner, props: { fill: C.divider, cornerRadius: 3 } });
rect({ name: "GameBarFill", x: 156, y: 293, width: 220, height: 6, parent: heroInner, props: { fill: C.accent, cornerRadius: 3 } });

text({ name: "MicVolTxt", characters: "Microphone  Off", x: 428, y: 288, parent: heroInner, props: { fontFamily: "Inter", fontSize: 12, fill: C.textMuted } });
rect({ name: "MicBarBg", x: 544, y: 293, width: 180, height: 6, parent: heroInner, props: { fill: C.divider, cornerRadius: 3 } });
text({ name: "DiskFreeTxt", characters: "Disk Free: 184.2 GB", x: 826, y: 288, parent: heroInner, props: { fontFamily: "Inter", fontSize: 12, fill: C.textSecondary } });

// Recent Captures Section
text({ name: "RecentHeading", characters: "Recent Captures", x: 28, y: 408, parent: s1Main, props: { fontFamily: "Playfair Display", fontSize: 26, fill: C.text } });
text({ name: "RecentLink", characters: "Open Library", x: 944, y: 416, parent: s1Main, props: { fontFamily: "Inter", fontSize: 13, fill: C.accent } });

const sampleClips = [
  { title: "KAGE Replay 13:24", meta: "cs2 · 58.2s · 44.1 MB", dur: "00:58" },
  { title: "KAGE Rec 12:51", meta: "Direct MP4 · 02:14 · 198 MB", dur: "02:14" },
  { title: "KAGE Replay 11:18", meta: "valorant · 30.0s · 22.8 MB", dur: "00:30" },
  { title: "KAGE Replay 10:02", meta: "cs2 · 60.0s · 46.4 MB", dur: "01:00" },
];
sampleClips.forEach((c, idx) => {
  const cx = 28 + idx * 255;
  const cardOuter = createFrame({
    name: `ClipOuter-${idx}`,
    x: cx,
    y: 454,
    width: 240,
    height: 232,
    parent: s1Main,
    props: { fill: C.elevated, cornerRadius: 14, stroke: C.divider, strokeWeight: 1 },
  });
  const cardInner = createFrame({
    name: `ClipInner-${idx}`,
    x: 4,
    y: 4,
    width: 232,
    height: 224,
    parent: cardOuter,
    props: { fill: C.surface, cornerRadius: 10 },
  });
  rect({ name: `Thumb-${idx}`, x: 8, y: 8, width: 216, height: 122, parent: cardInner, props: { fill: "#1D1916", cornerRadius: 8 } });
  rect({ name: `DurBadge-${idx}`, x: 170, y: 100, width: 46, height: 22, parent: cardInner, props: { fill: C.bg, cornerRadius: 4 } });
  text({ name: `DurTxt-${idx}`, characters: c.dur, x: 178, y: 105, parent: cardInner, props: { fontFamily: "Inter", fontSize: 11, fill: C.text } });
  text({ name: `ClipTitle-${idx}`, characters: c.title, x: 12, y: 144, parent: cardInner, props: { fontFamily: "Inter", fontSize: 13, fill: C.text } });
  text({ name: `ClipMeta-${idx}`, characters: c.meta, x: 12, y: 168, parent: cardInner, props: { fontFamily: "Inter", fontSize: 11, fill: C.textMuted } });
});

// ---------------- Screen 2: Studio Active Recording (Alt+R) ----------------
const s2 = buildShell("02-Studio-Recording", 1360, "Studio", { recording: true });
const s2Main = createFrame({ name: "MainRec", x: 220, y: 36, width: 1060, height: 720, parent: s2, props: { fill: C.bg } });
const recOuter = createFrame({
  name: "RecHeroOuter",
  x: 28,
  y: 22,
  width: 1004,
  height: 360,
  parent: s2Main,
  props: { fill: C.elevated, cornerRadius: 16, stroke: C.rec, strokeWeight: 1.5 },
});
const recInner = createFrame({
  name: "RecHeroInner",
  x: 6,
  y: 6,
  width: 992,
  height: 348,
  parent: recOuter,
  props: { fill: C.surface, cornerRadius: 12, clip: true },
});
circle({ name: "RecLiveDot", x: 32, y: 31, size: 10, parent: recInner, props: { fill: C.recBright } });
text({
  name: "RecStatusLine",
  characters: "DIRECT STREAMING TO MP4  ·  0 MB EXTRA RING RAM  ·  ALT+C REPLAY STILL ARMED",
  x: 50,
  y: 28,
  parent: recInner,
  props: { fontFamily: "Inter", fontSize: 11, fill: C.recText, letterSpacing: 1.3 },
});
text({
  name: "RecHeadline",
  characters: "Recording live  00:42",
  x: 32,
  y: 60,
  parent: recInner,
  props: { fontFamily: "Playfair Display", fontSize: 48, fill: C.text },
});
text({
  name: "RecSub",
  characters: "Streaming encoded H.264 + AAC frames straight to KAGE_Rec_2026-11-25.mp4 (124.8 MB written).",
  x: 32,
  y: 128,
  width: 720,
  parent: recInner,
  props: { fontFamily: "Inter", fontSize: 14, fill: C.textSecondary },
});
rect({ name: "BtnStopRec", x: 32, y: 186, width: 210, height: 46, parent: recInner, props: { fill: C.rec, cornerRadius: 6 } });
text({ name: "BtnStopTxt", characters: "STOP RECORDING  Alt+R", x: 56, y: 201, parent: recInner, props: { fontFamily: "Inter", fontSize: 13, fill: C.white } });
rect({ name: "BtnSaveAlso", x: 256, y: 186, width: 184, height: 46, parent: recInner, props: { fill: C.accent, cornerRadius: 23 } });
text({ name: "BtnSaveAlsoTxt", characters: "Save Replay  Alt+C", x: 284, y: 201, parent: recInner, props: { fontFamily: "Inter", fontSize: 13, fill: C.bg } });

// ---------------- Screen 3: Library & Trimmer Modal ----------------
const s3 = buildShell("03-Library-Trimmer", 2720, "Library", { recording: false });
const s3Main = createFrame({ name: "MainLib", x: 220, y: 36, width: 1060, height: 720, parent: s3, props: { fill: C.bg } });
text({ name: "LibTitle", characters: "Clip Library", x: 28, y: 24, parent: s3Main, props: { fontFamily: "Playfair Display", fontSize: 34, fill: C.text } });
rect({ name: "LibCardBg1", x: 28, y: 84, width: 320, height: 220, parent: s3Main, props: { fill: C.surface, cornerRadius: 12 } });
rect({ name: "LibCardBg2", x: 368, y: 84, width: 320, height: 220, parent: s3Main, props: { fill: C.surface, cornerRadius: 12 } });
rect({ name: "LibCardBg3", x: 708, y: 84, width: 320, height: 220, parent: s3Main, props: { fill: C.surface, cornerRadius: 12 } });

// Scrim + Modal
rect({ name: "Scrim", x: 0, y: 36, width: 1280, height: 784, parent: s3, props: { fill: "#0A0908D8" } });
const modal = createFrame({
  name: "TrimmerModal",
  x: 180,
  y: 90,
  width: 920,
  height: 640,
  parent: s3,
  props: { fill: C.surface, cornerRadius: 16, stroke: C.divider, strokeWeight: 1.5 },
});
text({ name: "TrimTitle", characters: "KAGE_Replay_2026-11-25_13-24-08.mp4", x: 28, y: 22, parent: modal, props: { fontFamily: "Inter", fontSize: 15, fill: C.text } });
text({ name: "TrimClose", characters: "Esc  Close", x: 828, y: 22, parent: modal, props: { fontFamily: "Inter", fontSize: 12, fill: C.textSecondary } });
rect({ name: "VideoCanvas", x: 28, y: 64, width: 864, height: 420, parent: modal, props: { fill: "#050504", cornerRadius: 10, stroke: C.divider, strokeWeight: 1 } });
text({ name: "VideoCenter", characters: "LOSSLESS KEYFRAME PREVIEW", x: 342, y: 264, parent: modal, props: { fontFamily: "Inter", fontSize: 12, fill: C.textMuted, letterSpacing: 1.5 } });
rect({ name: "TimelineTrack", x: 28, y: 506, width: 864, height: 10, parent: modal, props: { fill: C.divider, cornerRadius: 5 } });
rect({ name: "TimelineActive", x: 180, y: 506, width: 460, height: 10, parent: modal, props: { fill: C.accent, cornerRadius: 5 } });
rect({ name: "BtnTrimSave", x: 28, y: 556, width: 170, height: 42, parent: modal, props: { fill: C.accent, cornerRadius: 21 } });
text({ name: "BtnTrimTxt", characters: "Save Lossless Trim", x: 48, y: 570, parent: modal, props: { fontFamily: "Inter", fontSize: 13, fill: C.bg } });
rect({ name: "BtnSplit", x: 212, y: 556, width: 148, height: 42, parent: modal, props: { fill: C.elevated, cornerRadius: 8, stroke: C.borderControl, strokeWeight: 1 } });
text({ name: "BtnSplitTxt", characters: "Split at Playhead", x: 232, y: 570, parent: modal, props: { fontFamily: "Inter", fontSize: 12, fill: C.text } });

// ---------------- Screen 4: Settings & Hotkeys ----------------
const s4 = buildShell("04-Settings-Hotkeys", 4080, "Settings", { recording: false });
const s4Main = createFrame({ name: "MainSettings", x: 220, y: 36, width: 1060, height: 720, parent: s4, props: { fill: C.bg } });
text({ name: "SetTitle", characters: "Studio Settings", x: 28, y: 24, parent: s4Main, props: { fontFamily: "Playfair Display", fontSize: 34, fill: C.text } });
const hkPanel = createFrame({
  name: "HotkeysPanel",
  x: 28,
  y: 88,
  width: 488,
  height: 290,
  parent: s4Main,
  props: { fill: C.surface, cornerRadius: 14, stroke: C.divider, strokeWeight: 1 },
});
text({ name: "HkHeader", characters: "Global Shortcuts", x: 24, y: 22, parent: hkPanel, props: { fontFamily: "Inter", fontSize: 16, fill: C.text } });
[
  { label: "Save Instant Replay", key: "Alt+C", y: 74 },
  { label: "Start / Stop Recording", key: "Alt+R", y: 144 },
  { label: "Arm / Disarm Buffer", key: "Alt+Shift+C", y: 214 },
].forEach((hk, i) => {
  text({ name: `HkLbl-${i}`, characters: hk.label, x: 24, y: hk.y + 10, parent: hkPanel, props: { fontFamily: "Inter", fontSize: 13, fill: C.textSecondary } });
  rect({ name: `HkBox-${i}`, x: 300, y: hk.y, width: 164, height: 38, parent: hkPanel, props: { fill: C.elevated, cornerRadius: 8, stroke: C.borderControl, strokeWeight: 1 } });
  text({ name: `HkKey-${i}`, characters: hk.key, x: 332, y: hk.y + 11, parent: hkPanel, props: { fontFamily: "Inter", fontSize: 13, fill: C.accent } });
});

const storPanel = createFrame({
  name: "StoragePanel",
  x: 540,
  y: 88,
  width: 492,
  height: 290,
  parent: s4Main,
  props: { fill: C.surface, cornerRadius: 14, stroke: C.divider, strokeWeight: 1 },
});
text({ name: "StorHeader", characters: "Storage & Performance", x: 24, y: 22, parent: storPanel, props: { fontFamily: "Inter", fontSize: 16, fill: C.text } });
text({ name: "StorPath", characters: "Output Folder: %USERPROFILE%\\Videos\\KAGE", x: 24, y: 76, parent: storPanel, props: { fontFamily: "Inter", fontSize: 13, fill: C.textSecondary } });
text({ name: "StorGameMode", characters: "Game Mode: ON (1080p60 cap, speed-first MFT)", x: 24, y: 120, parent: storPanel, props: { fontFamily: "Inter", fontSize: 13, fill: C.textSecondary } });
text({ name: "StorPrivacy", characters: "Privacy Gate: Auto-pause when no game is focused", x: 24, y: 164, parent: storPanel, props: { fontFamily: "Inter", fontSize: 13, fill: C.textSecondary } });

const outPath = path.join("d:", "awtmin", "kage", "design", "kage_commands.json");
fs.writeFileSync(outPath, JSON.stringify(cmds, null, 2));
console.log(`Wrote ${cmds.length} FigCraft commands (lastId=${nextId - 1}) to ${outPath}`);
