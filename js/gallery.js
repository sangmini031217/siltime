/**
 * gallery.js — 글로벌 분재 갤러리
 *
 * 최근 동기화된 유저들의 48x64 미니 분재를 카드 그리드로 보여주고,
 * 카드마다 좋아요를 받습니다.
 *
 * 좋아요 흐름 (낙관적 업데이트)
 * ────────────────────────────
 *   1. 클릭 즉시 숫자를 +1 하고 하트를 채웁니다. 네트워크를 기다리지 않습니다.
 *   2. localStorage 에 기록해 같은 기기에서 재클릭을 막습니다.
 *   3. API 를 호출합니다.
 *      · 성공하면 서버가 돌려준 실제 카운트로 교정합니다.
 *        (다른 사람이 동시에 눌렀을 수 있으므로 +1 보다 클 수 있습니다)
 *      · 실패하면 숫자와 localStorage 기록을 **되돌립니다**.
 *        쓰기 실패를 성공처럼 보여주면 사용자는 올라갔다고 믿지만
 *        서버에는 아무것도 남지 않습니다.
 */

import {
  DEFAULT_GALLERY_SORT,
  GALLERY_PAGE_SIZE,
  GALLERY_SORTS,
  MINI_CELL_SIZE,
} from "./config.js";
import { postLike, sortFeed } from "./api.js";
import { LikeStore } from "./likeStore.js";
import { drawMiniTree } from "./miniTreeRenderer.js";
import { formatCount, formatHours, formatRelativeTime } from "./statsRenderer.js";

export class GalleryRenderer {
  /**
   * @param {Object} refs
   * @param {HTMLElement} refs.grid 카드가 들어갈 컨테이너
   * @param {HTMLElement} refs.sortBar 정렬 버튼 컨테이너
   * @param {HTMLElement} refs.countLabel 총 개수 라벨
   * @param {HTMLButtonElement} refs.moreButton "더 보기"
   * @param {HTMLElement} [refs.statusLabel] 짧은 피드백 줄
   * @param {(seedId: string) => void} [refs.onOpenSeed] 카드의 "전적 보기"
   * @param {(user: Object) => void} [refs.onImportTree] 카드의 "앱에서 따라 그리기"
   */
  constructor(refs) {
    this.grid = refs.grid;
    this.sortBar = refs.sortBar;
    this.countLabel = refs.countLabel;
    this.moreButton = refs.moreButton;
    this.statusLabel = refs.statusLabel ?? null;
    this.onOpenSeed = typeof refs.onOpenSeed === "function" ? refs.onOpenSeed : null;
    this.onImportTree = typeof refs.onImportTree === "function" ? refs.onImportTree : null;

    this.likeStore = new LikeStore();

    /** @type {Array<Object>} 원본 피드 */
    this.users = [];
    this.sortId = DEFAULT_GALLERY_SORT;
    this.visibleCount = GALLERY_PAGE_SIZE;

    /** seedId → 카드 DOM. 좋아요 갱신 시 전체 재렌더를 피합니다. */
    this.cardIndex = new Map();

    this.#buildSortBar();
    this.#bindEvents();
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /**
   * 피드를 주입하고 다시 그립니다.
   * @param {Array<Object>} users
   */
  setUsers(users) {
    this.users = Array.isArray(users) ? users.slice() : [];
    this.visibleCount = GALLERY_PAGE_SIZE;
    this.render();
  }

  clear() {
    this.users = [];
    this.visibleCount = GALLERY_PAGE_SIZE;
    this.render();
  }

  setSort(sortId) {
    this.sortId = GALLERY_SORTS.some((s) => s.id === sortId)
      ? sortId
      : DEFAULT_GALLERY_SORT;
    this.visibleCount = GALLERY_PAGE_SIZE;
    this.#syncSortBar();
    this.render();
  }

  showMore() {
    this.visibleCount += GALLERY_PAGE_SIZE;
    this.render();
  }

  render() {
    const sorted = sortFeed(this.users, this.sortId);

    this.countLabel.textContent = formatCount(sorted.length, "명");
    this.grid.replaceChildren();
    this.cardIndex.clear();

    if (sorted.length === 0) {
      const empty = document.createElement("li");
      empty.className = "gallery-empty";
      empty.textContent = "아직 공개된 분재가 없습니다";
      this.grid.append(empty);
      this.moreButton.hidden = true;
      return;
    }

    const visible = sorted.slice(0, this.visibleCount);
    const fragment = document.createDocumentFragment();
    // 캔버스는 DOM 에 붙은 뒤에 그려야 하므로 (레이아웃/DPR 확정) 먼저
    // 카드를 모아 두고, append 후에 일괄로 그립니다.
    const pendingCanvases = [];

    for (const user of visible) {
      const { card, canvas } = this.#buildCard(user);
      fragment.append(card);
      this.cardIndex.set(normalizeSeed(user.seedId), card);
      pendingCanvases.push([canvas, user]);
    }

    this.grid.append(fragment);

    for (const [canvas, user] of pendingCanvases) {
      drawMiniTree(canvas, {
        dots: user.dots,
        cols: user.grid?.cols,
        rows: user.grid?.rows,
        cell: MINI_CELL_SIZE,
        groundColor: "rgba(255, 255, 255, 0.16)",
      });
    }

    const remaining = sorted.length - visible.length;
    this.moreButton.hidden = remaining <= 0;
    this.moreButton.textContent = `${formatCount(remaining, "명")} 더 보기`;
  }

  /* ─────────────────────────── 카드 ─────────────────────────── */

  #buildCard(user) {
    const seedId = normalizeSeed(user.seedId);
    const liked = this.likeStore.has(seedId);

    const card = document.createElement("li");
    card.className = "bonsai-card";
    card.dataset.seedId = seedId;

    // ── 썸네일 (미니 분재)
    const thumb = document.createElement("div");
    thumb.className = "bonsai-card__art";
    const canvas = document.createElement("canvas");
    canvas.className = "bonsai-card__canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute(
      "aria-label",
      `${user.nickname ?? seedId} 의 분재, 점 ${user.dotCount ?? user.dots?.length ?? 0}개`,
    );
    thumb.append(canvas);

    // 썸네일을 누르면 그 유저의 전적으로 이동
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "bonsai-card__open";
    openButton.dataset.action = "open";
    openButton.setAttribute("aria-label", `${user.nickname ?? seedId} 전적 보기`);
    thumb.append(openButton);

    // ── 본문
    const body = document.createElement("div");
    body.className = "bonsai-card__body";

    const title = document.createElement("span");
    title.className = "bonsai-card__name";
    title.textContent = user.nickname ?? seedId;

    const seedLabel = document.createElement("span");
    seedLabel.className = "bonsai-card__seed";
    seedLabel.textContent = seedId;

    const metrics = document.createElement("div");
    metrics.className = "bonsai-card__metrics";
    metrics.append(
      metricChip(formatHours(user.totalFocusSeconds)),
      metricChip(`Lv.${clampLevel(user.level)}`),
      metricChip(formatCount(user.dotCount ?? user.dots?.length ?? 0, "점")),
    );

    // 대표 카테고리 태그
    const tagRow = document.createElement("div");
    tagRow.className = "bonsai-card__tags";
    const primary = user.primaryCategory;
    if (primary) {
      const tag = document.createElement("span");
      tag.className = "category-tag";
      tag.style.setProperty("--tag-color", primary.colorHex ?? "#A8A29A");
      const dot = document.createElement("span");
      dot.className = "category-tag__dot";
      const label = document.createElement("span");
      label.textContent = primary.name ?? "미분류";
      tag.append(dot, label);
      tagRow.append(tag);
    }
    const synced = document.createElement("span");
    synced.className = "bonsai-card__synced";
    synced.textContent = formatRelativeTime(user.syncedAt);
    tagRow.append(synced);

    body.append(title, seedLabel, metrics, tagRow);

    // ── 좋아요
    const footer = document.createElement("div");
    footer.className = "bonsai-card__footer";

    const likeButton = document.createElement("button");
    likeButton.type = "button";
    likeButton.className = "like-button";
    likeButton.dataset.action = "like";
    likeButton.setAttribute("aria-pressed", String(liked));
    likeButton.disabled = liked;
    likeButton.title = liked ? "이미 좋아요를 눌렀어요" : "좋아요";
    likeButton.setAttribute("aria-label", liked ? "이미 좋아요를 눌렀어요" : "좋아요");
    likeButton.innerHTML =
      '<svg class="like-button__icon" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 21.35 10.55 20C5.4 15.36 2 12.28 2 8.5A5.5 5.5 0 0 1 12 5.09' +
      ' 5.5 5.5 0 0 1 22 8.5c0 3.78-3.4 6.86-8.55 11.5L12 21.35Z"/></svg>' +
      '<span class="like-button__count"></span>';
    likeButton.querySelector(".like-button__count").textContent = formatCount(
      user.likes ?? 0,
    );
    footer.append(likeButton);

    // 이 나무를 앱 스튜디오의 청사진으로 가져갑니다.
    if (this.onImportTree) {
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "icon-button icon-button--small";
      importButton.dataset.action = "import";
      importButton.title = "앱에서 따라 그리기";
      importButton.setAttribute(
        "aria-label",
        `${user.nickname ?? seedId} 나무를 앱에서 따라 그리기`,
      );
      importButton.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true">' +
        '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25Zm17.7-10.2a1 1 0 0 0 0-1.41' +
        'l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" fill="currentColor"/></svg>';
      footer.append(importButton);
    }

    const openLink = document.createElement("button");
    openLink.type = "button";
    openLink.className = "text-button";
    openLink.dataset.action = "open";
    openLink.textContent = "전적 보기";
    footer.append(openLink);

    card.append(thumb, body, footer);
    return { card, canvas };
  }

  /* ─────────────────────────── 좋아요 ─────────────────────────── */

  /**
   * 좋아요를 누릅니다. 낙관적으로 올리고, 실패하면 되돌립니다.
   * @param {string} seedId
   */
  async like(seedId) {
    const id = normalizeSeed(seedId);
    if (!id) return;

    // 1) 중복 차단 — 이 기기에서 이미 눌렀으면 무시합니다.
    if (this.likeStore.has(id)) {
      this.#status("이미 좋아요를 눌렀어요");
      return;
    }

    const user = this.users.find((u) => normalizeSeed(u.seedId) === id);
    if (!user) return;

    const previous = Number(user.likes ?? 0);

    // 2) 낙관적 반영 + 기록
    user.likes = previous + 1;
    this.likeStore.add(id);
    this.#paintLike(id, { likes: user.likes, liked: true, pending: true });

    // 3) 서버 반영
    const result = await postLike(id);

    if (result.ok) {
      // 서버 카운트로 교정 — 동시에 여러 명이 눌렀을 수 있습니다.
      if (typeof result.likes === "number") user.likes = result.likes;
      this.#paintLike(id, { likes: user.likes, liked: true, pending: false });
      this.#status("좋아요를 보냈어요");
    } else {
      // 롤백 — 숫자와 기록을 모두 원복합니다.
      user.likes = previous;
      this.likeStore.remove(id);
      this.#paintLike(id, { likes: previous, liked: false, pending: false });
      this.#status(`좋아요 실패: ${result.error}`);
    }
  }

  /**
   * 카드 하나의 좋아요 표시만 갱신합니다.
   *
   * 전체 재렌더를 하지 않는 이유: 인기순 정렬 중이라면 누른 카드가 그 자리에서
   * 위로 튀어 올라 사용자가 방금 누른 카드를 잃어버립니다. 순서는 다음
   * 렌더까지 유지하고 숫자만 바꿉니다.
   */
  #paintLike(seedId, { likes, liked, pending }) {
    const card = this.cardIndex.get(seedId);
    if (!card) return;

    const button = card.querySelector(".like-button");
    const count = card.querySelector(".like-button__count");
    if (count) count.textContent = formatCount(likes);
    if (!button) return;

    button.setAttribute("aria-pressed", String(liked));
    button.disabled = liked;
    button.classList.toggle("is-pending", Boolean(pending));
    const label = liked ? "이미 좋아요를 눌렀어요" : "좋아요";
    button.title = label;
    button.setAttribute("aria-label", label);

    if (liked && !pending) {
      // 하트가 한 번 튀는 피드백. 재생이 끝나면 클래스를 떼서
      // 다음 변경에도 다시 재생될 수 있게 합니다.
      button.classList.add("is-bumped");
      setTimeout(() => button.classList.remove("is-bumped"), 320);
    }
  }

  #status(message) {
    if (!this.statusLabel) return;
    this.statusLabel.textContent = message;
  }

  /* ─────────────────────────── 컨트롤 ─────────────────────────── */

  #buildSortBar() {
    const fragment = document.createDocumentFragment();
    GALLERY_SORTS.forEach((sort) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.sortId = sort.id;
      chip.setAttribute("aria-pressed", String(sort.id === this.sortId));
      chip.textContent = sort.label;
      fragment.append(chip);
    });
    this.sortBar.replaceChildren(fragment);
  }

  #syncSortBar() {
    this.sortBar.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.sortId === this.sortId));
    });
  }

  #bindEvents() {
    this.sortBar.addEventListener("click", (event) => {
      const chip = event.target.closest(".filter-chip");
      if (!chip) return;
      this.setSort(chip.dataset.sortId);
    });

    // 카드 액션은 그리드 한 곳에서 위임 처리합니다.
    // 카드가 수십 장이어도 리스너는 하나입니다.
    this.grid.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]");
      if (!action) return;
      const card = action.closest(".bonsai-card");
      if (!card) return;

      const seedId = card.dataset.seedId;
      if (action.dataset.action === "like") {
        this.like(seedId);
      } else if (action.dataset.action === "open" && this.onOpenSeed) {
        this.onOpenSeed(seedId);
      } else if (action.dataset.action === "import" && this.onImportTree) {
        const user = this.users.find((u) => normalizeSeed(u.seedId) === normalizeSeed(seedId));
        if (user) this.onImportTree(user);
      }
    });

    this.moreButton.addEventListener("click", () => this.showMore());
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function metricChip(text) {
  const span = document.createElement("span");
  span.className = "bonsai-card__metric";
  span.textContent = text;
  return span;
}

function normalizeSeed(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function clampLevel(level) {
  const n = Number(level);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 1;
}
