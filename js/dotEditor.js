/**
 * dotEditor.js — 48 × 64 도트 드로잉 에디터
 *
 * 사용자가 직접 점을 찍어 나무를 그리고, 그 결과를 앱으로 "따라 그리기"
 * 링크(siltime://import)로 넘깁니다. 읽기 전용인 canvasRenderer 와 달리
 * 포인터로 칸을 칠하고 지울 수 있습니다.
 *
 * 좌표/그리드/색 처리는 config.js 와 canvasRenderer 의 규칙을 그대로 따릅니다.
 *   - 그리드: COLS(48) × ROWS(64), 맨 아랫줄 GROUND_ROW(63) 이 지면.
 *   - 점 포맷: { x, y, colorHex } — shareTree.buildImportLink 가 받는 모양.
 *
 * 앱 import 제약(SharedTreeLink.swift)과 맞추기 위해 두 가지를 UI 로 돕습니다.
 *   1) 지면행(y=63)에 점이 하나 이상 있어야 씨앗이 잡힙니다.
 *   2) 모든 점이 씨앗과 8방향으로 이어져 있어야 전부 반영됩니다.
 *  → `analyze()` 가 이 둘을 검사해 상태를 돌려주고, 캔버스는 이어지지 않은
 *    점을 흐리게 그려 사용자가 바로 알아채게 합니다.
 */

import { COLS, GROUND_ROW, ROWS } from "./config.js";
import { normalizeHex } from "./statsRenderer.js";

/** 에디터 기본 팔레트 — 앱의 웜 그린 계열과 맞춥니다. */
export const EDITOR_PALETTE = Object.freeze([
  { hex: "#1E3932", label: "줄기" },
  { hex: "#00754A", label: "잎" },
  { hex: "#6F8F7D", label: "연두" },
  { hex: "#795548", label: "밑동" },
  { hex: "#C8A95B", label: "열매" },
]);

const MIN_CELL = 7;
const MAX_CELL = 16;
const MAX_DPR = 3;
const GUIDE_STEP = 4;

/** "x,y" 키 */
const keyOf = (x, y) => `${x},${y}`;

export class DotEditor {
  /**
   * @param {Object} refs
   * @param {HTMLCanvasElement} refs.canvas  그리기 캔버스
   * @param {HTMLElement} refs.frame         폭 계산 기준 컨테이너
   * @param {HTMLElement} [refs.readout]     좌표/상태 리드아웃
   * @param {HTMLElement} [refs.countLabel]  점 개수 라벨
   * @param {(summary: EditorSummary) => void} [refs.onChange] 변경 콜백
   */
  constructor(refs) {
    this.canvas = refs.canvas;
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.frame = refs.frame;
    this.readout = refs.readout ?? null;
    this.countLabel = refs.countLabel ?? null;
    this.onChange = typeof refs.onChange === "function" ? refs.onChange : () => {};

    /** @type {Map<string, string>} "x,y" → colorHex */
    this.cells = new Map();
    this.cellSize = MIN_CELL;
    this.hover = null; // {x, y}
    this.color = EDITOR_PALETTE[0].hex;

    /** 현재 포인터 제스처: "paint" | "erase" | null */
    this.stroke = null;
    this.pointerId = null;

    this.#bindEvents();
    this.resize();
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /** 팔레트에서 색 선택 */
  setColor(hex) {
    this.color = normalizeHex(hex, this.color);
  }

  /** 전체 지우기 */
  clear() {
    this.cells.clear();
    this.hover = null;
    this.render();
    this.#emitChange();
  }

  /** 현재 점들을 shareTree 형식 배열로 반환 */
  toDots() {
    return [...this.cells.entries()].map(([key, hex]) => {
      const [x, y] = key.split(",").map(Number);
      return { x, y, colorHex: hex };
    });
  }

  /** 외부에서 점 묶음을 불러와 캔버스에 올립니다(앱에서 받은 나무 수정 등). */
  loadDots(dots) {
    this.cells.clear();
    for (const dot of Array.isArray(dots) ? dots : []) {
      const x = Number(dot?.x);
      const y = Number(dot?.y);
      if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
      if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
      this.cells.set(keyOf(x, y), normalizeHex(dot?.colorHex, this.color));
    }
    this.render();
    this.#emitChange();
  }

  /**
   * 앱으로 보낼 수 있는 상태인지 분석합니다.
   * @returns {EditorSummary}
   */
  analyze() {
    const total = this.cells.size;
    const groundCount = [...this.cells.keys()].filter(
      (k) => Number(k.split(",")[1]) === GROUND_ROW,
    ).length;

    const connected = this.#connectedFromGround();
    const strayCount = total - connected.size;

    return {
      total,
      hasGround: groundCount > 0,
      strayCount,
      canImport: total > 0 && groundCount > 0,
    };
  }

  /** 컨테이너 폭에 맞춰 캔버스/DPI 재계산 후 렌더 */
  resize() {
    const available = this.frame?.clientWidth || this.canvas.clientWidth || COLS * MIN_CELL;
    const raw = Math.floor(available / COLS);
    this.cellSize = Math.max(MIN_CELL, Math.min(MAX_CELL, raw));

    const cssWidth = this.cellSize * COLS;
    const cssHeight = this.cellSize * ROWS;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.canvas.width = Math.round(cssWidth * dpr);
    this.canvas.height = Math.round(cssHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.render();
  }

  /** 리스너 해제 */
  destroy() {
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("resize", this.onResize);
  }

  /* ─────────────────────────── Rendering ─────────────────────────── */

  render() {
    const ctx = this.ctx;
    const cell = this.cellSize;
    const width = cell * COLS;
    const height = cell * ROWS;
    const theme = this.#theme();

    ctx.fillStyle = theme.canvas;
    ctx.fillRect(0, 0, width, height);

    this.#drawGuides(ctx, cell, width, height, theme);

    // 씨앗과 이어지지 않은 점은 흐리게 그려 "따로 떨어졌음"을 보여 줍니다.
    const connected = this.#connectedFromGround();
    const inset = cell >= 10 ? 1 : 0.5;
    const radius = Math.max(1, cell * 0.22);

    for (const [key, hex] of this.cells) {
      const [x, y] = key.split(",").map(Number);
      const alpha = connected.has(key) ? 1 : 0.3;
      this.#paintCell(ctx, x, y, cell, inset, radius, hex, alpha);
    }

    this.#drawHover(ctx, cell, theme);
  }

  #drawGuides(ctx, cell, width, height, theme) {
    const markSize = Math.max(1, Math.round(cell * 0.1));
    ctx.fillStyle = theme.guide;
    for (let x = 0; x < COLS; x += GUIDE_STEP) {
      for (let y = 0; y < ROWS; y += GUIDE_STEP) {
        const cx = Math.round(x * cell + cell / 2 - markSize / 2);
        const cy = Math.round(y * cell + cell / 2 - markSize / 2);
        ctx.fillRect(cx, cy, markSize, markSize);
      }
    }

    // 중앙 축(씨앗 열)
    ctx.fillStyle = theme.guide;
    ctx.fillRect(Math.round(COLS / 2) * cell, 0, 1, height);

    // 지면 라인 — 조금 더 또렷하게. 씨앗은 이 줄에 놓여야 합니다.
    const groundY = Math.round(GROUND_ROW * cell) + 0.5;
    ctx.strokeStyle = theme.ground;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groundY);
    ctx.lineTo(width, groundY);
    ctx.stroke();
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

  /** CSS 변수 → 테마 색. 없으면 라이트 폴백. */
  #theme() {
    const read = (name, fallback) => {
      const value = getComputedStyle(this.canvas).getPropertyValue(name).trim();
      return value || fallback;
    };
    return {
      canvas: read("--canvas-bg", "#ffffff"),
      guide: read("--canvas-guide", "rgba(30,57,50,0.07)"),
      ground: read("--canvas-guide-strong", "rgba(30,57,50,0.16)"),
      hover: read("--green-accent", "#00754A"),
    };
  }

  /* ─────────────────────────── Interaction ─────────────────────────── */

  #bindEvents() {
    this.onPointerDown = (e) => this.#handleDown(e);
    this.onPointerMove = (e) => this.#handleMove(e);
    this.onPointerUp = (e) => this.#handleUp(e);
    this.onPointerLeave = () => {
      this.hover = null;
      this.render();
      this.#updateReadout(null);
    };
    this.onResize = () => this.resize();

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointerleave", this.onPointerLeave);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("resize", this.onResize);
  }

  /** 포인터 좌표 → 격자 칸. 범위를 벗어나면 null. */
  #cellAt(e) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / this.cellSize);
    const y = Math.floor((e.clientY - rect.top) / this.cellSize);
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return null;
    return { x, y };
  }

  #handleDown(e) {
    const cell = this.#cellAt(e);
    if (!cell) return;
    e.preventDefault();
    this.canvas.setPointerCapture?.(e.pointerId);
    this.pointerId = e.pointerId;

    // 이미 칠해진 칸을 다시 누르면 지우기, 아니면 칠하기. 드래그 내내 유지.
    const key = keyOf(cell.x, cell.y);
    this.stroke = this.cells.has(key) ? "erase" : "paint";
    this.#applyStroke(cell);
  }

  #handleMove(e) {
    const cell = this.#cellAt(e);
    this.hover = cell;
    this.#updateReadout(cell);

    if (this.stroke && cell) {
      this.#applyStroke(cell);
    } else {
      this.render();
    }
  }

  #handleUp(e) {
    if (this.pointerId != null) {
      this.canvas.releasePointerCapture?.(this.pointerId);
      this.pointerId = null;
    }
    const wasDrawing = this.stroke != null;
    this.stroke = null;
    if (wasDrawing) this.#emitChange();
  }

  /** 현재 제스처(paint/erase)를 한 칸에 적용. */
  #applyStroke(cell) {
    const key = keyOf(cell.x, cell.y);
    if (this.stroke === "paint") {
      this.cells.set(key, this.color);
    } else if (this.stroke === "erase") {
      this.cells.delete(key);
    }
    this.render();
  }

  /* ─────────────────────────── Helpers ─────────────────────────── */

  /**
   * 지면행 점들에서 8방향 BFS 로 이어진 칸 집합을 구합니다.
   * 앱의 성장 규칙(씨앗 착근 + 인접 연결)과 같은 연결성 판정입니다.
   * @returns {Set<string>}
   */
  #connectedFromGround() {
    const reached = new Set();
    const queue = [];

    for (const key of this.cells.keys()) {
      if (Number(key.split(",")[1]) === GROUND_ROW) {
        reached.add(key);
        queue.push(key);
      }
    }

    while (queue.length) {
      const [cx, cy] = queue.shift().split(",").map(Number);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          const nk = keyOf(cx + dx, cy + dy);
          if (this.cells.has(nk) && !reached.has(nk)) {
            reached.add(nk);
            queue.push(nk);
          }
        }
      }
    }
    return reached;
  }

  #updateReadout(cell) {
    if (!this.readout) return;
    this.readout.textContent = cell ? `x ${cell.x} · y ${cell.y}` : "x — · y —";
  }

  #emitChange() {
    if (this.countLabel) this.countLabel.textContent = String(this.cells.size);
    this.onChange(this.analyze());
  }
}

/**
 * @typedef {Object} EditorSummary
 * @property {number} total       찍은 점 수
 * @property {boolean} hasGround   지면행에 점이 있는지
 * @property {number} strayCount   씨앗과 이어지지 않아 버려질 점 수
 * @property {boolean} canImport   앱으로 보낼 수 있는 상태인지
 */
