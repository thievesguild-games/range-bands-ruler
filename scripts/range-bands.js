// Range Bands Ruler — v1.2.5
// v10–v12 (and v13+) via post-process on Ruler.measure fallback.
// Requires libWrapper.

const MODULE_ID = "range-bands-ruler";
const getProp = (o, p) => foundry.utils.getProperty(o, p);

const DEFAULT_BANDS = [
  { label: "Contact", min: 0,  max: 1 },
  { label: "Close",   min: 1,  max: 5 },
  { label: "Near",    min: 6,  max: 15 },
  { label: "Far",     min: 16, max: 30 },
  { label: "Distant", min: 31, max: 120 },
  { label: "Extreme", min: 121, max: 999999 }
];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "bands", {
    name: "Range Bands",
    scope: "world",
    config: true,
    default: JSON.stringify(DEFAULT_BANDS, null, 2),
    type: String
  });
  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Parentheses",
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
});

function getBands() {
  try { const arr = JSON.parse(game.settings.get(MODULE_ID, "bands")); return Array.isArray(arr) ? arr : DEFAULT_BANDS; }
  catch { return DEFAULT_BANDS; }
}
function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) if (d >= b.min && d <= b.max) return b.label;
  return bands[bands.length - 1]?.label ?? String(d);
}
function makeBandLabel(d, base) {
  const show = game.settings.get(MODULE_ID, "showNumericFallback");
  const lbl = bandForDistance(d);
  return show && base ? `${lbl} (${base})` : lbl;
}
function shouldBand(ruler) {
  const only = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  return !only || Boolean(ruler?.snapped ?? true);
}
function parseNumberFromText(t) {
  const m = typeof t === "string" ? t.match(/(\d+(?:\.\d+)?)/) : null;
  return m ? Number(m[1]) : 0;
}

Hooks.once("ready", () => {
  console.log(`${MODULE_ID} | Foundry version:`, game.version, "release gen:", getProp(game, "release.generation"));

  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler requires libWrapper.");
    return;
  }

  const RulerClass = getProp(CONFIG, "Canvas.rulerClass") ?? globalThis.Ruler;
  const className = RulerClass?.name || "Ruler";
  console.log(`${MODULE_ID} | Active ruler class: ${className}`);

  // Always available in v12: Ruler.prototype.measure
  const pathMeasure = `${className}.prototype.measure`;
  const hasMeasure = !!getProp(globalThis, pathMeasure);
  console.log(`${MODULE_ID} | ${hasMeasure ? "Hooking" : "Missing"} ${pathMeasure}`);

  if (hasMeasure) {
    libWrapper.register(MODULE_ID, pathMeasure, function (wrapped, ...args) {
      // Let Foundry build segments + labels first
      const out = wrapped(...args);

      try {
        if (!shouldBand(this)) return out;

        // Typical v12: labels align 1:1 with segments
        const labels = this?.labels ?? [];
        const segs = this?.segments ?? [];

        for (let i = 0; i < labels.length; i++) {
          const lab = labels[i];
          if (!lab || typeof lab.text !== "string") continue;

          // Prefer segment distance, fallback to parsing label text
          const d = (segs[i]?.distance ?? parseNumberFromText(lab.text)) || 0;
          lab.text = makeBandLabel(d, lab.text);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | measure post-process failed`, e);
      }

      return out;
    }, "WRAPPER");
  } else {
    ui.notifications?.warn("Range Bands Ruler: Could not find Ruler.measure to hook; module inactive.");
  }
});
