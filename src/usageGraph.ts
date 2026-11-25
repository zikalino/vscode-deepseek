// The token-usage graph: one thin bar per DeepSeek API call, drawn live.
//
// The API is stateless, so a bar is one request's `usage` object — output on top, uncached input in
// the middle, cache-hit input at the bottom, and the bar's height is the total. Both request paths
// feed the same recorder (see `usage.ts`), so Copilot turns and Zero turns appear side by side.

import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { getUsageJournal, getUsageRecorder, USAGE_SAMPLE_LIMIT } from "./usage";

const VIEW_TYPE = "deepseek.usageGraph";
const TITLE = "DeepSeek: Token Usage";
/** How often the panel checks the shared journal for samples written by other windows. */
const POLL_INTERVAL_MS = 500;

/** Dollars per million tokens, read from the shared pricing settings. */
interface Pricing {
  inputPerMillion: number;
  cachedPerMillion: number;
  outputPerMillion: number;
}

/** The Zero panel's pricing settings also drive the graph, so both show the same money. */
function readPricing(): Pricing {
  const advance = vscode.workspace.getConfiguration("deepseek.advance");
  return {
    inputPerMillion: advance.get<number>("pricing.inputPerMillion", 0) || 0,
    cachedPerMillion: advance.get<number>("pricing.cachedPerMillion", 0) || 0,
    outputPerMillion: advance.get<number>("pricing.outputPerMillion", 0) || 0,
  };
}

let currentPanel: vscode.WebviewPanel | undefined;
let unsubscribe: (() => void) | undefined;

export function registerUsageGraphCommand(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.showUsageGraph", () => openUsageGraph()),
    {
      dispose: () => {
        unsubscribe?.();
        unsubscribe = undefined;
        currentPanel?.dispose();
        currentPanel = undefined;
      },
    },
  );
}

function openUsageGraph(): void {
  if (currentPanel !== undefined) {
    currentPanel.reveal(undefined, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, TITLE, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  currentPanel = panel;

  // The active extension host is not necessarily the one serving Copilot (VS Code's BYOK bridge
  // picks a window), so samples are read from the shared journal instead of this host's buffer.
  const journal = getUsageJournal();
  let offset = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const post = (message: unknown): void => {
    void panel.webview.postMessage(message);
  };

  const sendAll = (): void => {
    if (journal === undefined) {
      post({ type: "init", samples: getUsageRecorder().snapshot(), pricing: readPricing() });
      return;
    }
    const slice = journal.read(0);
    offset = slice.offset;
    post({ type: "init", samples: slice.samples, pricing: readPricing() });
  };

  const startPolling = (): void => {
    if (journal === undefined || timer !== undefined) {
      return;
    }
    timer = setInterval(() => {
      const slice = journal.read(offset);
      offset = slice.offset;
      if (slice.reset) {
        // Another window cleared the history; replace rather than append.
        post({ type: "init", samples: slice.samples });
        return;
      }
      if (slice.samples.length > 0) {
        post({ type: "append", samples: slice.samples });
      }
    }, POLL_INTERVAL_MS);
  };

  const messages = panel.webview.onDidReceiveMessage((message: unknown) => {
    const command = message as { type?: string };
    if (command?.type === "ready") {
      // A reloaded webview starts empty; replay what the journal holds.
      offset = 0;
      sendAll();
      startPolling();
      return;
    }
    if (command?.type === "clear") {
      getUsageRecorder().clear();
      offset = 0;
      post({ type: "init", samples: [], pricing: readPricing() });
    }
  });

  // Prices are edited in settings; push them live instead of waiting for a reopen.
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("deepseek.advance.pricing")) {
      post({ type: "pricing", pricing: readPricing() });
    }
  });

  // Fallback for the rare case the journal could not be created: keep the old live local feed.
  if (journal === undefined) {
    unsubscribe = getUsageRecorder().onDidRecord((samples) => {
      post({ type: "append", samples });
    });
  }

  panel.onDidDispose(() => {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    messages.dispose();
    configuration.dispose();
    unsubscribe?.();
    unsubscribe = undefined;
    currentPanel = undefined;
  });

  panel.webview.html = getHtml(panel.webview);
}

function getHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${TITLE}</title>
  <style>
    :root { color-scheme: light dark; }
    html, body { height: 100%; }
    body {
      margin: 0;
      padding: 0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 16px;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background);
    }
    .titles { display: flex; flex-direction: column; line-height: 1.25; }
    .title { font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
    .subtitle { font-size: 10px; opacity: 0.65; }
    .legend { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; }
    .legend span { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
    .swatch { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
    .stats {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
      opacity: 0.85;
      white-space: nowrap;
    }
    button {
      appearance: none;
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      padding: 3px 10px;
      border-radius: 3px;
      cursor: pointer;
      font-family: inherit;
      font-size: 11px;
    }
    button:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    #plot { position: relative; flex: 1 1 auto; min-height: 0; display: flex; }
    #scroll { position: relative; flex: 1 1 auto; overflow: hidden; }
    canvas { display: block; }
    /* A HUD over the empty top-left corner: totals for everything recorded, not just the visible window. */
    #donutCard {
      position: absolute;
      left: 64px;
      top: 8px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 10px 6px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background);
      opacity: 0.95;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
    }
    #donutCard[hidden] { display: none; }
    #donut { width: 76px; height: 76px; }
    #donutLegend { display: flex; flex-direction: column; gap: 1px; font-size: 10px; line-height: 1.35; }
    #donutLegend .row { display: grid; grid-template-columns: 8px 34px 30px 44px; align-items: center; gap: 6px; }
    #donutLegend .row.total,
    #donutLegend .row.cost {
      grid-template-columns: 1fr auto;
      margin-top: 2px;
      padding-top: 2px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    #donutLegend .name { opacity: 0.75; }
    #donutLegend .pct,
    #donutLegend .val { text-align: right; }
    #donutLegend .val { opacity: 0.9; }
    #donutLegend .swatch { width: 8px; height: 8px; border-radius: 2px; }
    #empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      line-height: 1.6;
      opacity: 0.6;
      pointer-events: none;
    }
    #empty[hidden] { display: none; }
    #tooltip {
      position: fixed;
      z-index: 10;
      pointer-events: none;
      padding: 6px 8px;
      border-radius: 4px;
      border: 1px solid var(--vscode-editorHoverWidget-border);
      background: var(--vscode-editorHoverWidget-background);
      color: var(--vscode-editorHoverWidget-foreground);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
    }
    #tooltip[hidden] { display: none; }
  </style>
</head>
<body>
  <header>
    <div class="titles">
      <div class="title">Token usage</div>
      <div class="subtitle" id="subtitle">one bar = one API call</div>
    </div>
    <div class="legend" aria-hidden="true">
      <span><i class="swatch" style="background: var(--vscode-charts-purple, #bc8cff)"></i>output</span>
      <span><i class="swatch" style="background: var(--vscode-charts-blue, #58a6ff)"></i>input (miss)</span>
      <span><i class="swatch" style="background: var(--vscode-charts-green, #3fb950)"></i>cache hit</span>
    </div>
    <div class="stats" id="stats">No API calls yet</div>
    <button id="clear" type="button" title="Clear the recorded calls">Clear</button>
  </header>
  <div id="plot">
    <div id="scroll">
      <canvas id="chart" role="img" aria-label="Stacked token usage for each DeepSeek API call"></canvas>
    </div>
    <div id="donutCard" hidden>
      <canvas id="donut" width="76" height="76" aria-hidden="true"></canvas>
      <div id="donutLegend">
        <div class="row"><i class="swatch" style="background: var(--vscode-charts-green, #3fb950)"></i><span class="name">hit</span><span class="pct" id="pctHit">0%</span><span class="val" id="valHit">0</span></div>
        <div class="row"><i class="swatch" style="background: var(--vscode-charts-blue, #58a6ff)"></i><span class="name">miss</span><span class="pct" id="pctMiss">0%</span><span class="val" id="valMiss">0</span></div>
        <div class="row"><i class="swatch" style="background: var(--vscode-charts-purple, #bc8cff)"></i><span class="name">out</span><span class="pct" id="pctOut">0%</span><span class="val" id="valOut">0</span></div>
        <div class="row total"><span class="name">total</span><span class="val" id="valTotal">0</span></div>
        <div class="row cost"><span class="name">cost</span><span class="val" id="valCost">—</span></div>
      </div>
    </div>
    <div id="empty">No API calls recorded yet.<br />Each DeepSeek request adds one bar: output on top, input miss, then cache hit.</div>
  </div>
  <div id="tooltip" hidden></div>
  <script nonce="${nonce}">
    (function () {
      var MAX_SAMPLES = ${USAGE_SAMPLE_LIMIT};
      var STEP_MIN = 3;
      var STEP_MAX = 10;
      var GAP = 1;
      var PAD_LEFT = 56;
      var PAD_RIGHT = 14;
      var PAD_TOP = 14;
      var PAD_BOTTOM = 28;

      var vscode = acquireVsCodeApi();
      var canvas = document.getElementById('chart');
      var ctx = canvas.getContext('2d');
      var scroll = document.getElementById('scroll');
      var empty = document.getElementById('empty');
      var stats = document.getElementById('stats');
      var tooltip = document.getElementById('tooltip');
      var clearButton = document.getElementById('clear');
      var subtitle = document.getElementById('subtitle');
      var donutCard = document.getElementById('donutCard');
      var donut = document.getElementById('donut');
      var pctHit = document.getElementById('pctHit');
      var pctMiss = document.getElementById('pctMiss');
      var pctOut = document.getElementById('pctOut');
      var valHit = document.getElementById('valHit');
      var valMiss = document.getElementById('valMiss');
      var valOut = document.getElementById('valOut');
      var valTotal = document.getElementById('valTotal');
      var valCost = document.getElementById('valCost');

      var samples = [];
      var layout = null;
      var pricing = null;
      var frame = 0;

      function palette() {
        var styles = getComputedStyle(document.body);
        function read(name, fallback) {
          var value = styles.getPropertyValue(name).trim();
          return value.length > 0 ? value : fallback;
        }
        return {
          hit: read('--vscode-charts-green', '#3fb950'),
          miss: read('--vscode-charts-blue', '#58a6ff'),
          out: read('--vscode-charts-purple', '#bc8cff'),
          grid: read('--vscode-panel-border', 'rgba(128, 128, 128, 0.35)'),
          text: read('--vscode-descriptionForeground', 'rgba(160, 160, 160, 0.9)'),
          fg: read('--vscode-foreground', '#dddddd')
        };
      }

      function niceCeil(value) {
        if (!(value > 0)) return 1;
        var exponent = Math.floor(Math.log10(value));
        var base = Math.pow(10, exponent);
        var normalized = value / base;
        var nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
        return nice * base;
      }

      function trimZero(text) {
        return text.slice(-2) === '.0' ? text.slice(0, -2) : text;
      }

      function compact(value) {
        if (value >= 1000000000) return trimZero((value / 1000000000).toFixed(value >= 10000000000 ? 0 : 1)) + 'B';
        if (value >= 1000000) return trimZero((value / 1000000).toFixed(value >= 10000000 ? 0 : 1)) + 'M';
        if (value >= 1000) return trimZero((value / 1000).toFixed(value >= 10000 ? 0 : 1)) + 'k';
        return String(Math.round(value));
      }

      function fill(x, y, width, height, color) {
        if (width <= 0 || height <= 0) return;
        ctx.fillStyle = color;
        ctx.fillRect(x, y, width, height);
      }

      function drawGrid(left, top, plotWidth, plotHeight, niceMax, colors) {
        var fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = colors.grid;
        ctx.fillStyle = colors.text;
        ctx.font = '10px ' + fontFamily;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        var steps = 4;
        for (var i = 0; i <= steps; i += 1) {
          var value = (niceMax / steps) * i;
          var y = Math.round(top + plotHeight - (i / steps) * plotHeight) + 0.5;
          ctx.beginPath();
          ctx.moveTo(left, y);
          ctx.lineTo(left + plotWidth, y);
          ctx.stroke();
          ctx.fillText(compact(value), left - 8, y);
        }
        ctx.restore();
      }

      function totals() {
        var hit = 0;
        var miss = 0;
        var output = 0;
        for (var i = 0; i < samples.length; i += 1) {
          hit += samples[i].cacheHit;
          miss += samples[i].cacheMiss;
          output += samples[i].output;
        }
        return { hit: hit, miss: miss, output: output, total: hit + miss + output };
      }

      function hasPricing() {
        return pricing !== null &&
          (pricing.inputPerMillion > 0 || pricing.cachedPerMillion > 0 || pricing.outputPerMillion > 0);
      }

      function costOf(hit, miss, output) {
        if (!hasPricing()) return null;
        return (hit / 1000000) * pricing.cachedPerMillion +
          (miss / 1000000) * pricing.inputPerMillion +
          (output / 1000000) * pricing.outputPerMillion;
      }

      function formatCost(value) {
        if (value === null) return '—';
        if (value > 0 && value < 0.0001) return '<$0.0001';
        return '$' + (value < 1 ? value.toFixed(4) : value.toFixed(2));
      }

      function percent(part, total) {
        return total > 0 ? Math.round((part / total) * 100) + '%' : '0%';
      }

      function drawDonut(sum) {
        var size = 76;
        var dpr = window.devicePixelRatio || 1;
        var pixels = Math.round(size * dpr);
        if (donut.width !== pixels) {
          donut.width = pixels;
          donut.height = pixels;
        }
        var ctx2 = donut.getContext('2d');
        ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx2.clearRect(0, 0, size, size);
        var colors = palette();
        var cx = size / 2;
        var cy = size / 2;
        var radius = size / 2 - 5;
        ctx2.lineWidth = 9;
        if (sum.total <= 0) {
          ctx2.beginPath();
          ctx2.strokeStyle = colors.grid;
          ctx2.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx2.stroke();
        } else {
          var parts = [
            { value: sum.hit, color: colors.hit },
            { value: sum.miss, color: colors.miss },
            { value: sum.output, color: colors.out }
          ];
          var start = -Math.PI / 2;
          for (var i = 0; i < parts.length; i += 1) {
            if (parts[i].value <= 0) continue;
            var angle = (parts[i].value / sum.total) * Math.PI * 2;
            ctx2.beginPath();
            ctx2.strokeStyle = parts[i].color;
            ctx2.arc(cx, cy, radius, start, start + angle);
            ctx2.stroke();
            start += angle;
          }
        }
        var fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
        ctx2.fillStyle = colors.fg;
        ctx2.textAlign = 'center';
        ctx2.textBaseline = 'middle';
        ctx2.font = '600 11px ' + fontFamily;
        ctx2.fillText(compact(sum.total), cx, cy - 5);
        ctx2.font = '9px ' + fontFamily;
        ctx2.fillStyle = colors.text;
        ctx2.fillText('total', cx, cy + 8);
      }

      function updateTotals() {
        if (samples.length === 0) {
          stats.textContent = 'No API calls yet';
          donutCard.hidden = true;
          return;
        }
        var sum = totals();
        var cost = costOf(sum.hit, sum.miss, sum.output);
        stats.textContent =
          samples.length + (samples.length === 1 ? ' call' : ' calls') +
          ' · in ' + compact(sum.hit) + ' hit / ' + compact(sum.miss) + ' miss' +
          ' · out ' + compact(sum.output) +
          ' · total ' + compact(sum.total) +
          (cost === null ? '' : ' · ' + formatCost(cost));
        pctHit.textContent = percent(sum.hit, sum.total);
        pctMiss.textContent = percent(sum.miss, sum.total);
        pctOut.textContent = percent(sum.output, sum.total);
        valHit.textContent = compact(sum.hit);
        valMiss.textContent = compact(sum.miss);
        valOut.textContent = compact(sum.output);
        valTotal.textContent = compact(sum.total);
        valCost.textContent = formatCost(cost);
        donutCard.hidden = false;
        drawDonut(sum);
      }

      function render() {
        var viewportWidth = Math.max(1, scroll.clientWidth);
        var viewportHeight = Math.max(1, scroll.clientHeight);
        var count = samples.length;
        var width = viewportWidth;
        var height = viewportHeight;
        var dpr = window.devicePixelRatio || 1;

        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        var left = PAD_LEFT;
        var top = PAD_TOP;
        var plotWidth = Math.max(1, width - PAD_LEFT - PAD_RIGHT);
        var plotHeight = Math.max(1, height - PAD_TOP - PAD_BOTTOM);

        // The chart is a fixed window on the newest calls: once the bars fill the plot, the oldest
        // ones drop off the left instead of pushing the newest past the right edge.
        var maxBars = Math.max(1, Math.floor(plotWidth / STEP_MIN));
        var start = Math.max(0, count - maxBars);
        var visible = start === 0 ? samples : samples.slice(start);
        var step = visible.length > 0
          ? Math.max(STEP_MIN, Math.min(STEP_MAX, Math.floor(plotWidth / visible.length)))
          : STEP_MIN;

        var maxTotal = 0;
        for (var i = 0; i < visible.length; i += 1) {
          if (visible[i].total > maxTotal) maxTotal = visible[i].total;
        }
        var niceMax = niceCeil(maxTotal);
        var colors = palette();
        drawGrid(left, top, plotWidth, plotHeight, niceMax, colors);

        var barWidth = Math.max(1, step - GAP);
        for (var index = 0; index < visible.length; index += 1) {
          var sample = visible[index];
          var x = left + index * step + Math.floor((step - barWidth) / 2);
          var totalHeight = (sample.total / niceMax) * plotHeight;
          var barBottom = top + plotHeight;
          var hitHeight = totalHeight * (sample.cacheHit / sample.total);
          var missHeight = totalHeight * (sample.cacheMiss / sample.total);
          var outputHeight = totalHeight - hitHeight - missHeight;
          var hitTop = barBottom - hitHeight;
          var missTop = hitTop - missHeight;

          if (sample.cacheHit > 0) fill(x, hitTop, barWidth, hitHeight, colors.hit);
          if (sample.cacheMiss > 0) fill(x, missTop, barWidth, missHeight, colors.miss);
          if (sample.output > 0) fill(x, missTop - outputHeight, barWidth, outputHeight, colors.out);
        }

        layout = { left: left, step: step, start: start };
        empty.hidden = count > 0;
        subtitle.textContent = visible.length < count
          ? 'newest ' + visible.length + ' of ' + count + ' calls'
          : 'one bar = one API call';
        updateTotals();
      }

      function schedule() {
        if (frame !== 0) return;
        frame = requestAnimationFrame(function () {
          frame = 0;
          render();
        });
      }

      function hideTooltip() {
        tooltip.hidden = true;
      }

      function showTooltip(event) {
        if (layout === null || samples.length === 0) {
          hideTooltip();
          return;
        }
        var rect = canvas.getBoundingClientRect();
        var offset = Math.floor((event.clientX - rect.left - layout.left) / layout.step);
        var index = layout.start + offset;
        if (index < layout.start || index >= samples.length) {
          hideTooltip();
          return;
        }
        var sample = samples[index];
        var model = sample.model.length > 0 ? sample.model : 'DeepSeek';
        var cost = costOf(sample.cacheHit, sample.cacheMiss, sample.output);
        tooltip.textContent =
          new Date(sample.at).toLocaleTimeString() + ' · ' + sample.source + ' · ' + model + '\\n' +
          'total ' + sample.total.toLocaleString() + ' tokens\\n' +
          'cache hit ' + sample.cacheHit.toLocaleString() +
          ' · miss ' + sample.cacheMiss.toLocaleString() +
          ' · output ' + sample.output.toLocaleString() +
          (cost === null ? '' : '\\ncost ' + formatCost(cost));
        tooltip.hidden = false;

        var pad = 12;
        var left = event.clientX + pad;
        var top = event.clientY + pad;
        var bounds = tooltip.getBoundingClientRect();
        if (left + bounds.width > window.innerWidth - pad) {
          left = event.clientX - bounds.width - pad;
        }
        if (top + bounds.height > window.innerHeight - pad) {
          top = event.clientY - bounds.height - pad;
        }
        tooltip.style.left = Math.max(pad, left) + 'px';
        tooltip.style.top = Math.max(pad, top) + 'px';
      }

      function replaceSamples(next) {
        samples = Array.isArray(next) ? next : [];
        if (samples.length > MAX_SAMPLES) {
          samples = samples.slice(samples.length - MAX_SAMPLES);
        }
        schedule();
      }

      window.addEventListener('message', function (event) {
        var message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'init') {
          pricing = message.pricing || null;
          replaceSamples(message.samples);
          return;
        }
        if (message.type === 'pricing') {
          pricing = message.pricing || null;
          schedule();
          return;
        }
        if (message.type === 'append' && Array.isArray(message.samples)) {
          if (message.samples.length === 0) return;
          samples = samples.concat(message.samples);
          if (samples.length > MAX_SAMPLES) {
            samples = samples.slice(samples.length - MAX_SAMPLES);
          }
          schedule();
        }
      });

      canvas.addEventListener('mousemove', showTooltip);
      canvas.addEventListener('mouseleave', hideTooltip);
      clearButton.addEventListener('click', function () {
        samples = [];
        render();
        vscode.postMessage({ type: 'clear' });
      });

      if (typeof ResizeObserver === 'function') {
        new ResizeObserver(schedule).observe(scroll);
      } else {
        window.addEventListener('resize', schedule);
      }

      // The canvas has no CSS dependency on the theme, so redraw when VS Code swaps it.
      var themeObserver = new MutationObserver(schedule);
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-vscode-theme-kind']
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      schedule();
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}
