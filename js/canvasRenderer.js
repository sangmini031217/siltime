/**
 * canvasRenderer.js — 24 × 32 픽셀 트리 캔버스 렌더러
 *
 *  - window.devicePixelRatio 를 반영해 Retina 에서도 점이 바늘처럼 선명합니다.
 *  - dot.colorHex(사용자 지정 색), 씨앗 갈색, 잡초 초록 점(같은 칸 스택)을 렌더링합니다.
 *  - 마우스/터치 호버 시 픽셀 인스펙터 툴팁과 좌표 리드아웃을 갱신합니다.
 */

import {
  COLS,
  DOT_TYPE,
  DOT_TYPE_LABEL,
  GROUND_ROW,
  MAX_CELL_SIZE,
  MAX_DEVICE_PIXEL_RATIO,
  MIN_CELL_SIZE,
  PALETTE,
  ROWS,
  RULER_STEP,
} from "./config.js";
import { formatDate, formatDuration, normalizeHex, toFiniteNumber } from "./statsRenderer.js";

const RULER_GUTTER = 24; // ruler--y(18px) + gap(6px)

export class CanvasRenderer {
  /**
   * @param {Object} refs
   * @param {HTMLCanvasElement} refs.canvas
   * @param {HTMLElement} refs.stage        캔버스를 감싸는 position:relative 컨테이너
   * @param {HTMLElement} refs.frame        패딩/폭 계산 기준 컨테이너
   * @param {HTMLElement} refs.rulerX
   * @param {HTMLElement} refs.rulerY
   * @param {HTMLElement} refs.inspector
   * @param {HTMLElement} refs.readout      좌표 리드아웃
   * @param {HTMLElement} refs.countLabel   점 개수 라벨
   */
  constructor(refs) {
    this.canvas = refs.canvas;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.stage = refs.stage;
    this.frame = refs.frame;
    this.rulerX = refs.rulerX;
    this.rulerY = refs.rulerY;
    this.inspector = refs.inspector;
    this.readout = refs.readout;
    this.countLabel = refs.countLabel;

    this.inspectorEls = {
      swatch: this.inspector.querySelector("#inspector-swatch"),
      title: this.inspector.querySelector("#inspector-title"),
      coord: this.inspector.querySelector("#inspector-coord"),
      focus: this.inspector.querySelector("#inspector-focus"),
      date: this.inspector.querySelector("#inspector-date"),
    };

    /** @type {Map<string, object>} "x,y" → dot */
    this.cellMap = new Map();
    /** @type {Map<string, string>} categoryId → name */
    this.categoryNames = new Map();
    this.dots = [];
    this.cellSize = MIN_CELL_SIZE;
    this.hover = null; // {x, y}

    this.#bindEvents();
    this.resize();
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /** 트리 데이터 주입 후 재렌더 */
  setTree(tree) {
    this.dots = Array.isArray(tree?.dots) ? tree.dots : [];
    this.categoryNames = new Map(
      (Array.isArray(tree?.categories) ? tree.categories : []).map((c) => [
        String(c?.id ?? ""),
        String(c?.name ?? "미분류"),
      ]),
    );
    this.#buildCellMap();
    this.countLabel.textContent = String(this.cellMap.size);
    this.#hideInspector();
    this.render();
  }

  /** 데이터 초기화 */
  clear() {
    this.dots = [];
    this.cellMap.clear();
    this.categoryNames.clear();
    this.countLabel.textContent = "0";
    this.#hideInspector();
    this.render();
  }

  /**
   * 외부(기록 리스트 등)에서 특정 좌표를 지목합니다.
   * 해당 칸에 점이 있으면 인스펙터까지 함께 띄웁니다.
   */
  focusCell(x, y) {
    this.#setHover({
      x: clampInt(x, 0, COLS - 1),
      y: clampInt(y, 0, ROWS - 1),
    });
  }

  /** 컨테이너 폭에 맞춰 캔버스 크기/DPI 재계산 */
  resize() {
    const cellSize = this.#measureCellSize();
    this.cellSize = cellSize;

    const cssWidth = cellSize * COLS;
    const cssHeight = cellSize * ROWS;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;

    const backingWidth = Math.round(cssWidth * dpr);
    const backingHeight = Math.round(cssHeight * dpr);
    if (this.canvas.width !== backingWidth || this.canvas.height !== backingHeight) {
      this.canvas.width = backingWidth;
      this.canvas.height = backingHeight;
    }

    // 논리 좌표계를 CSS px 로 고정 (실제 백킹 스토어는 dpr 배율)
    this.ctx.setTransform(
      backingWidth / cssWidth,
      0,
      0,
      backingHeight / cssHeight,
      0,
      0,
    );

    this.frame.style.setProperty("--canvas-width", `${cssWidth}px`);
    this.frame.style.setProperty("--canvas-height", `${cssHeight}px`);

    this.#buildRulers();
    this.render();
  }

  render() {
    const cell = this.cellSize;
    const width = cell * COLS;
    const height = cell * ROWS;
    const ctx = this.ctx;
    const theme = this.#readTheme();
    // 인스펙터 등 render 이후 호출되는 경로에서도 쓰도록 캐시
    this.dotFallback = theme.dot;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    this.#drawGuides(ctx, cell, width, height, theme);
    this.#drawDots(ctx, cell);
    this.#drawHover(ctx, cell, theme);
  }

  destroy() {
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onWindowResize);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerdown", this.onPointerMove);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointercancel", this.onPointerLeave);
  }

  /* ─────────────────────────── Drawing ─────────────────────────── */

  #drawGuides(ctx, cell, width, height, theme) {
    // 4칸 간격 가이드 마크 (아주 옅은 점)
    const markSize = Math.max(1, Math.round(cell * 0.1));
    ctx.fillStyle = theme.guide;
    for (let x = 0; x < COLS; x += RULER_STEP) {
      for (let y = 0; y < ROWS; y += RULER_STEP) {
        const cx = Math.round(x * cell + cell / 2 - markSize / 2);
        const cy = Math.round(y * cell + cell / 2 - markSize / 2);
        ctx.fillRect(cx, cy, markSize, markSize);
      }
    }

    // 중앙 축(씨앗 열) 표시
    ctx.fillStyle = theme.guide;
    ctx.fillRect(Math.round(COLS / 2) * cell, 0, 1, height);

    // 지면 라인
    const groundY = Math.round(GROUND_ROW * cell) + 0.5;
    ctx.strokeStyle = theme.ground;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(width, groundY);
    ctx.stroke();
  }

  #drawDots(ctx, cell) {
    const inset = cell >= 10 ? 1 : 0.5;
    const radius = Math.max(1, cell * 0.22);

    for (const dot of this.dots) {
      const x = clampInt(dot.x, 0, COLS - 1);
      const y = clampInt(dot.y, 0, ROWS - 1);
      const color = this.#colorOf(dot);

      if (dot.type === DOT_TYPE.WEED) {
        const count = Math.max(1, clampInt(dot.count ?? 1, 1, ROWS));
        for (let i = 0; i < count; i += 1) {
          const stackY = y - i;
          if (stackY < 0) break;
          // 위로 갈수록 살짝 작아지는 잡초 스택
          const shrink = Math.min(0.32, i * 0.08);
          const pad = inset + cell * shrink * 0.5;
          this.#paintCell(ctx, x, stackY, cell, pad, radius, color, 1 - shrink * 0.6);
        }
        continue;
      }

      this.#paintCell(ctx, x, y, cell, inset, radius, color, 1);
    }
  }

  #paintCell(ctx, x, y, cell, pad, radius, color, alpha) {
    const px = x * cell + pad;
    const py = y * cell + pad;
    const size = cell - pad * 2;
    if (size <= 0) return;

    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(px, py, size, size, Math.min(radius, size / 2));
    } else {
      ctx.rect(px, py, size, size);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  #drawHover(ctx, cell, theme) {
    if (!this.hover) return;
    const { x, y } = this.hover;
    ctx.strokeStyle = theme.hover;
    ctx.lineWidth = 1;
    ctx.strokeRect(x * cell + 0.5, y * cell + 0.5, cell - 1, cell - 1);
  }

  /* ─────────────────────────── Rulers ─────────────────────────── */

  #buildRulers() {
    const cell = this.cellSize;

    const xFragment = document.createDocumentFragment();
    for (let x = 0; x < COLS; x += RULER_STEP) {
      const tick = document.createElement("span");
      tick.className = "ruler__tick";
      tick.textContent = String(x);
      tick.style.left = `${x * cell + cell / 2}px`;
      xFragment.append(tick);
    }
    this.rulerX.replaceChildren(xFragment);

    const yFragment = document.createDocumentFragment();
    for (let y = 0; y < ROWS; y += RULER_STEP) {
      const tick = document.createElement("span");
      tick.className = "ruler__tick";
      tick.textContent = String(y);
      tick.style.top = `${y * cell + cell / 2}px`;
      yFragment.append(tick);
    }
    // 지면 행 표시
    const groundTick = document.createElement("span");
    groundTick.className = "ruler__tick";
    groundTick.textContent = String(GROUND_ROW);
    groundTick.style.top = `${GROUND_ROW * cell + cell / 2}px`;
    yFragment.append(groundTick);
    this.rulerY.replaceChildren(yFragment);
  }

  /* ─────────────────────────── Interaction ─────────────────────────── */

  #bindEvents() {
    this.onPointerMove = (event) => {
      const rect = this.canvas.getBoundingClientRect();
      const cell = this.cellSize;
      const x = Math.floor((event.clientX - rect.left) / cell);
      const y = Math.floor((event.clientY - rect.top) / cell);

      if (x < 0 || y < 0 || x >= COLS || y >= ROWS) {
        this.#setHover(null);
        return;
      }
      this.#setHover({ x, y });
    };

    this.onPointerLeave = () => this.#setHover(null);

    this.onWindowResize = () => this.resize();

    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerdown", this.onPointerMove);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointercancel", this.onPointerLeave);
    window.addEventListener("resize", this.onWindowResize, { passive: true });

    if ("ResizeObserver" in window) {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(this.frame);
    }
  }

  #setHover(cell) {
    const changed =
      (cell === null) !== (this.hover === null) ||
      (cell && this.hover && (cell.x !== this.hover.x || cell.y !== this.hover.y));
    if (!changed) return;

    this.hover = cell;
    this.readout.textContent = cell ? `x ${cell.x} · y ${cell.y}` : "x — · y —";

    if (cell) {
      const dot = this.cellMap.get(keyOf(cell.x, cell.y));
      if (dot) this.#showInspector(dot, cell);
      else this.#hideInspector();
    } else {
      this.#hideInspector();
    }

    // 셀이 바뀔 때만 호출되므로 즉시 렌더해도 비용이 작습니다.
    // (rAF 에 맡기면 백그라운드 탭에서 하이라이트가 갱신되지 않습니다.)
    this.render();
  }

  #showInspector(dot, cell) {
    const color = this.#colorOf(dot);
    const typeLabel = DOT_TYPE_LABEL[dot.type] ?? "점";
    const categoryName = dot.categoryId
      ? this.categoryNames.get(String(dot.categoryId)) ?? "미분류"
      : null;

    this.inspectorEls.swatch.style.backgroundColor = color;
    this.inspectorEls.title.textContent = categoryName
      ? `${categoryName} · ${typeLabel}`
      : typeLabel;
    this.inspectorEls.coord.textContent = `${dot.x}, ${dot.y}`;
    this.inspectorEls.focus.textContent =
      dot.type === DOT_TYPE.WEED
        ? `잡초 ${Math.max(1, clampInt(dot.count ?? 1, 1, ROWS))}개`
        : formatDuration(dot.focusSeconds);
    this.inspectorEls.date.textContent = formatDate(dot.createdAt);

    this.inspector.hidden = false;
    // 크기 측정 후 위치 계산
    const cellSize = this.cellSize;
    const stageWidth = cellSize * COLS;
    const stageHeight = cellSize * ROWS;
    const tipWidth = this.inspector.offsetWidth;
    const tipHeight = this.inspector.offsetHeight;

    let left = cell.x * cellSize + cellSize + 8;
    if (left + tipWidth > stageWidth) {
      left = cell.x * cellSize - tipWidth - 8;
    }
    left = Math.max(4, Math.min(left, Math.max(4, stageWidth - tipWidth - 4)));

    let top = cell.y * cellSize - 6;
    top = Math.max(4, Math.min(top, Math.max(4, stageHeight - tipHeight - 4)));

    this.inspector.style.setProperty("--inspector-x", `${Math.round(left)}px`);
    this.inspector.style.setProperty("--inspector-y", `${Math.round(top)}px`);
    this.inspector.classList.add("is-visible");
  }

  #hideInspector() {
    this.inspector.classList.remove("is-visible");
    this.inspector.hidden = true;
  }

  /* ─────────────────────────── Helpers ─────────────────────────── */

  #buildCellMap() {
    this.cellMap.clear();
    for (const dot of this.dots) {
      const x = clampInt(dot.x, 0, COLS - 1);
      const y = clampInt(dot.y, 0, ROWS - 1);

      if (dot.type === DOT_TYPE.WEED) {
        const count = Math.max(1, clampInt(dot.count ?? 1, 1, ROWS));
        for (let i = 0; i < count; i += 1) {
          const stackY = y - i;
          if (stackY < 0) break;
          this.cellMap.set(keyOf(x, stackY), { ...dot, x, y: stackY });
        }
        continue;
      }
      this.cellMap.set(keyOf(x, y), { ...dot, x, y });
    }
  }

  /**
   * dot.colorHex 가 없을 때의 폴백은 테마에 따라 달라집니다.
   * (흰 캔버스에서 흰 가지 점은 보이지 않으므로 CSS 변수에서 읽습니다)
   */
  #colorOf(dot) {
    const type = dot?.type;
    const themed = this.dotFallback?.[type];
    const fallback = themed ?? PALETTE[type] ?? PALETTE.branch;
    return normalizeHex(dot?.colorHex, fallback);
  }

  #measureCellSize() {
    const style = getComputedStyle(this.frame);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const available = this.frame.clientWidth - padding - RULER_GUTTER;
    const raw = Math.floor(available / COLS);
    return Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, Number.isFinite(raw) ? raw : MIN_CELL_SIZE));
  }

  #readTheme() {
    const root = getComputedStyle(document.documentElement);
    const read = (name, fallback) => root.getPropertyValue(name).trim() || fallback;
    return {
      bg: read("--canvas-bg", "#FFFFFF"),
      guide: read("--canvas-guide", "rgba(30,57,50,0.07)"),
      ground: read("--canvas-ground", "rgba(121,85,72,0.30)"),
      hover: read("--canvas-hover", "rgba(0,98,65,0.60)"),
      // 점 색 폴백도 테마에서 읽습니다 (라이트에서 흰 점이 사라지지 않게)
      dot: {
        [DOT_TYPE.SEED]: read("--dot-seed", PALETTE.seed),
        [DOT_TYPE.BRANCH]: read("--dot-branch", PALETTE.branch),
        [DOT_TYPE.LEAF]: read("--dot-leaf", PALETTE.leaf),
        [DOT_TYPE.WEED]: read("--dot-weed", PALETTE.weed),
      },
    };
  }
}

/* ─────────────────────────── Pure utils ─────────────────────────── */

function keyOf(x, y) {
  return `${x},${y}`;
}

function clampInt(value, min, max) {
  const n = Math.round(toFiniteNumber(value, min));
  return Math.max(min, Math.min(max, n));
}
