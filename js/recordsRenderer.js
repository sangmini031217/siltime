/**
 * recordsRenderer.js — 기록 탭 (OP.GG 전적 리스트 패턴)
 *
 *  - 카테고리 필터 칩 + 정렬 셀렉트 + "더 보기" 페이지네이션
 *  - 각 행은 카테고리 색 바 · 좌표 · 집중시간 · 상대 길이 게이지로 구성됩니다.
 *  - 행을 누르면 onSelect 콜백으로 캔버스의 해당 좌표를 지목합니다.
 */

import {
  DOT_TYPE,
  DOT_TYPE_LABEL,
  FILTER_ALL,
  FILTER_WEED,
  PALETTE,
  RECORD_PAGE_SIZE,
  RECORD_SORTS,
  DEFAULT_SORT_ID,
} from "./config.js";
import {
  applyWidths,
  formatCount,
  formatDate,
  formatDuration,
  normalizeHex,
  toFiniteNumber,
} from "./statsRenderer.js";

export class RecordsRenderer {
  /**
   * @param {Object} refs
   * @param {HTMLElement} refs.list        <ol> 기록 리스트
   * @param {HTMLElement} refs.countLabel  총 개수 라벨
   * @param {HTMLElement} refs.filterBar   필터 칩 컨테이너
   * @param {HTMLSelectElement} refs.sortSelect
   * @param {HTMLButtonElement} refs.moreButton
   * @param {(dot:object) => void} [refs.onSelect]
   */
  constructor(refs) {
    this.list = refs.list;
    this.countLabel = refs.countLabel;
    this.filterBar = refs.filterBar;
    this.sortSelect = refs.sortSelect;
    this.moreButton = refs.moreButton;
    this.onSelect = typeof refs.onSelect === "function" ? refs.onSelect : null;

    /** 종합 탭의 "최근 기록" 미리보기 (없으면 생략) */
    this.previewList = refs.previewList ?? null;
    this.previewLimit = Number.isFinite(refs.previewLimit) ? refs.previewLimit : 5;

    /** @type {Array<object>} */
    this.records = [];
    this.categoryMap = new Map();
    this.filterId = FILTER_ALL;
    this.sortId = DEFAULT_SORT_ID;
    this.visibleCount = RECORD_PAGE_SIZE;

    this.#buildSortOptions();
    this.#bindEvents();
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  setTree(tree) {
    const categories = Array.isArray(tree?.categories) ? tree.categories : [];
    this.categoryMap = new Map(
      categories.map((category) => [
        String(category.id),
        { name: String(category.name ?? "미분류"), colorHex: normalizeHex(category.colorHex) },
      ]),
    );

    // 씨앗은 기록이 아니라 기준점이므로 제외
    this.records = (Array.isArray(tree?.dots) ? tree.dots : [])
      .filter((dot) => dot.type !== DOT_TYPE.SEED)
      .map((dot) => ({ ...dot }));

    this.filterId = FILTER_ALL;
    this.visibleCount = RECORD_PAGE_SIZE;
    this.#buildFilterChips(categories);
    this.render();
    this.renderPreview();
  }

  clear() {
    this.records = [];
    this.categoryMap.clear();
    this.filterId = FILTER_ALL;
    this.visibleCount = RECORD_PAGE_SIZE;
    this.#buildFilterChips([]);
    this.render();
    this.renderPreview();
  }

  /** 종합 탭용: 최신 기록 상위 N개만 렌더 (필터·정렬 영향 없음) */
  renderPreview() {
    if (!this.previewList) return;

    const latest = this.#sortByRecent(this.records).slice(0, this.previewLimit);
    const maxFocus = latest.reduce(
      (max, record) => Math.max(max, toFiniteNumber(record.focusSeconds)),
      0,
    );

    this.previewList.replaceChildren();

    if (latest.length === 0) {
      const empty = document.createElement("li");
      empty.className = "record record--empty";
      empty.textContent = "표시할 기록이 없습니다";
      this.previewList.append(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    /** @type {Array<[HTMLElement, number]>} */
    const pendingWidths = [];
    latest.forEach((record) => fragment.append(this.#buildRow(record, maxFocus, pendingWidths)));
    this.previewList.append(fragment);
    applyWidths(this.previewList, pendingWidths);
  }

  setFilter(filterId) {
    this.filterId = filterId;
    this.visibleCount = RECORD_PAGE_SIZE;
    this.#syncFilterChips();
    this.render();
  }

  setSort(sortId) {
    this.sortId = RECORD_SORTS.some((sort) => sort.id === sortId) ? sortId : DEFAULT_SORT_ID;
    this.visibleCount = RECORD_PAGE_SIZE;
    this.render();
  }

  showMore() {
    this.visibleCount += RECORD_PAGE_SIZE;
    this.render();
  }

  render() {
    const filtered = this.#sortRecords(this.#filterRecords());
    const maxFocus = filtered.reduce(
      (max, record) => Math.max(max, toFiniteNumber(record.focusSeconds)),
      0,
    );

    this.countLabel.textContent = formatCount(filtered.length, "개");
    this.list.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement("li");
      empty.className = "record record--empty";
      empty.textContent = "조건에 맞는 기록이 없습니다";
      this.list.append(empty);
      this.moreButton.hidden = true;
      return;
    }

    const visible = filtered.slice(0, this.visibleCount);
    const fragment = document.createDocumentFragment();
    /** @type {Array<[HTMLElement, number]>} */
    const pendingWidths = [];
    visible.forEach((record) => fragment.append(this.#buildRow(record, maxFocus, pendingWidths)));
    this.list.append(fragment);
    applyWidths(this.list, pendingWidths);

    const remaining = filtered.length - visible.length;
    this.moreButton.hidden = remaining <= 0;
    this.moreButton.textContent = `${formatCount(remaining, "개")} 더 보기`;
  }

  /* ─────────────────────────── Row ─────────────────────────── */

  #buildRow(record, maxFocus, pendingWidths) {
    const isWeed = record.type === DOT_TYPE.WEED;
    const category = record.categoryId ? this.categoryMap.get(String(record.categoryId)) : null;
    const color = isWeed
      ? PALETTE.weed
      : normalizeHex(record.colorHex, category?.colorHex ?? PALETTE.branch);

    const item = document.createElement("li");
    item.className = `record${isWeed ? " record--weed" : ""}`;
    item.style.setProperty("--record-color", color);
    item.dataset.x = String(record.x);
    item.dataset.y = String(record.y);

    const button = document.createElement("button");
    button.className = "record__button";
    button.type = "button";

    const bar = document.createElement("span");
    bar.className = "record__bar";
    bar.setAttribute("aria-hidden", "true");

    const main = document.createElement("span");
    main.className = "record__main";

    const title = document.createElement("span");
    title.className = "record__title";
    const typeLabel = DOT_TYPE_LABEL[record.type] ?? "점";
    if (isWeed) {
      const count = Math.max(1, Math.round(toFiniteNumber(record.count, 1)));
      title.textContent = `${typeLabel} · ${formatCount(count, "개")}`;
    } else {
      title.textContent = category ? `${category.name} · ${typeLabel}` : typeLabel;
    }

    const meta = document.createElement("span");
    meta.className = "record__meta";
    meta.textContent = `x ${record.x} · y ${record.y} · ${formatDate(record.createdAt)}`;

    main.append(title, meta);

    const stat = document.createElement("span");
    stat.className = "record__stat";

    const focus = document.createElement("span");
    focus.className = "record__focus";
    focus.textContent = isWeed ? "집중 없음" : formatDuration(record.focusSeconds);

    const gauge = document.createElement("span");
    gauge.className = "gauge gauge--sm";
    const gaugeFill = document.createElement("span");
    gaugeFill.className = "gauge__fill";
    gaugeFill.style.backgroundColor = color;
    gauge.append(gaugeFill);

    const ratio =
      !isWeed && maxFocus > 0 ? (toFiniteNumber(record.focusSeconds) / maxFocus) * 100 : 0;
    pendingWidths.push([gaugeFill, ratio]);

    stat.append(focus, gauge);
    button.append(bar, main, stat);
    item.append(button);

    if (this.onSelect) {
      button.addEventListener("click", () => this.onSelect(record));
    }

    return item;
  }

  /* ─────────────────────────── Filter / Sort ─────────────────────────── */

  #filterRecords() {
    if (this.filterId === FILTER_ALL) return this.records.slice();
    if (this.filterId === FILTER_WEED) {
      return this.records.filter((record) => record.type === DOT_TYPE.WEED);
    }
    return this.records.filter(
      (record) => record.type !== DOT_TYPE.WEED && String(record.categoryId) === this.filterId,
    );
  }

  #sortRecords(records) {
    const sorted = records.slice();
    switch (this.sortId) {
      case "focus":
        sorted.sort(
          (a, b) => toFiniteNumber(b.focusSeconds) - toFiniteNumber(a.focusSeconds),
        );
        break;
      case "height":
        // y 가 작을수록 높은 위치
        sorted.sort((a, b) => a.y - b.y || a.x - b.x);
        break;
      case "recent":
      default:
        return this.#sortByRecent(sorted);
    }
    return sorted;
  }

  #sortByRecent(records) {
    return records.slice().sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));
  }

  /* ─────────────────────────── Controls ─────────────────────────── */

  #buildSortOptions() {
    const fragment = document.createDocumentFragment();
    RECORD_SORTS.forEach((sort) => {
      const option = document.createElement("option");
      option.value = sort.id;
      option.textContent = sort.label;
      fragment.append(option);
    });
    this.sortSelect.replaceChildren(fragment);
    this.sortSelect.value = this.sortId;
  }

  #buildFilterChips(categories) {
    const definitions = [
      { id: FILTER_ALL, label: "전체", colorHex: null },
      ...categories.map((category) => ({
        id: String(category.id),
        label: String(category.name ?? "미분류"),
        colorHex: normalizeHex(category.colorHex),
      })),
      { id: FILTER_WEED, label: "잡초", colorHex: PALETTE.weed },
    ];

    const fragment = document.createDocumentFragment();
    definitions.forEach((definition) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "filter-chip";
      chip.dataset.filterId = definition.id;
      chip.setAttribute("aria-pressed", String(definition.id === this.filterId));

      if (definition.colorHex) {
        const dot = document.createElement("span");
        dot.className = "filter-chip__dot";
        dot.style.backgroundColor = definition.colorHex;
        chip.append(dot);
      }
      const label = document.createElement("span");
      label.textContent = definition.label;
      chip.append(label);

      fragment.append(chip);
    });

    this.filterBar.replaceChildren(fragment);
  }

  #syncFilterChips() {
    this.filterBar.querySelectorAll(".filter-chip").forEach((chip) => {
      chip.setAttribute("aria-pressed", String(chip.dataset.filterId === this.filterId));
    });
  }

  #bindEvents() {
    this.filterBar.addEventListener("click", (event) => {
      const chip = event.target.closest(".filter-chip");
      if (!chip) return;
      this.setFilter(chip.dataset.filterId);
    });

    this.sortSelect.addEventListener("change", () => this.setSort(this.sortSelect.value));
    this.moreButton.addEventListener("click", () => this.showMore());
  }
}

function parseTime(isoString) {
  const time = Date.parse(isoString ?? "");
  return Number.isNaN(time) ? 0 : time;
}
