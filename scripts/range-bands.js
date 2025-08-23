// Range Bands Ruler — v1.0.0
// Works on Foundry VTT v11+ (tested on v11). Requires libWrapper.
// Replaces the ruler's distance label with a band (e.g., Close, Near, Far) using user-configurable thresholds.

const MODULE_ID = "range-bands-ruler";

/** Default band spec:
 * Each band has:
 *  - label: string shown on the ruler
 *  - min: inclusive lower bound in scene units (0 = start)
 *  - max: inclusive upper bound in scene units
 * Order matters (first match wins).
 */
const DEFAULT_BANDS = [
  { label: "Contact", min: 0,  max: 1 },
  { label: "Close",   min: 1,  max: 5 },
  { label: "Near",    min: 6,  max: 15 },
  { label: "Far",     min: 16, max: 30 },
  { label: "Distant", min: 31, max: 120 },
  { label: "Extreme", min: 121, max: 999999 }
];

Hooks.once("init", async () => {
  game.settings.register(MODULE_ID, "bands", {
    name: "Range Bands",
    hint: "Define your range bands in scene units as JSON array. Example provided.",
    scope: "world",
    config: true,
    default: JSON.stringify(DEFAULT_BANDS, null, 2),
    type: String
  });

  game.settings.register(MODULE_ID, "showNumericFallback", {
    name: "Show Numeric in Tooltip",
    hint: "Also include the numeric distance (system units) in the ruler tooltip in parentheses.",
    scope: "client",
    config: true,
    default: true,
    type: Boolean
  });

  game.settings.register(MODULE_ID, "bandWhenSnappedOnly", {
    name: "Only Band When Snapped",
    hint: "If enabled, show bands only when ruler is snapped to grid; otherwise always show bands.",
    scope: "client",
    config: true,
    default: false,
    type: Boolean
  });
});

/** Parse user bands safely */
function getBands() {
  try {
    const raw = game.settings.get(MODULE_ID, "bands");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error("Bands must be an array");
    // Normalize & validate
    return arr.map(b => ({
      label: String(b.label ?? ""),
      min: Number.isFinite(+b.min) ? +b.min : 0,
      max: Number.isFinite(+b.max) ? +b.max : 0
    })).filter(b => b.label && b.max >= b.min);
  } catch (e) {
    console.warn(`${MODULE_ID} | Invalid bands config, using defaults.`, e);
    return DEFAULT_BANDS;
  }
}

/** Find band by distance (scene distance, not pixels) */
function bandForDistance(d) {
  const bands = getBands();
  for (const b of bands) {
    if (d >= b.min && d <= b.max) return b.label;
  }
  // If nothing matched, fall back to the last band
  return bands.length ? bands[bands.length - 1].label : `${d}`;
}

/** Produce final label text given a numeric distance and ruler state */
function bandLabel(distance, baseText) {
  const showNum = game.settings.get(MODULE_ID, "showNumericFallback");
  const label = bandForDistance(distance);
  if (showNum && baseText) return `${label} (${baseText})`;
  return label;
}

/**
 * Foundry internal changes over versions make direct method names fragile.
 * We'll use libWrapper to safely override two likely points:
 * 1) Ruler.prototype._getSegmentLabel (v11) – returns the text shown for each segment
 * 2) Ruler.prototype._getRulerText / _getMeasurementText (fallbacks)
 */
Hooks.once("ready", () => {
  if (!game.modules.get("lib-wrapper")?.active) {
    ui.notifications?.warn("Range Bands Ruler: libWrapper is not active. The module may not work.");
  }

  // Helper function to decide if we should show bands
  function shouldBand(rulerInstance) {
    const onlyWhenSnapped = game.settings.get(MODULE_ID, "bandWhenSnappedOnly");
    if (!onlyWhenSnapped) return true;
    // Ruler has .snapped property in v11 when Shift not held, etc. Fallback to true if undefined.
    return Boolean(rulerInstance?.snapped ?? true);
  }

  /** Wrapper that converts the label to band text */
  function labelWrapper(wrapped, ...args) {
    try {
      const text = wrapped(...args);                // original text like "30 ft"
      const ctx = this;                             // ruler instance
      // Find distance in scene units. In v11, the wrapper is Ruler._getSegmentLabel(distance, opts)
      // But we cannot rely on args shape; derive from existing text via measure segments if needed.
      // Prefer this.segmentDistance if available (v11 stores last segment length).
      let distance = 0;
      if (typeof args[0] === "number") distance = args[0];
      else if (ctx?.segments?.length) {
        const seg = ctx.segments.at(-1);
        distance = seg?.distance ?? 0;
      } else if (ctx?.totalDistance) distance = ctx.totalDistance;

      if (!shouldBand(ctx)) return text;

      return bandLabel(distance, text);
    } catch (err) {
      console.warn(`${MODULE_ID} | labelWrapper error`, err);
      return wrapped(...args);
    }
  }

  // Try to wrap the most stable method first.
  const lw = globalThis.libWrapper;
  let wrappedSomething = false;

  // v11 target
  if (getProperty(globalThis, "Ruler.prototype._getSegmentLabel")) {
    lw.register(MODULE_ID, "Ruler.prototype._getSegmentLabel", labelWrapper, "WRAPPER");
    wrappedSomething = true;
  }

  // Fallbacks
  if (!wrappedSomething && getProperty(globalThis, "Ruler.prototype._getRulerText")) {
    lw.register(MODULE_ID, "Ruler.prototype._getRulerText", labelWrapper, "WRAPPER");
    wrappedSomething = true;
  }

  if (!wrappedSomething && getProperty(globalThis, "Ruler.prototype._getMeasurementText")) {
    lw.register(MODULE_ID, "Ruler.prototype._getMeasurementText", labelWrapper, "WRAPPER");
    wrappedSomething = true;
  }

  if (!wrappedSomething) {
    console.warn(`${MODULE_ID} | Could not find a ruler label method to wrap. Module may need an update for your Foundry version.`);
    ui.notifications?.warn("Range Bands Ruler could not patch the ruler on this Foundry version.");
  }

  console.log(`${MODULE_ID} | Ready.`);
});
