// The VS Code theme, in the shape Advance's harness reads (`Input::Theme`).
//
// The webview is the only place that can see the real colours: VS Code exposes them as `--vscode-*`
// CSS variables. This mirrors `advance-host-win`'s import (`vscode_themes::theme_from_layers`): the
// background picks the dark or light base, translucency is composited over it (the painter cannot
// blend), and the accent and status colours are nudged until they can be read on a surface.
//
// `computeTheme` returns a *complete* `advance_gfx::theme::Theme`: its serde has no defaults, so a
// theme missing a field is rejected outright rather than filled in.

(function () {
  "use strict";

  // Advance's own presets, used for any colour the VS Code theme does not define.
  var FALLBACKS = {
    dark: {
      background: "#191925",
      surface: "#1e1e28",
      surface_raised: "#252532",
      border: "#45455a",
      text: "#e8ecf6",
      muted: "#7a7d8c",
      accent: "#7aa2f7",
      on_accent: "#ffffff",
      ok: "#64bf85",
      warn: "#e3c641",
      error: "#ed8585",
      selection: "#2e3857",
      code: "#21212d",
    },
    light: {
      background: "#f6f6f9",
      surface: "#ffffff",
      surface_raised: "#eeeef3",
      border: "#cbcdd6",
      text: "#20232d",
      muted: "#6e7484",
      accent: "#2660c8",
      on_accent: "#ffffff",
      ok: "#1c8046",
      warn: "#9e6c08",
      error: "#b83030",
      selection: "#d6e1f8",
      code: "#eceef5",
    },
    "high-contrast": {
      background: "#000000",
      surface: "#000000",
      surface_raised: "#141414",
      border: "#ffffff",
      text: "#ffffff",
      muted: "#c6c8d0",
      accent: "#569cff",
      on_accent: "#000000",
      ok: "#4ce782",
      warn: "#ffd633",
      error: "#ff7474",
      selection: "#00489c",
      code: "#181818",
    },
  };

  // Advance's default metrics (gfx `Theme::dark`); only colours follow the VS Code theme.
  var METRICS = {
    font: 13,
    small: 12,
    headings: [22, 19, 16, 14.5, 13.5, 13],
    line_h: 19,
    row_h: 22,
    pad: 12,
    radius: 6,
  };

  var MIN_TEXT_CONTRAST = 3;

  function parseColor(text) {
    if (typeof text !== "string") {
      return null;
    }
    var value = text.trim().toLowerCase();
    if (value.length === 0) {
      return null;
    }
    if (value.charAt(0) === "#") {
      var hex = value.slice(1);
      if (!/^[0-9a-f]+$/.test(hex)) {
        return null;
      }
      var expand = function (part) {
        return parseInt(part + part, 16) / 255;
      };
      if (hex.length === 3 || hex.length === 4) {
        return {
          r: expand(hex.charAt(0)),
          g: expand(hex.charAt(1)),
          b: expand(hex.charAt(2)),
          a: hex.length === 4 ? expand(hex.charAt(3)) : 1,
        };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16) / 255,
          g: parseInt(hex.slice(2, 4), 16) / 255,
          b: parseInt(hex.slice(4, 6), 16) / 255,
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        };
      }
      return null;
    }
    var match = value.match(/^rgba?\(([^)]+)\)$/);
    if (!match) {
      return null;
    }
    var parts = match[1].split(/[\s,\/]+/).filter(function (part) {
      return part.length > 0;
    });
    if (parts.length < 3) {
      return null;
    }
    var channel = function (part) {
      return part.charAt(part.length - 1) === "%"
        ? parseFloat(part) / 100
        : parseFloat(part) / 255;
    };
    var alpha = 1;
    if (parts.length > 3) {
      alpha =
        parts[3].charAt(parts[3].length - 1) === "%"
          ? parseFloat(parts[3]) / 100
          : parseFloat(parts[3]);
    }
    return {
      r: channel(parts[0]),
      g: channel(parts[1]),
      b: channel(parts[2]),
      a: isNaN(alpha) ? 1 : alpha,
    };
  }

  // Lay a translucent colour over an opaque one: the canvas painter blends, but the harness's
  // display list is also consumed by hosts that do not, and the desktop import composes up front.
  function composite(foreground, background) {
    var alpha = foreground.a;
    return {
      r: foreground.r * alpha + background.r * (1 - alpha),
      g: foreground.g * alpha + background.g * (1 - alpha),
      b: foreground.b * alpha + background.b * (1 - alpha),
      a: 1,
    };
  }

  function linear(channel) {
    return channel <= 0.03928
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  }

  function luminance(color) {
    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
  }

  function contrast(one, other) {
    var a = luminance(one);
    var b = luminance(other);
    var lighter = Math.max(a, b);
    var darker = Math.min(a, b);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function mix(from, to, fraction) {
    return {
      r: from.r + (to.r - from.r) * fraction,
      g: from.g + (to.g - from.g) * fraction,
      b: from.b + (to.b - from.b) * fraction,
      a: 1,
    };
  }

  // A theme's accent and status colours are chosen against its own background; here they are drawn
  // on a pane as text, so a colour that would vanish is moved toward black or white until legible.
  function readableOn(color, on) {
    if (contrast(color, on) >= MIN_TEXT_CONTRAST) {
      return color;
    }
    var toward = luminance(on) > 0.18 ? { r: 0, g: 0, b: 0, a: 1 } : { r: 1, g: 1, b: 1, a: 1 };
    var enough = 1;
    var notEnough = 0;
    for (var step = 0; step < 12; step += 1) {
      var fraction = (notEnough + enough) / 2;
      if (contrast(mix(color, toward, fraction), on) >= MIN_TEXT_CONTRAST) {
        enough = fraction;
      } else {
        notEnough = fraction;
      }
    }
    return mix(color, toward, enough);
  }

  // VS Code exposes a theme colour id (`editor.background`) as the custom property
  // `--vscode-editor-background`: every `.` becomes a `-`.
  function defaultRead(name) {
    if (typeof getComputedStyle !== "function" || typeof document === "undefined") {
      return "";
    }
    var key = "--vscode-" + name.replace(/\./g, "-");
    var body = document.body
      ? getComputedStyle(document.body).getPropertyValue(key).trim()
      : "";
    return body || getComputedStyle(document.documentElement).getPropertyValue(key).trim();
  }

  // The theme class is on `body`, but `body` can be the inner frame's while the attributes were
  // applied to the outer document — check both, and the `data-vscode-theme-kind` attribute VS Code
  // sets alongside them. Returns null when the webview has not been told a kind (older hosts).
  function themeKind() {
    if (typeof document === "undefined") {
      return null;
    }
    var body = document.body;
    var root = document.documentElement;
    var declared = "";
    try {
      declared =
        (body && body.dataset && body.dataset.vscodeThemeKind) ||
        (root && root.dataset && root.dataset.vscodeThemeKind) ||
        "";
    } catch (error) {
      declared = "";
    }
    var has = function (name) {
      if (declared === name) {
        return true;
      }
      return (
        (body && body.classList && body.classList.contains(name)) ||
        (root && root.classList && root.classList.contains(name))
      );
    };
    // High-contrast light also carries `vscode-high-contrast`, so it must be checked first.
    if (has("vscode-high-contrast-light")) {
      return "light";
    }
    if (has("vscode-high-contrast")) {
      return "high-contrast";
    }
    if (has("vscode-light")) {
      return "light";
    }
    if (has("vscode-dark")) {
      return "dark";
    }
    return null;
  }

  function first(read, names) {
    for (var index = 0; index < names.length; index += 1) {
      var color = parseColor(read(names[index]));
      if (color !== null) {
        return color;
      }
    }
    return null;
  }

  /**
   * Build the harness theme from the webview's CSS variables.
   *
   * `options.readVar(name)` and `options.kind` exist so this can be exercised without a webview;
   * in the panel both default to the live DOM.
   */
  function computeTheme(options) {
    var read = (options && options.readVar) || defaultRead;
    var declaredKind = (options && options.kind) || themeKind();
    var background =
      first(read, ["editor.background", "sideBar.background", "panel.background"]) || null;
    // The class can be absent in some webview hosts, but the background is always painted. When the
    // two disagree, the colour wins: a light background means the light fallback palette.
    var kind;
    if (declaredKind === "high-contrast") {
      kind = "high-contrast";
    } else if (background !== null) {
      kind = luminance(background) > 0.5 ? "light" : "dark";
    } else {
      kind = declaredKind || "dark";
    }
    var fallback = FALLBACKS[kind] || FALLBACKS.dark;
    if (background === null) {
      background = parseColor(fallback.background);
    }

    var over = function (names) {
      var color = first(read, names);
      return color === null ? null : composite(color, background);
    };
    var pick = function (names, key) {
      return over(names) || parseColor(fallback[key]);
    };

    var surface = pick(
      ["sideBar.background", "panel.background", "editorGroupHeader.tabsBackground"],
      "surface",
    );

    return {
      background: background,
      surface: surface,
      surface_raised: pick(
        ["editorWidget.background", "input.background", "dropdown.background", "tab.activeBackground"],
        "surface_raised",
      ),
      border: pick(
        [
          "panel.border",
          "editorGroup.border",
          "sideBar.border",
          "widget.border",
          "tab.border",
          "window.activeBorder",
        ],
        "border",
      ),
      text: pick(["editor.foreground", "foreground", "sideBar.foreground"], "text"),
      muted: pick(
        [
          "descriptionForeground",
          "editorLineNumber.foreground",
          "input.placeholderForeground",
          "tab.inactiveForeground",
        ],
        "muted",
      ),
      accent: readableOn(
        pick(
          [
            "button.background",
            "activityBarBadge.background",
            "progressBar.background",
            "textLink.foreground",
            "focusBorder",
          ],
          "accent",
        ),
        surface,
      ),
      on_accent: pick(["button.foreground"], "on_accent"),
      ok: readableOn(
        pick(["editorGutter.addedBackground", "terminal.ansiGreen", "charts.green"], "ok"),
        surface,
      ),
      warn: readableOn(
        pick(["editorWarning.foreground", "terminal.ansiYellow", "charts.yellow"], "warn"),
        surface,
      ),
      error: readableOn(
        pick(["errorForeground", "editorError.foreground", "terminal.ansiRed", "charts.red"], "error"),
        surface,
      ),
      selection: pick(
        [
          "list.activeSelectionBackground",
          "list.focusBackground",
          "editor.selectionBackground",
          "editor.findMatchBackground",
        ],
        "selection",
      ),
      code: pick(["textCodeBlock.background", "editorWidget.background"], "code"),
      font: METRICS.font,
      small: METRICS.small,
      headings: METRICS.headings.slice(),
      line_h: METRICS.line_h,
      row_h: METRICS.row_h,
      pad: METRICS.pad,
      radius: METRICS.radius,
    };
  }

  globalThis.advanceTheme = { computeTheme: computeTheme };
})();
