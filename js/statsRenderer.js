/**
 * statsRenderer.js — 10,000시간 숙련도 · 성장 단계 · 카테고리 분포 렌더링
 * 숫자 포맷터도 이 모듈에서 단일 소스로 관리합니다.
 */

import {
  DOT_TYPE,
  GROUND_ROW,
  MASTERY_TARGET_SECONDS,
  MILESTONE_STAGES,
  SECONDS_PER_HOUR,
} from "./config.js";

/* ──────────────────────────── Formatters ──────────────────────────── */

const numberFormat = new Intl.NumberFormat("ko-KR");
const decimalFormat = new Intl.NumberFormat("ko-KR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const dateFormat = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "short",
  day: "numeric",
});
const relativeFormat = new Intl.RelativeTimeFormat("ko-KR", { numeric: "auto" });

/** 안전한 숫자 변환 */
export function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 초 → "1,224시간 20분" / "38분" / "12초" */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(toFiniteNumber(seconds)));
  if (total === 0) return "0분";

  const hours = Math.floor(total / SECONDS_PER_HOUR);
  const minutes = Math.floor((total % SECONDS_PER_HOUR) / 60);

  if (hours > 0) {
    return minutes > 0
      ? `${numberFormat.format(hours)}시간 ${minutes}분`
      : `${numberFormat.format(hours)}시간`;
  }
  if (minutes > 0) return `${minutes}분`;
  return `${total}초`;
}

/** 초 → "1,224시간" (시 단위 반올림 내림) */
export function formatHours(seconds) {
  const hours = Math.floor(Math.max(0, toFiniteNumber(seconds)) / SECONDS_PER_HOUR);
  return `${numberFormat.format(hours)}시간`;
}

/** 초 → 시(실수) */
export function toHours(seconds) {
  return Math.max(0, toFiniteNumber(seconds)) / SECONDS_PER_HOUR;
}

/** 0.00 형식 퍼센트 문자열 */
export function formatPercent(percent) {
  return `${decimalFormat.format(Math.max(0, toFiniteNumber(percent)))}%`;
}

/** ISO 문자열 → "2025. 10. 21." */
export function formatDate(isoString) {
  if (!isoString) return "—";
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "—";
  return dateFormat.format(date);
}

/** ISO 문자열 → "3분 전" / "2일 전" (OP.GG 갱신 표시용) */
export function formatRelativeTime(isoString, now = Date.now()) {
  if (!isoString) return "—";
  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) return "—";

  const diffSeconds = Math.round((timestamp - now) / 1000);
  const absolute = Math.abs(diffSeconds);

  if (absolute < 10) return "방금";
  if (absolute < 60) return relativeFormat.format(Math.round(diffSeconds), "second");
  if (absolute < 3600) return relativeFormat.format(Math.round(diffSeconds / 60), "minute");
  if (absolute < 86400) return relativeFormat.format(Math.round(diffSeconds / 3600), "hour");
  if (absolute < 2_592_000) return relativeFormat.format(Math.round(diffSeconds / 86400), "day");
  if (absolute < 31_536_000)
    return relativeFormat.format(Math.round(diffSeconds / 2_592_000), "month");
  return relativeFormat.format(Math.round(diffSeconds / 31_536_000), "year");
}

/** 숫자에 천 단위 구분 */
export function formatCount(value, unit = "") {
  const n = Math.max(0, Math.round(toFiniteNumber(value)));
  return unit ? `${numberFormat.format(n)}${unit}` : numberFormat.format(n);
}

/* ──────────────────────────── Domain helpers ──────────────────────────── */

/** globalFocusSeconds → 10,000시간 대비 진행률(%) */
export function calculateMasteryPercent(globalFocusSeconds) {
  const seconds = Math.max(0, toFiniteNumber(globalFocusSeconds));
  return (seconds / MASTERY_TARGET_SECONDS) * 100;
}

/**
 * 누적 시간(hours)에 해당하는 성장 단계를 찾습니다.
 * stageId 가 주어지면 그 단계를 우선합니다.
 * @returns {{stage: object, index: number, total: number}}
 */
export function resolveMilestone(hours, stageId = null) {
  const total = MILESTONE_STAGES.length;

  if (stageId) {
    const forcedIndex = MILESTONE_STAGES.findIndex((s) => s.id === stageId);
    if (forcedIndex >= 0) {
      return { stage: MILESTONE_STAGES[forcedIndex], index: forcedIndex, total };
    }
  }

  let index = 0;
  for (let i = 0; i < total; i += 1) {
    if (hours >= MILESTONE_STAGES[i].minHours) index = i;
  }
  return { stage: MILESTONE_STAGES[index], index, total };
}

/** 아직 도달하지 않은 다음 단계 (마지막 단계면 null) */
export function findNextStage(hours) {
  return MILESTONE_STAGES.find((stage) => hours < stage.minHours) ?? null;
}

/* ──────────────────────────── Aggregation ──────────────────────────── */

/**
 * 트리 한 건을 요약 통계로 집계합니다.
 * 요약 스탯 · 카테고리 테이블 · 기록 리스트가 모두 이 결과를 공유합니다.
 */
export function aggregateTree(tree) {
  const dots = Array.isArray(tree?.dots) ? tree.dots : [];
  const declared = Array.isArray(tree?.categories) ? tree.categories : [];

  const growthDots = dots.filter(
    (dot) => dot.type !== DOT_TYPE.WEED && dot.type !== DOT_TYPE.SEED,
  );
  const weedDots = dots.filter((dot) => dot.type === DOT_TYPE.WEED);
  const weedCount = weedDots.reduce(
    (sum, dot) => sum + Math.max(1, Math.round(toFiniteNumber(dot.count, 1))),
    0,
  );

  const focusValues = growthDots.map((dot) => Math.max(0, toFiniteNumber(dot.focusSeconds)));
  const dotFocusTotal = focusValues.reduce((sum, value) => sum + value, 0);
  const maxFocusSeconds = focusValues.length > 0 ? Math.max(...focusValues) : 0;
  const avgFocusSeconds = focusValues.length > 0 ? dotFocusTotal / focusValues.length : 0;

  // 나무 높이: 지면(y=31)부터 가장 높은 점까지
  const topRow = growthDots.length > 0 ? Math.min(...growthDots.map((dot) => dot.y)) : GROUND_ROW;
  const treeHeight = Math.max(0, GROUND_ROW - topRow);

  // 카테고리별 집계 (선언된 카테고리 기준 + 점 개수 합산)
  const dotStats = new Map();
  for (const dot of growthDots) {
    const key = dot.categoryId ? String(dot.categoryId) : "uncategorized";
    const entry = dotStats.get(key) ?? { dotCount: 0, dotFocusSeconds: 0 };
    entry.dotCount += 1;
    entry.dotFocusSeconds += Math.max(0, toFiniteNumber(dot.focusSeconds));
    dotStats.set(key, entry);
  }

  const categoryTotal = declared.reduce(
    (sum, category) => sum + Math.max(0, toFiniteNumber(category.focusSeconds)),
    0,
  );

  const categories = declared
    .map((category) => {
      const id = String(category.id);
      const stats = dotStats.get(id) ?? { dotCount: 0, dotFocusSeconds: 0 };
      const focusSeconds = Math.max(0, toFiniteNumber(category.focusSeconds));
      return {
        id,
        name: String(category.name ?? "미분류"),
        colorHex: normalizeHex(category.colorHex),
        /** 카테고리 누적 집중 시간 (앱이 집계한 값) */
        focusSeconds,
        dotCount: stats.dotCount,
        /** 이 카테고리에 속한 점들의 집중 시간 합 */
        dotFocusSeconds: stats.dotFocusSeconds,
        /** 점 1개당 평균 집중 시간 */
        avgDotFocusSeconds: stats.dotCount > 0 ? stats.dotFocusSeconds / stats.dotCount : 0,
        share: categoryTotal > 0 ? (focusSeconds / categoryTotal) * 100 : 0,
      };
    })
    .sort((a, b) => b.focusSeconds - a.focusSeconds);

  return {
    dots,
    growthDots,
    weedDots,
    weedCount,
    dotCount: growthDots.length,
    dotFocusTotal,
    maxFocusSeconds,
    avgFocusSeconds,
    treeHeight,
    categoryTotal,
    categories,
    sessionCount: Math.max(0, toFiniteNumber(tree?.sessionCount)),
    longestStreakDays: Math.max(0, toFiniteNumber(tree?.longestStreakDays)),
  };
}

/* ──────────────────────────── Renderer ──────────────────────────── */

export class StatsRenderer {
  /**
   * @param {Object} elements 렌더 대상 DOM 요소 묶음
   */
  constructor(elements) {
    this.el = elements;
    this.#buildMilestoneTrack();
  }

  /** 트리 전체를 반영 */
  render(tree) {
    const summary = aggregateTree(tree);
    this.renderMastery(tree.globalFocusSeconds);
    this.renderMilestone(tree.globalFocusSeconds, tree.milestone?.stageId ?? null);
    this.renderBreakdown(tree.categories);
    this.renderSummary(tree, summary);
    this.renderCategoryTable(summary);
  }

  /** 비어 있는 상태 */
  clear() {
    const empty = aggregateTree({ dots: [], categories: [] });
    this.renderMastery(0);
    this.renderMilestone(0, "seed");
    this.renderBreakdown([]);
    this.renderSummary({ globalFocusSeconds: 0 }, empty);
    this.renderCategoryTable(empty);
  }

  /* ── 요약 스탯 그리드 (OP.GG 전적 요약) ──────────────────────────────── */
  renderSummary(tree, summary = aggregateTree(tree)) {
    if (!this.el.summaryGrid) return;

    const nextStage = findNextStage(toHours(tree.globalFocusSeconds));
    const remainingToNext = nextStage
      ? formatHours(nextStage.minHours * SECONDS_PER_HOUR - toFiniteNumber(tree.globalFocusSeconds))
      : "달성 완료";

    const cells = [
      { label: "기록된 점", value: formatCount(summary.dotCount, "개") },
      { label: "누적 세션", value: formatCount(summary.sessionCount, "회") },
      { label: "평균 집중", value: formatDuration(summary.avgFocusSeconds) },
      { label: "최고 집중", value: formatDuration(summary.maxFocusSeconds) },
      { label: "나무 높이", value: formatCount(summary.treeHeight, "칸") },
      { label: "최장 연속", value: formatCount(summary.longestStreakDays, "일") },
      { label: "잡초", value: formatCount(summary.weedCount, "개") },
      { label: `다음 단계까지`, value: remainingToNext },
    ];

    const fragment = document.createDocumentFragment();
    cells.forEach((cell) => {
      const item = document.createElement("div");
      item.className = "summary-grid__item";

      const dt = document.createElement("dt");
      dt.className = "summary-grid__label";
      dt.textContent = cell.label;

      const dd = document.createElement("dd");
      dd.className = "summary-grid__value";
      dd.textContent = cell.value;

      item.append(dt, dd);
      fragment.append(item);
    });

    this.el.summaryGrid.replaceChildren(fragment);
  }

  /* ── 카테고리 테이블 (OP.GG 챔피언 전적) ─────────────────────────────── */
  renderCategoryTable(summary) {
    if (!this.el.categoryTableBody) return;

    this.el.categoryTableBody.replaceChildren();

    if (summary.categories.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "data-table__empty";
      cell.textContent = "표시할 카테고리가 없습니다";
      row.append(cell);
      this.el.categoryTableBody.append(row);
      return;
    }

    const fragment = document.createDocumentFragment();
    /** @type {Array<[HTMLElement, number]>} */
    const pendingWidths = [];

    summary.categories.forEach((category, index) => {
      const row = document.createElement("tr");
      row.dataset.categoryId = category.id;

      // 카테고리 (순위 + 색 점 + 이름)
      const nameCell = document.createElement("td");
      nameCell.className = "data-table__name";
      const rank = document.createElement("span");
      rank.className = "data-table__rank";
      rank.textContent = String(index + 1);
      const dot = document.createElement("span");
      dot.className = "data-table__dot";
      dot.style.backgroundColor = category.colorHex;
      const name = document.createElement("span");
      name.textContent = category.name;
      nameCell.append(rank, dot, name);

      const countCell = document.createElement("td");
      countCell.className = "data-table__num";
      countCell.textContent = formatCount(category.dotCount, "개");

      const totalCell = document.createElement("td");
      totalCell.className = "data-table__num";
      totalCell.textContent = formatHours(category.focusSeconds);

      const avgCell = document.createElement("td");
      avgCell.className = "data-table__num";
      avgCell.textContent =
        category.dotCount > 0 ? formatDuration(category.avgDotFocusSeconds) : "—";

      // 비중 (막대 + %)
      const shareCell = document.createElement("td");
      shareCell.className = "data-table__share";
      const gauge = document.createElement("span");
      gauge.className = "gauge";
      const gaugeFill = document.createElement("span");
      gaugeFill.className = "gauge__fill";
      gaugeFill.style.backgroundColor = category.colorHex;
      gauge.append(gaugeFill);
      const shareText = document.createElement("span");
      shareText.className = "data-table__share-value";
      shareText.textContent = formatPercent(category.share);
      shareCell.append(gauge, shareText);
      pendingWidths.push([gaugeFill, category.share]);

      row.append(nameCell, countCell, totalCell, avgCell, shareCell);
      fragment.append(row);
    });

    this.el.categoryTableBody.append(fragment);
    applyWidths(this.el.categoryTableBody, pendingWidths);
  }

  /* ── 10,000시간 ─────────────────────────────────────────────────────── */
  renderMastery(globalFocusSeconds) {
    const seconds = Math.max(0, toFiniteNumber(globalFocusSeconds));
    const percent = calculateMasteryPercent(seconds);
    const clamped = Math.min(100, percent);
    const remaining = Math.max(0, MASTERY_TARGET_SECONDS - seconds);

    this.el.masteryPercent.textContent = formatPercent(percent);
    this.el.masteryFill.style.width = `${clamped}%`;
    this.el.masteryHours.textContent = formatHours(seconds);
    this.el.masteryRemaining.textContent = formatHours(remaining);
    this.el.masteryProgress.setAttribute("aria-valuenow", clamped.toFixed(2));
    this.el.masteryProgress.setAttribute(
      "aria-valuetext",
      `${formatHours(seconds)} / 10,000시간 (${formatPercent(percent)})`,
    );
  }

  /* ── 성장 단계 ──────────────────────────────────────────────────────── */
  renderMilestone(globalFocusSeconds, stageId = null) {
    const hours = toHours(globalFocusSeconds);
    const { stage, index, total } = resolveMilestone(hours, stageId);

    this.el.phaseLabel.textContent = stage.label;
    this.el.phaseDesc.textContent = stage.desc;
    this.el.phasePill.setAttribute("title", `${index + 1} / ${total} 단계`);

    const steps = this.el.milestoneTrack.children;
    for (let i = 0; i < steps.length; i += 1) {
      steps[i].classList.toggle("is-reached", i <= index);
      steps[i].classList.toggle("is-current", i === index);
    }
  }

  /* ── 카테고리 분포 ──────────────────────────────────────────────────── */
  renderBreakdown(categories) {
    const list = Array.isArray(categories) ? categories.slice() : [];
    const normalized = list
      .map((c) => ({
        id: String(c?.id ?? ""),
        name: String(c?.name ?? "미분류"),
        colorHex: normalizeHex(c?.colorHex),
        focusSeconds: Math.max(0, toFiniteNumber(c?.focusSeconds)),
      }))
      .filter((c) => c.focusSeconds > 0)
      .sort((a, b) => b.focusSeconds - a.focusSeconds);

    const total = normalized.reduce((sum, c) => sum + c.focusSeconds, 0);

    this.el.breakdownTotal.textContent = formatHours(total);
    this.el.stackBar.replaceChildren();
    this.el.chipList.replaceChildren();

    if (total === 0) {
      const empty = document.createElement("li");
      empty.className = "chip chip--empty";
      empty.textContent = "기록된 카테고리가 없습니다";
      this.el.chipList.append(empty);
      return;
    }

    const barFragment = document.createDocumentFragment();
    const chipFragment = document.createDocumentFragment();
    /** @type {Array<[HTMLElement, number]>} 삽입 후 한 번에 적용할 목표 폭 */
    const pendingWidths = [];

    normalized.forEach((category) => {
      const share = (category.focusSeconds / total) * 100;

      const segment = document.createElement("div");
      segment.className = "stack-bar__segment";
      segment.dataset.categoryId = category.id;
      segment.style.backgroundColor = category.colorHex;
      segment.title = `${category.name} ${formatPercent(share)}`;
      barFragment.append(segment);
      pendingWidths.push([segment, share]);

      const chip = document.createElement("li");
      chip.className = "chip";
      chip.dataset.categoryId = category.id;
      chip.style.setProperty("--chip-color", category.colorHex);
      chip.innerHTML =
        '<span class="chip__dot" aria-hidden="true"></span>' +
        `<span class="chip__name"></span><span class="chip__value"></span>`;
      chip.querySelector(".chip__name").textContent = category.name;
      chip.querySelector(".chip__value").textContent =
        `${formatHours(category.focusSeconds)} · ${formatPercent(share)}`;
      chipFragment.append(chip);
    });

    this.el.stackBar.append(barFragment);
    this.el.chipList.append(chipFragment);
    applyWidths(this.el.stackBar, pendingWidths);
  }

  /* ── private ────────────────────────────────────────────────────────── */
  #buildMilestoneTrack() {
    const fragment = document.createDocumentFragment();
    MILESTONE_STAGES.forEach((stage, i) => {
      const step = document.createElement("li");
      step.className = "milestone-track__step";
      step.title = `${stage.label} · ${numberFormat.format(stage.minHours)}시간`;
      if (i === 0) step.classList.add("is-reached", "is-current");
      fragment.append(step);
    });
    this.el.milestoneTrack.replaceChildren(fragment);
  }
}

/**
 * 삽입이 끝난 요소들에 목표 폭을 적용합니다.
 *
 * 한 번 강제 리플로우를 발생시켜 브라우저가 "폭 0" 상태를 확정하게 만든 뒤
 * 최종 폭을 대입하므로, requestAnimationFrame 없이도 CSS 트랜지션이 재생됩니다.
 * (rAF 에 의존하면 백그라운드 탭·headless 환경에서 폭이 0 으로 남습니다.)
 *
 * @param {HTMLElement} container 리플로우 기준 컨테이너
 * @param {Array<[HTMLElement, number]>} entries [요소, 퍼센트] 쌍
 */
export function applyWidths(container, entries) {
  if (entries.length === 0) return;
  void container.offsetWidth; // 강제 리플로우 (트랜지션 시작점 확정)
  entries.forEach(([element, percent]) => {
    element.style.width = `${Math.max(0, Math.min(100, toFiniteNumber(percent)))}%`;
  });
}

/** #RGB / #RRGGBB 검증 후 정규화 */
export function normalizeHex(value, fallback = "#8D8880") {
  if (typeof value !== "string") return fallback;
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase();
  return fallback;
}
