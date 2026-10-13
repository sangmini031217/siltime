/**
 * miniTreeRenderer.js — 갤러리 카드용 경량 미니 분재 렌더러
 *
 * 메인 화면의 `canvasRenderer.js` 를 쓰지 않는 이유가 있습니다. 그쪽은
 * 호버 인스펙터, 좌표 눈금, ResizeObserver, 테마 감시를 모두 들고 있는
 * 대화형 렌더러입니다. 카드 12장에 12개를 붙이면 ResizeObserver 12개와
 * pointer 리스너 12세트가 생기고, 정작 카드에는 그 기능이 하나도
 * 필요하지 않습니다.
 *
 * 그래서 여기는 의도적으로 바보입니다. 상태도, 리스너도, 애니메이션도
 * 없습니다. "격자와 점 배열을 받아 한 번 그리고 끝"입니다.
 *
 * 성능 설계
 * ─────────
 * · 셀 크기 고정(3px). 반응형 재측정이 없으므로 리플로우가 발생하지 않습니다.
 * · 색상별로 Path2D 를 합쳐 `fill` 호출을 색 가지 수로 묶습니다.
 *   48x64 = 3,072칸을 칸마다 채우면 카드당 수천 번이지만, 묶으면 6~8번입니다.
 * · 빈 하늘은 그리지 않습니다. 점이 있는 칸만 순회합니다.
 */

import { COLS, MINI_CELL_SIZE, PALETTE, ROWS } from "./config.js";

/** Retina 과부하 방지 상한 */
const MAX_DPR = 2;

/**
 * 미니 분재를 캔버스에 그립니다.
 *
 * @param {HTMLCanvasElement} canvas 대상 캔버스
 * @param {Object} options
 * @param {Array<{x:number,y:number,type?:string,colorHex?:string,count?:number}>} options.dots
 * @param {number} [options.cols] 격자 폭 (기본 48)
 * @param {number} [options.rows] 격자 높이 (기본 64)
 * @param {number} [options.cell] 셀 크기 px (기본 3)
 * @param {string} [options.background] 배경색. 생략하면 투명.
 * @param {string} [options.groundColor] 지면선 색. 생략하면 안 그립니다.
 */
export function drawMiniTree(canvas, options) {
  if (!canvas) return;

  const cols = clampInt(options?.cols, 1, 512, COLS);
  const rows = clampInt(options?.rows, 1, 512, ROWS);
  const cell = clampInt(options?.cell, 1, 24, MINI_CELL_SIZE);
  const dots = Array.isArray(options?.dots) ? options.dots : [];

  const cssWidth = cols * cell;
  const cssHeight = rows * cell;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

  // CSS 크기와 백킹 스토어를 분리해 Retina 에서도 또렷하게.
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const backingWidth = Math.round(cssWidth * dpr);
  const backingHeight = Math.round(cssHeight * dpr);
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(backingWidth / cssWidth, 0, 0, backingHeight / cssHeight, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  if (options?.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  // 지면선 — 분재가 떠 있지 않다는 걸 한눈에 보여줍니다.
  if (options?.groundColor) {
    ctx.fillStyle = options.groundColor;
    ctx.fillRect(0, (rows - 1) * cell + cell - 1, cssWidth, 1);
  }

  // 색상별로 묶어 한 번씩만 채웁니다.
  /** @type {Map<string, Path2D>} */
  const byColor = new Map();

  for (const dot of dots) {
    const x = clampInt(dot?.x, 0, cols - 1, -1);
    const y = clampInt(dot?.y, 0, rows - 1, -1);
    if (x < 0 || y < 0) continue;

    const color = resolveColor(dot);

    // 잡초는 같은 칸에 위로 쌓입니다. 미니 뷰에서도 높이로 보여야
    // "방해가 쌓였다"는 신호가 읽힙니다.
    const stack = dot?.type === "weed" ? clampInt(dot?.count, 1, rows, 1) : 1;

    for (let i = 0; i < stack; i += 1) {
      const stackY = y - i;
      if (stackY < 0) break;
      let path = byColor.get(color);
      if (!path) {
        path = new Path2D();
        byColor.set(color, path);
      }
      path.rect(x * cell, stackY * cell, cell, cell);
    }
  }

  for (const [color, path] of byColor) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }
}

/**
 * 점 하나의 색을 정합니다.
 *
 * `colorHex` 가 있으면 그대로, 없으면 타입 기본색으로 떨어집니다.
 * 카테고리 색은 사용자 데이터이므로 검증만 하고 변형하지 않습니다.
 */
function resolveColor(dot) {
  const hex = typeof dot?.colorHex === "string" ? dot.colorHex.trim() : "";
  if (/^#[0-9a-fA-F]{6}$/.test(hex) || /^#[0-9a-fA-F]{3}$/.test(hex)) {
    return hex;
  }
  return PALETTE[dot?.type] ?? PALETTE.branch;
}

/** 정수로 바꾸고 범위를 자릅니다. 숫자가 아니면 fallback. */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

/**
 * 격자 비율에 맞는 CSS 크기를 돌려줍니다.
 *
 * 카드 레이아웃이 캔버스 실제 크기를 알아야 할 때 씁니다.
 * @returns {{width: number, height: number}}
 */
export function miniTreeSize({ cols = COLS, rows = ROWS, cell = MINI_CELL_SIZE } = {}) {
  return { width: cols * cell, height: rows * cell };
}
