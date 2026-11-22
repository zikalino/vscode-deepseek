"use strict";
(() => {
  // ../web/src/scene.ts
  function renderScene(ctx2, scene2, dpr2) {
    ctx2.setTransform(dpr2, 0, 0, dpr2, 0, 0);
    ctx2.clearRect(0, 0, scene2.size.width, scene2.size.height);
    for (const draw2 of scene2.draws) {
      if (typeof draw2 === "string") {
        if (draw2 === "PopClip") {
          ctx2.restore();
        }
        continue;
      }
      const kind = Object.keys(draw2)[0];
      if (!kind) {
        continue;
      }
      const payload = draw2[kind];
      switch (kind) {
        case "Clear":
          ctx2.fillStyle = css(payload.color);
          ctx2.fillRect(0, 0, scene2.size.width, scene2.size.height);
          break;
        case "FillRect":
          ctx2.fillStyle = css(payload.color);
          ctx2.fillRect(payload.x, payload.y, payload.width, payload.height);
          break;
        case "StrokeRect": {
          const t = payload.thickness;
          ctx2.lineWidth = t;
          ctx2.strokeStyle = css(payload.color);
          ctx2.strokeRect(
            payload.x + t / 2,
            payload.y + t / 2,
            Math.max(0, payload.width - t),
            Math.max(0, payload.height - t)
          );
          break;
        }
        case "FillRoundedRect":
          roundedPath(ctx2, payload.x, payload.y, payload.width, payload.height, payload.radius);
          ctx2.fillStyle = css(payload.color);
          ctx2.fill();
          break;
        case "StrokeRoundedRect": {
          const t = payload.thickness;
          roundedPath(
            ctx2,
            payload.x + t / 2,
            payload.y + t / 2,
            Math.max(0, payload.width - t),
            Math.max(0, payload.height - t),
            Math.max(0, payload.radius - t / 2)
          );
          ctx2.lineWidth = t;
          ctx2.strokeStyle = css(payload.color);
          ctx2.stroke();
          break;
        }
        case "FillCircle":
          ctx2.beginPath();
          ctx2.arc(payload.x, payload.y, payload.radius, 0, Math.PI * 2);
          ctx2.fillStyle = css(payload.color);
          ctx2.fill();
          break;
        case "StrokeLine":
          ctx2.beginPath();
          ctx2.moveTo(payload.x0, payload.y0);
          ctx2.lineTo(payload.x1, payload.y1);
          ctx2.lineWidth = payload.thickness;
          ctx2.lineCap = "round";
          ctx2.strokeStyle = css(payload.color);
          ctx2.stroke();
          break;
        case "FillPolygon":
        case "StrokePolygon": {
          const points = payload.points;
          if (!points || points.length < 2) {
            break;
          }
          ctx2.beginPath();
          ctx2.moveTo(points[0].x, points[0].y);
          for (let i = 1; i < points.length; i += 1) {
            ctx2.lineTo(points[i].x, points[i].y);
          }
          ctx2.closePath();
          if (kind === "FillPolygon") {
            ctx2.fillStyle = css(payload.color);
            ctx2.fill();
          } else {
            ctx2.lineWidth = payload.thickness;
            ctx2.lineJoin = "round";
            ctx2.strokeStyle = css(payload.color);
            ctx2.stroke();
          }
          break;
        }
        case "FillText":
          ctx2.save();
          ctx2.fillStyle = css(payload.color);
          ctx2.font = `${payload.size}px "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif`;
          ctx2.textAlign = "left";
          ctx2.textBaseline = "top";
          ctx2.fillText(payload.text, payload.x, payload.y);
          ctx2.restore();
          break;
        case "PushClipRect":
          ctx2.save();
          ctx2.beginPath();
          ctx2.rect(payload.x, payload.y, payload.width, payload.height);
          ctx2.clip();
          break;
        default:
          break;
      }
    }
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
  }
  function css(color) {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    return `rgba(${r}, ${g}, ${b}, ${color.a})`;
  }
  function roundedPath(ctx2, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
    ctx2.beginPath();
    ctx2.moveTo(x + r, y);
    ctx2.arcTo(x + width, y, x + width, y + height, r);
    ctx2.arcTo(x + width, y + height, x, y + height, r);
    ctx2.arcTo(x, y + height, x, y, r);
    ctx2.arcTo(x, y, x + width, y, r);
    ctx2.closePath();
  }

  // media-src/panel.ts
  var vscode = acquireVsCodeApi();
  var canvas = document.getElementById("screen");
  var context = canvas.getContext("2d");
  if (!context) {
    throw new Error("this webview has no 2D canvas context");
  }
  var ctx = context;
  var status = document.getElementById("status");
  var scene = null;
  var dpr = window.devicePixelRatio || 1;
  var logicalWidth = 800;
  var logicalHeight = 600;
  var spinHandle = 0;
  var spinFrame = 0;
  function post(message) {
    vscode.postMessage(message);
  }
  var lastThemeJson = "";
  function themeBackground() {
    if (window.advanceTheme) {
      return css(window.advanceTheme.computeTheme().background);
    }
    if (typeof getComputedStyle === "function") {
      const value = getComputedStyle(document.documentElement)
        .getPropertyValue("--vscode-editor-background")
        .trim();
      if (value.length > 0) {
        return value;
      }
    }
    return "#191a24";
  }
  function sendTheme(force) {
    if (!window.advanceTheme) {
      return;
    }
    const theme = window.advanceTheme.computeTheme();
    const json = JSON.stringify(theme);
    if (!force && json === lastThemeJson) {
      return;
    }
    lastThemeJson = json;
    post({ type: "input", event: { op: "theme", theme } });
    if (scene === null) {
      draw();
    }
  }
  function watchTheme() {
    if (typeof MutationObserver !== "function") {
      return;
    }
    const observer = new MutationObserver(() => sendTheme(true));
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "style", "data-vscode-theme-id", "data-vscode-theme-kind"]
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"]
    });
  }
  function draw() {
    if (scene) {
      renderScene(ctx, scene, dpr);
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = themeBackground();
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  function drawSpinner(spinner, frame) {
    const dots = 8;
    const phase = frame % 48 / 48;
    const head = phase * dots;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (let index = 0; index < dots; index += 1) {
      const angle = (index / dots + phase) * Math.PI * 2;
      const behind = ((head - index) % dots + dots) % dots / dots;
      const weight = 1 - behind;
      const shade = 0.18 + 0.82 * weight * weight;
      ctx.beginPath();
      ctx.arc(
        spinner.x + Math.cos(angle) * spinner.radius,
        spinner.y + Math.sin(angle) * spinner.radius,
        1.2 + 1.6 * weight,
        0,
        Math.PI * 2
      );
      const r = Math.round(45 + (140 - 45) * shade);
      const g = Math.round(45 + (200 - 45) * shade);
      const b = Math.round(60 + (255 - 60) * shade);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fill();
    }
  }
  function syncSpinner() {
    if (scene === null || scene.spinner === void 0) {
      if (spinHandle !== 0) {
        cancelAnimationFrame(spinHandle);
        spinHandle = 0;
      }
      return;
    }
    if (spinHandle !== 0) {
      return;
    }
    const tick = () => {
      if (scene === null || scene.spinner === void 0) {
        spinHandle = 0;
        return;
      }
      draw();
      drawSpinner(scene.spinner, spinFrame);
      spinFrame += 1;
      spinHandle = requestAnimationFrame(tick);
    };
    spinHandle = requestAnimationFrame(tick);
  }
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    logicalWidth = Math.max(1, Math.floor(rect.width));
    logicalHeight = Math.max(1, Math.floor(rect.height));
    canvas.width = Math.max(1, Math.floor(logicalWidth * dpr));
    canvas.height = Math.max(1, Math.floor(logicalHeight * dpr));
    post({ type: "resize", width: logicalWidth, height: logicalHeight });
    draw();
  }
  function position(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width) * logicalWidth,
      y: (event.clientY - rect.top) / Math.max(1, rect.height) * logicalHeight
    };
  }
  canvas.addEventListener("pointerdown", () => canvas.focus());
  canvas.addEventListener("click", (event) => {
    const { x, y } = position(event);
    post({ type: "input", event: { op: "click", x, y } });
  });
  var lastPointer = { x: -100, y: -100 };
  canvas.addEventListener("pointermove", (event) => {
    const { x, y } = position(event);
    if (Math.abs(x - lastPointer.x) < 2 && Math.abs(y - lastPointer.y) < 2) {
      return;
    }
    lastPointer = { x, y };
    post({ type: "input", event: { op: "mouseMove", x, y } });
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.key === "Backspace") {
      post({ type: "input", event: { op: "backspace" } });
      event.preventDefault();
    } else if (event.key === "Enter") {
      post({ type: "input", event: { op: "enter" } });
      event.preventDefault();
    } else if (event.key === "Tab") {
      post({ type: "input", event: { op: "tab" } });
      event.preventDefault();
    } else if (event.key === "Escape") {
      post({ type: "input", event: { op: "abort" } });
      event.preventDefault();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") {
      post({
        type: "input",
        event: {
          op: "move",
          key: event.key.replace("Arrow", "").toLowerCase(),
          shift: event.shiftKey
        }
      });
      event.preventDefault();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      post({ type: "input", event: { op: "selectAll" } });
      event.preventDefault();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      post({ type: "input", event: { op: "char", ch: event.key } });
      event.preventDefault();
    }
  });
  canvas.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      post({ type: "input", event: { op: "scroll", dy: -event.deltaY } });
    },
    { passive: false }
  );
  new ResizeObserver(() => resize()).observe(canvas);
  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "scene":
        if (typeof message.scene === "string") {
          scene = JSON.parse(message.scene);
          draw();
          syncSpinner();
        }
        return;
      case "status":
        status.textContent = message.message ?? "";
        return;
      case "clear":
        // A new engine is replacing this conversation; do not leave the old frame under the new
        // one while it starts (or if it fails to).
        scene = null;
        syncSpinner();
        resize();
        return;
      case "refreshTheme":
        sendTheme(true);
        return;
      default:
        return;
    }
  });
  watchTheme();
  sendTheme(true);
  // Some hosts apply the theme data just after the content scripts run; re-check once the first
  // paint settles so a late theme does not leave the canvas on the fallback palette.
  setTimeout(() => sendTheme(false), 0);
  resize();
  canvas.focus();
  post({ type: "ready" });
})();
//! A canvas painter for the `Scene` the harness emits.
//!
//! The display list is the same one the native Direct2D painter consumes, so the web surface uses
//! the component's geometry, not a parallel UI. Rust's default serde enum representation is
//! externally tagged: struct variants arrive as `{ "FillRect": { … } }` and the unit `PopClip`
//! arrives as the bare string `"PopClip"`.
