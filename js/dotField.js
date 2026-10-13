/**
 * dotField.js — 첫 화면 전체를 하나의 도트 격자로 그리는 캔버스
 *
 * 첫 화면은 화면 가득 깔린 도트 격자입니다. 그 위에
 *   · "SilTime" 로고가 같은 격자의 칸으로 찍히고,
 *   · 도트로 그린 큰 나무(집중의 숲)가 같은 칸 크기로 자라며,
 *   · 나무의 점 하나는 사용자 한 명이라서 눌러 그 사람의 전적으로 갈 수 있습니다.
 *
 * 모든 것이 같은 격자(칸 크기 G) 위에 있어서, 점이 어긋나지 않고 한 장의 도트 그림으로 보입니다.
 * 검색창과 글자는 HTML 로 그 위에 겹쳐 둡니다. (접근성, 입력, 한글 렌더링 때문입니다.)
 *
 * 좌표계: 모든 위치는 `#landing` 의 왼쪽 위를 (0,0) 으로 잽니다. 스크롤해도 변하지 않습니다.
 *
 * 입력
 *   · 마우스: 격자가 커서 주변에서 밝아지고, 사용자 점에 올리면 카드, 클릭하면 이동
 *   · 터치  : 첫 탭에 카드(와 "전적 보기" 버튼), 같은 점을 한 번 더 탭하거나 버튼을 누르면 이동
 *   · 키보드/스크린 리더: 캔버스 대신 같은 사용자를 순위대로 나열한 목록을 씁니다. (app.js)
 */

import { dotText, WORDMARK } from "./dotFont.js";
import { assignSlots, buildSilhouette, FOREST_COLS, FOREST_ROWS } from "./forestShape.js";
import { formatCount, formatHours, normalizeHex } from "./statsRenderer.js";

/* ──────────────────────────── 레이아웃 계산 (순수) ──────────────────────────── */

/** 칸 크기 한계(px) */
export const MIN_G = 7;
export const MAX_G = 14;

/** 로고 폭(칸). 글자 7개 x 5칸 + 사이 6칸 */
export const WORDMARK_COLS = 41;

/** 두 단 배치에서 왼쪽(로고)·간격·오른쪽(숲)이 차지하는 칸 수 */
const TWO_COLUMN_CELLS = WORDMARK_COLS + 6 + FOREST_COLS;

/** 두 단 배치에서 숲 위아래 글자·목록이 차지하는 높이(px) */
const FOREST_CHROME_PX = 170;

/**
 * 화면 크기에서 칸 크기 G 를 정합니다.
 *
 * 두 단(데스크톱)에서는 폭과 높이 둘 다 만족해야 하고, 한 단(모바일)에서는 로고 폭에 맞춥니다.
 *
 * @param {number} width 첫 화면 폭(px)
 * @param {number} height 화면 높이(px)
 * @param {boolean} twoColumns 두 단 배치인지
 */
export function computeCell(width, height, twoColumns) {
  const clamp = (v) => Math.max(MIN_G, Math.min(MAX_G, v));
  if (!twoColumns) return clamp(Math.floor((width - 32) / WORDMARK_COLS));

  const byWidth = Math.floor((width - 96) / TWO_COLUMN_CELLS);
  const byHeight = Math.floor((height - FOREST_CHROME_PX) / (FOREST_ROWS + 1));
  return clamp(Math.min(byWidth, byHeight));
}

/** 값을 격자 선(G 의 배수)으로 올림해 붙입니다. */
export function snapUp(value, G) {
  // 레이아웃 좌표에 붙는 아주 작은 소수점 오차(0.01px 이하)는 같은 선으로 봅니다.
  return Math.ceil((value - 0.01) / G) * G + 0;
}

/* ──────────────────────────── 색 ──────────────────────────── */

const GOLD = "#CBA258";
const FALLBACK_COLOR = "#1E3932";
const PODIUM = 3;
const MAX_DPR = 2;

function palette(dark) {
  return dark
    ? {
        lattice: "rgba(255, 255, 255, 0.10)",
        dim: "rgba(255, 255, 255, 0.22)",
        word: "#D4E9E2",
        wordShadow: "rgba(212, 233, 226, 0.16)",
        ring: "#FFFFFF",
        glow: [212, 233, 226],
        ground: "rgba(255, 255, 255, 0.22)",
      }
    : {
        lattice: "rgba(30, 57, 50, 0.11)",
        dim: "rgba(30, 57, 50, 0.20)",
        word: "#1E3932",
        wordShadow: "rgba(30, 57, 50, 0.14)",
        ring: "#1E3932",
        glow: [0, 98, 65],
        ground: "rgba(30, 57, 50, 0.24)",
      };
}

/* ──────────────────────────── 캔버스 ──────────────────────────── */

export class DotField {
  /**
   * @param {Object} refs
   * @param {HTMLElement} refs.landing 좌표의 기준이 되는 첫 화면 요소 (position: relative)
   * @param {HTMLCanvasElement} refs.canvas 첫 화면 전체를 덮는 캔버스
   * @param {HTMLElement} refs.wordSlot 로고가 들어갈 자리 표시 요소
   * @param {HTMLElement} refs.treeSlot 나무가 들어갈 자리 표시 요소
   * @param {HTMLElement} refs.tip 카드(툴팁) 요소
   * @param {HTMLElement} refs.empty 빈 숲 안내 요소
   * @param {(user: object) => void} refs.onSelect 점을 골랐을 때
   */
  constructor({ landing, canvas, wordSlot, treeSlot, tip, empty, onSelect }) {
    this.landing = landing;
    this.canvas = canvas;
    this.wordSlot = wordSlot;
    this.treeSlot = treeSlot;
    this.tip = tip;
    this.empty = empty;
    this.onSelect = typeof onSelect === "function" ? onSelect : () => {};

    /** 나무 모양의 모든 자리 (위→아래) */
    this.slots = buildSilhouette();
    this.slotAt = new Map(this.slots.map((slot, i) => [`${slot.x},${slot.y}`, i]));
    this.word = dotText(WORDMARK);

    /** 주인이 있는 자리 */
    this.plots = [];
    this.plotAt = new Map();

    this.G = MAX_G;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.wordOrigin = { x: 0, y: 0 };
    this.treeOrigin = { x: 0, y: 0 };

    this.hover = null; // plot
    this.pinned = null; // 터치로 고른 plot
    this.pointer = null; // {x, y} 마우스 위치
    this.scheduled = false;

    /** 움직이지 않는 층(격자, 로고, 나무)을 담아 두는 보조 캔버스 */
    this.layer = document.createElement("canvas");
    this.layerDirty = true;

    this.twoColumns = window.matchMedia("(min-width: 901px)");

    this.#bind();
  }

  /** 지금 나무에 앉은 사람 수 */
  get seated() {
    return this.plots.length;
  }

  /**
   * 사용자를 나무에 앉힙니다.
   * @param {Array<object>} ranked rankUsers() 결과
   */
  setUsers(ranked) {
    const users = Array.isArray(ranked) ? ranked : [];
    const picks = assignSlots(this.slots.length, users.length);

    this.plots = picks.map((slotIndex, i) => {
      const slot = this.slots[slotIndex];
      const user = users[i];
      return {
        user,
        slotIndex,
        x: slot.x,
        y: slot.y,
        rank: user.rank ?? i + 1,
        color: normalizeHex(user.primaryCategory?.colorHex, FALLBACK_COLOR),
      };
    });
    this.plotAt = new Map(this.plots.map((plot) => [`${plot.x},${plot.y}`, plot]));
    this.hover = null;
    this.pinned = null;
    this.#hideTip();
    this.layerDirty = true;
    this.#schedule();
  }

  clear() {
    this.setUsers([]);
  }

  /** 화면 크기가 바뀌면 칸 크기부터 다시 정하고 전부 새로 그립니다. */
  resize() {
    const landing = this.landing;
    const width = landing.clientWidth;
    if (width <= 0) return; // 첫 화면이 숨겨진 상태(전적 화면)에서는 건너뜀

    const G = computeCell(width, window.innerHeight, this.twoColumns.matches);
    if (G !== this.G || landing.style.getPropertyValue("--G") === "") {
      this.G = G;
      landing.style.setProperty("--G", `${G}px`);
    }

    // --G 가 바뀌면 자리 표시 요소 크기가 바뀌므로, 레이아웃을 확정한 뒤에 좌표를 잽니다.
    const box = landing.getBoundingClientRect();
    const rel = (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - box.left, y: r.top - box.top };
    };
    const word = rel(this.wordSlot);
    const tree = rel(this.treeSlot);
    this.wordOrigin = { x: snapUp(word.x, G), y: snapUp(word.y, G) };
    this.treeOrigin = { x: snapUp(tree.x, G), y: snapUp(tree.y, G) };

    this.width = width;
    this.height = Math.ceil(box.height);
    this.dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);

    const backingW = Math.round(this.width * this.dpr);
    const backingH = Math.round(this.height * this.dpr);
    this.canvas.width = backingW;
    this.canvas.height = backingH;
    this.layer.width = backingW;
    this.layer.height = backingH;

    this.#placeOverlays();
    this.layerDirty = true;
    this.render();
  }

  /** 테마(밤/낮)가 바뀌면 부릅니다. */
  invalidate() {
    this.layerDirty = true;
    this.#schedule();
  }

  /* ── 그리기 ───────────────────────────────────────────────────── */

  #schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    // rAF 는 백그라운드 탭에서 멈추므로 타이머를 씁니다. 한 프레임 정도의 지연이면 충분합니다.
    setTimeout(() => {
      this.scheduled = false;
      this.render();
    }, 16);
  }

  render() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx || this.canvas.width === 0) return;

    if (this.layerDirty) {
      this.#paintLayer();
      this.layerDirty = false;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.#paintGlow(ctx);
    this.#paintFocus(ctx);
  }

  /** 움직이지 않는 층: 격자 → 로고 → 나무 → 사용자 점 */
  #paintLayer() {
    const ctx = this.layer.getContext("2d");
    const { G, dpr } = this;
    const colors = palette(document.documentElement.dataset.theme === "dark");

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    const cols = Math.ceil(this.width / G);
    const rows = Math.ceil(this.height / G);
    const tree = this.treeOrigin;
    const word = this.wordOrigin;

    // 로고가 차지하는 칸 / 나무가 차지하는 칸은 배경 격자를 비워 둡니다.
    const taken = new Set();
    for (const [c, r] of this.word.cells) {
      taken.add(`${word.x / G + c},${word.y / G + r}`);
    }
    for (const slot of this.slots) {
      taken.add(`${tree.x / G + slot.x},${tree.y / G + slot.y}`);
    }

    // 1) 배경 격자 — 작고 흐린 점. 한 번에 채웁니다.
    const bg = Math.max(2, Math.round(G * 0.2));
    const bgOffset = (G - bg) / 2;
    const path = new Path2D();
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        if (taken.has(`${c},${r}`)) continue;
        path.rect(c * G + bgOffset, r * G + bgOffset, bg, bg);
      }
    }
    ctx.fillStyle = colors.lattice;
    ctx.fill(path);

    // 2) 로고 — 그림자 한 겹을 깔고 같은 칸에 꽉 찬 점으로
    const full = G * 0.92;
    const fullOffset = (G - full) / 2;
    const shadow = Math.max(2, Math.round(G * 0.16));
    ctx.fillStyle = colors.wordShadow;
    for (const [c, r] of this.word.cells) {
      this.#dot(ctx, word.x + c * G + fullOffset + shadow, word.y + r * G + fullOffset + shadow, full);
    }
    ctx.fillStyle = colors.word;
    for (const [c, r] of this.word.cells) {
      this.#dot(ctx, word.x + c * G + fullOffset, word.y + r * G + fullOffset, full);
    }

    // 3) 땅
    ctx.fillStyle = colors.ground;
    ctx.fillRect(tree.x, tree.y + FOREST_ROWS * G - 1, FOREST_COLS * G, 1);

    // 4) 나무의 빈 자리 — 중간 크기, 흐리게
    const small = G * 0.56;
    const smallOffset = (G - small) / 2;
    ctx.fillStyle = colors.dim;
    for (const slot of this.slots) {
      if (this.plotAt.has(`${slot.x},${slot.y}`)) continue;
      this.#dot(ctx, tree.x + slot.x * G + smallOffset, tree.y + slot.y * G + smallOffset, small);
    }

    // 5) 주인이 있는 자리 — 꽉 차게, 그 사람의 색으로
    for (const plot of this.plots) {
      ctx.fillStyle = plot.color;
      this.#dot(ctx, tree.x + plot.x * G + fullOffset, tree.y + plot.y * G + fullOffset, full);
    }

    // 6) 상위 3위 금빛 테두리
    ctx.lineWidth = Math.max(1.5, G * 0.16);
    ctx.strokeStyle = GOLD;
    const ring = G * 1.5;
    const ringOffset = (G - ring) / 2;
    for (const plot of this.plots) {
      if (plot.rank > PODIUM) continue;
      this.#strokeDot(ctx, tree.x + plot.x * G + ringOffset, tree.y + plot.y * G + ringOffset, ring);
    }
  }

  /** 마우스 주변 격자가 밝아집니다. */
  #paintGlow(ctx) {
    const p = this.pointer;
    if (!p) return;
    const { G } = this;
    const colors = palette(document.documentElement.dataset.theme === "dark");
    const radius = G * 5;
    const [r, g, b] = colors.glow;

    const c0 = Math.max(0, Math.floor((p.x - radius) / G));
    const c1 = Math.ceil((p.x + radius) / G);
    const r0 = Math.max(0, Math.floor((p.y - radius) / G));
    const r1 = Math.ceil((p.y + radius) / G);
    const tree = this.treeOrigin;
    const word = this.wordOrigin;

    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        const cx = (col + 0.5) * G;
        const cy = (row + 0.5) * G;
        const d = Math.hypot(cx - p.x, cy - p.y);
        if (d > radius) continue;

        // 나무와 로고 칸은 이미 그려져 있으니 건드리지 않습니다.
        const tx = col - tree.x / G;
        const ty = row - tree.y / G;
        if (this.slotAt.has(`${tx},${ty}`)) continue;
        if (this.word.cells.some(([c, rr]) => word.x / G + c === col && word.y / G + rr === row)) continue;

        const t = 1 - d / radius;
        const size = G * (0.2 + 0.34 * t);
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.12 + 0.5 * t})`;
        this.#dot(ctx, cx - size / 2, cy - size / 2, size);
      }
    }
  }

  /** 지금 가리키는(또는 터치로 고른) 사용자 점을 크게 */
  #paintFocus(ctx) {
    const focus = this.pinned ?? this.hover;
    if (!focus) return;
    const { G } = this;
    const colors = palette(document.documentElement.dataset.theme === "dark");
    const size = G * 1.9;
    const x = this.treeOrigin.x + focus.x * G + (G - size) / 2;
    const y = this.treeOrigin.y + focus.y * G + (G - size) / 2;
    ctx.fillStyle = focus.color;
    this.#dot(ctx, x, y, size);
    ctx.lineWidth = Math.max(2, G * 0.2);
    ctx.strokeStyle = colors.ring;
    this.#strokeDot(ctx, x, y, size);
  }

  #dot(ctx, x, y, size) {
    const radius = Math.max(1, size * 0.2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, size, size, radius);
    else ctx.rect(x, y, size, size);
    ctx.fill();
  }

  #strokeDot(ctx, x, y, size) {
    const radius = Math.max(1, size * 0.2);
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, size, size, radius);
    else ctx.rect(x, y, size, size);
    ctx.stroke();
  }

  /** 빈 숲 안내 카드를 나무 한가운데에 놓습니다. */
  #placeOverlays() {
    const { G, treeOrigin } = this;
    this.empty.style.left = `${Math.round(treeOrigin.x + (FOREST_COLS * G) / 2)}px`;
    this.empty.style.top = `${Math.round(treeOrigin.y + (FOREST_ROWS * G) / 2)}px`;
  }

  /* ── 입력 ─────────────────────────────────────────────────────── */

  #bind() {
    const { canvas } = this;

    canvas.addEventListener("pointermove", (event) => {
      if (event.pointerType === "touch") return; // 터치는 탭으로만
      const point = this.#locate(event);
      this.pointer = { x: point.px, y: point.py };

      if (point.plot) {
        if (this.hover !== point.plot) this.hover = point.plot;
        canvas.style.cursor = "pointer";
        this.#showTip(point.plot, { actionable: false });
      } else {
        this.hover = null;
        canvas.style.cursor = "default";
        if (point.empty && !this.pinned) this.#showEmptyTip(point);
        else if (!this.pinned) this.#hideTip();
      }
      this.#schedule();
    });

    canvas.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "touch") return;
      this.pointer = null;
      this.hover = null;
      canvas.style.cursor = "default";
      if (!this.pinned) this.#hideTip();
      this.#schedule();
    });

    canvas.addEventListener("click", (event) => {
      const touch = event.pointerType === "touch";
      const point = this.#locate(event);

      if (!touch) {
        if (point.plot) this.onSelect(point.plot.user);
        return;
      }

      // 터치: 첫 탭은 카드, 같은 점을 다시 탭하면 이동
      if (point.plot && this.pinned === point.plot) {
        this.onSelect(point.plot.user);
      } else if (point.plot) {
        this.pinned = point.plot;
        this.#showTip(point.plot, { actionable: true });
      } else {
        this.pinned = null;
        if (point.empty) this.#showEmptyTip(point);
        else this.#hideTip();
      }
      this.#schedule();
    });

    // 캔버스 바깥을 누르면 카드를 닫습니다.
    document.addEventListener("click", (event) => {
      if (!this.pinned) return;
      if (event.target === this.canvas || this.tip.contains(event.target)) return;
      this.pinned = null;
      this.#hideTip();
      this.#schedule();
    });

    // 첫 화면 크기뿐 아니라 안쪽 열의 높이가 바뀌어도(목록이 생기거나 접힐 때) 나무 자리가 밀리므로
    // 안쪽 요소들도 함께 지켜봅니다.
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(() => this.resize());
      observer.observe(this.landing);
      for (const el of [this.wordSlot.closest(".landing__inner"), this.treeSlot.closest(".forest")]) {
        if (el) observer.observe(el);
      }
    } else {
      window.addEventListener("resize", () => this.resize());
    }
    this.twoColumns.addEventListener?.("change", () => this.resize());
  }

  /** 포인터 위치 → 어떤 점인지. 좌표는 첫 화면 기준입니다. */
  #locate(event) {
    const rect = this.canvas.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const { G, treeOrigin } = this;

    const fx = (px - treeOrigin.x) / G;
    const fy = (py - treeOrigin.y) / G;
    const gx = Math.floor(fx);
    const gy = Math.floor(fy);

    let plot = this.plotAt.get(`${gx},${gy}`) ?? null;

    // 점이 작아 정확히 못 눌러도 되게, 이웃 칸에서 가장 가까운 점을 잡아 줍니다.
    if (!plot && this.plots.length > 0) {
      let best = null;
      let bestDistance = 1.15;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const candidate = this.plotAt.get(`${gx + dx},${gy + dy}`);
          if (!candidate) continue;
          const distance = Math.hypot(fx - (candidate.x + 0.5), fy - (candidate.y + 0.5));
          if (distance < bestDistance) {
            best = candidate;
            bestDistance = distance;
          }
        }
      }
      plot = best;
    }

    const empty = !plot && this.slotAt.has(`${gx},${gy}`) ? { x: gx, y: gy } : null;
    return { plot, empty, px, py };
  }

  /* ── 카드(툴팁) ───────────────────────────────────────────────── */

  #showTip(plot, { actionable }) {
    const { user } = plot;
    const tip = this.tip;
    tip.replaceChildren();
    tip.classList.remove("is-empty");
    tip.classList.toggle("is-actionable", actionable);

    const head = document.createElement("div");
    head.className = "forest__tip-head";
    const rank = document.createElement("span");
    rank.className = "forest__tip-rank";
    rank.textContent = `${formatCount(plot.rank)}위`;
    const name = document.createElement("strong");
    name.className = "forest__tip-name";
    name.textContent = user.nickname || user.seedId;
    head.append(rank, name);

    const meta = document.createElement("div");
    meta.className = "forest__tip-meta";
    const parts = [formatHours(user.totalFocusSeconds ?? 0)];
    if (Number.isFinite(Number(user.level))) parts.push(`Lv ${formatCount(user.level)}`);
    if (user.primaryCategory?.name) parts.push(String(user.primaryCategory.name));
    meta.textContent = parts.join(" · ");

    tip.append(head, meta);

    if (actionable) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "forest__tip-go";
      go.textContent = "전적 보기";
      go.addEventListener("click", (event) => {
        event.stopPropagation();
        this.onSelect(user);
      });
      tip.append(go);
    } else {
      const hint = document.createElement("div");
      hint.className = "forest__tip-hint";
      hint.textContent = "눌러서 전적 보기";
      tip.append(hint);
    }

    const { G, treeOrigin } = this;
    this.#placeTip((plot.x + 0.5) * G + treeOrigin.x, (plot.y + 0.5) * G + treeOrigin.y);
  }

  #showEmptyTip(point) {
    const tip = this.tip;
    tip.replaceChildren();
    tip.classList.add("is-empty");
    tip.classList.remove("is-actionable");

    const title = document.createElement("strong");
    title.className = "forest__tip-name";
    title.textContent = "비어 있는 자리";
    const meta = document.createElement("div");
    meta.className = "forest__tip-meta";
    meta.textContent = "앱에서 동기화하면 이곳에 심어져요";
    tip.append(title, meta);

    this.#placeTip(point.px, point.py);
  }

  #hideTip() {
    this.tip.hidden = true;
  }

  /** 카드를 기준점 근처에 놓되 첫 화면 밖으로 나가지 않게 합니다. */
  #placeTip(anchorX, anchorY) {
    const tip = this.tip;
    tip.hidden = false;

    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    let left = anchorX + 18;
    let top = anchorY + 18;

    if (left + width > this.width - 4) left = anchorX - width - 18;
    if (left < 4) left = 4;
    if (top + height > this.height - 4) top = anchorY - height - 18;
    if (top < 4) top = 4;

    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }
}
