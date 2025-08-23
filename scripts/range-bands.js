// Range Bands Ruler — v1.2.0
// One file to support Foundry v10–v12 and v13+
// Requires libWrapper. Shows configurable range bands on the ruler.

const MODULE_ID = "range-bands-ruler";

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
    hint: "JSON array of {label,min,max} in scene distance units.",
    scope: "world",
    config: true,
    default: JSON.stringify(DEFAULT_BANDS, null, 2),
    type: String
  });
  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Parentheses",
    hint: "Append the numeric distance after the band label.",
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });
  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Show Bands When Snapped",
    hint: "If enabled, only show bands when the ruler is snapped to grid.",
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
});

function getBands() {
  try {
    const arr = JSON.parse(game.settings.get(MODULE_ID, "bands"));
    if (!Array.isArray(arr)) throw new Error("Bands must be an array");
    return arr.map(b => ({
      label: String(b.label ?? "").trim(),
      min: Number(b.min ?? 0),
      max: Number(b.max ?? 0)
    })).filter(b => b.label && isFinite(b.min) && isFinite(b.max) && b.max >= b.min);
  } catch (e) {
    console.warn(`${MODULE_ID} | Invalid bands config; using defaults.`, e);
    return DEFAULT_BANDS;
  }
}

function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) if (d >= b.min && d <= b.max) return b.label;
  return bands.length ? bands[bands.length - 1].label : String(d);
}
function makeBandLabel(distance, baseText) {
  const showNum = game.settings.get(MODULE_ID, "showNumericFallback");
  const label = bandForDistance(distance);
  return (showNum && baseText) ? `${label} (${baseText})` : label;
}
function shouldBand(ruler) {
  const onlySnapped = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
  if (!onlySnapped) return true;
  return Boolean(ruler?.snapped ?? true);
}

// Extract a numeric distance from common call-sites / contexts
function extractDistance(ctx, args, base) {
  if (typeof args?.[0] === "number" && isFinite(args[0])) return args[0];  // _getSegmentLabel(distance,...)
  const seg = ctx?.segments?.at?.(-1);
  if (seg?.distance) return seg.distance;
  if (typeof ctx?.totalDistance === "number") return ctx.totalDistance;
  if (typeof base === "number") return base;
  if (typeof base === "string") {
    const m = base.match(/(\d+(?:\.\d+)?)/);
    if (m) return Number(m[1]);
  }
  return 0;
}

Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler: libWrapper is not active. Labels may not change.");
    return;
  }
  const lw = globalThis.libWrapper;

  // Detect major version: v13+ exposes game.release?.generation
  const major = Number(getProperty(game, "release.generation")) || (function () {
    // Fallback: parse game.version "12.x.x"
    const v = String(game.version ?? "").match(/^(\d+)/);
    return v ? Number(v[1]) : 12;
  })();

  // --- v10–v12 primary hook: _getSegmentLabel(distance, opts) ---
  if (getProperty(globalThis, "Ruler.prototype._getSegmentLabel")) {
    lw.register(MODULE_ID, "Ruler.prototype._getSegmentLabel", function (wrapped, ...args) {
      const base = wrapped(...args); // "60 ft"
      if (!shouldBand(this)) return base;
      const dist = extractDistance(this, args, base);
      return makeBandLabel(dist, base);
    }, "WRAPPER");
  }

  // Fallbacks seen in some v10/11 builds
  if (getProperty(globalThis, "Ruler.prototype._getRulerText")) {
    lw.register(MODULE_ID, "Ruler.prototype._getRulerText", function (wrapped, ...args) {
      const base = wrapped(...args);
      if (!shouldBand(this)) return base;
      const dist = extractDistance(this, args, base);
      return makeBandLabel(dist, base);
    }, "WRAPPER");
  }
  if (getProperty(globalThis, "Ruler.prototype._getMeasurementText")) {
    lw.register(MODULE_ID, "Ruler.prototype._getMeasurementText", function (wrapped, ...args) {
      const base = wrapped(...args);
      if (!shouldBand(this)) return base;
      const dist = extractDistance(this, args, base);
      return makeBandLabel(dist, base);
    }, "WRAPPER");
  }

  // --- v13+ formatter: _formatDistance(distance, opts) ---
  if (major >= 13 && getProperty(globalThis, "Ruler.prototype._formatDistance")) {
    lw.register(MODULE_ID, "Ruler.prototype._formatDistance", function (wrapped, distance, ...rest) {
      const base = wrapped(distance, ...rest); // "60 ft"
      if (!shouldBand(this)) return base;
      return makeBandLabel(distance, base);
    }, "WRAPPER");
  }

  // Ultimate fallback across versions: post-process tooltips after they are built
  if (getProperty(globalThis, "Ruler.prototype._refreshTooltips")) {
    lw.register(MODULE_ID, "Ruler.prototype._refreshTooltips", function (wrapped, ...args) {
      const out = wrapped(...args);
      try {
        if (!shouldBand(this)) return out;
        const labels = this?.labels ?? this?.tooltips ?? [];
        for (const lab of labels) {
          if (!lab || typeof lab.text !== "string") continue;
          const d = (lab?.segment?.distance) ?? extractDistance(this, undefined, lab.text);
          lab.text = makeBandLabel(d, lab.text);
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | tooltip post-process failed`, e);
      }
      return out;
    }, "WRAPPER");
  }

  console.log(`${MODULE_ID} | Range band wrappers registered for v${major}.`);
});
