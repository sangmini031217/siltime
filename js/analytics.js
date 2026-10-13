/**
 * analytics.js — OP.GG 형 랭킹 & 학습 패턴 분석
 *
 * 세 가지를 그립니다.
 *   1. 리더보드 — 누적 집중 시간 순위 테이블
 *   2. 백분위 — 조회한 유저가 전체에서 어디쯤인지 게이지로
 *   3. 전역 트렌드 — 카테고리 점유율 바 + 일일 평균 비교
 *
 * 차트 라이브러리를 쓰지 않습니다. 점유율 바는 flex + width %,
 * 비교 그래프는 인라인 SVG 입니다. 둘 다 수십 바이트짜리 DOM 이라서
 * 로딩이 사실상 공짜이고, 테마 변수를 그대로 상속받습니다.
 */

import { LEADERBOARD_LIMIT } from "./config.js";
import {
  applyWidths,
  formatCount,
  formatDuration,
  formatHours,
  formatPercent,
  normalizeHex,
  resolveMilestone,
  toFiniteNumber,
  toHours,
} from "./statsRenderer.js";

export class AnalyticsRenderer {
  /**
   * @param {Object} refs
   * @param {HTMLElement} refs.leaderboardBody 리더보드 <tbody>
   * @param {HTMLElement} refs.globalSummary 전역 요약 그리드
   * @param {HTMLElement} refs.categoryShare 카테고리 점유율 리스트
   * @param {HTMLElement} refs.percentileCard 백분위 카드 래퍼
   * @param {HTMLElement} refs.percentileValue 상위 X% 텍스트
   * @param {HTMLElement} refs.percentileRank "N명 중 M위"
   * @param {HTMLElement} refs.percentileFill 게이지 채움
   * @param {HTMLElement} refs.percentileMarker 게이지 마커
   * @param {HTMLElement} refs.comparisonChart 일일 평균 비교 SVG 컨테이너
   * @param {HTMLElement} refs.comparisonCaption 비교 캡션
   * @param {(seedId: string) => void} [refs.onOpenSeed]
   */
  constructor(refs) {
    this.el = refs;
    this.onOpenSeed = typeof refs.onOpenSeed === "function" ? refs.onOpenSeed : null;

    /** @type {Array<Object>} */
    this.users = [];
    /** @type {Object|null} */
    this.stats = null;
    /** 현재 조회 중인 트리 (백분위 비교 대상) */
    this.currentTree = null;

    this.#bindEvents();
  }

  /* ─────────────────────────── Public API ─────────────────────────── */

  /** 피드와 전역 통계를 주입하고 전부 다시 그립니다. */
  setData({ users, stats }) {
    this.users = Array.isArray(users) ? users.slice() : [];
    this.stats = stats ?? null;
    this.renderLeaderboard();
    this.renderGlobalSummary();
    this.renderCategoryShare();
    this.renderPercentile(this.currentTree);
    this.renderComparison(this.currentTree);
  }

  /**
   * 조회된 트리를 교체합니다.
   *
   * 리더보드까지 다시 그립니다. `is-current` 하이라이트가 행에 박혀 있어서,
   * 백분위만 갱신하면 "내 행" 표시가 이전에 조회한 유저에 그대로 남습니다.
   */
  setCurrentTree(tree) {
    this.currentTree = tree ?? null;
    this.renderLeaderboard();
    this.renderPercentile(this.currentTree);
    this.renderComparison(this.currentTree);
    // 카테고리 점유율에는 "내 비중 vs 전체" 캡션이 붙으므로 함께 갱신합니다.
    this.renderCategoryShare();
  }

  /* ─────────────────────────── 1. 리더보드 ─────────────────────────── */

  renderLeaderboard() {
    const body = this.el.leaderboardBody;
    if (!body) return;

    const ranked = this.rankedUsers().slice(0, LEADERBOARD_LIMIT);
    body.replaceChildren();

    if (ranked.length === 0) {
      body.append(emptyRow(5, "표시할 유저가 없습니다"));
      return;
    }

    const fragment = document.createDocumentFragment();

    ranked.forEach((user, index) => {
      const rank = index + 1;
      const row = document.createElement("tr");
      row.dataset.seedId = String(user.seedId ?? "");
      row.className = "leaderboard__row";
      if (this.#isCurrent(user)) row.classList.add("is-current");

      // 순위 — 1~3위는 메달 톤으로 구분
      const rankCell = document.createElement("td");
      rankCell.className = "leaderboard__rank";
      const badge = document.createElement("span");
      badge.className = `rank-badge rank-badge--${rank <= 3 ? rank : "plain"}`;
      badge.textContent = String(rank);
      rankCell.append(badge);

      // 닉네임 + Seed ID
      const nameCell = document.createElement("td");
      nameCell.className = "leaderboard__name";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "leaderboard__open";
      open.dataset.action = "open";
      const nick = document.createElement("span");
      nick.className = "leaderboard__nick";
      nick.textContent = String(user.nickname ?? user.seedId ?? "익명");
      const seed = document.createElement("span");
      seed.className = "leaderboard__seed";
      seed.textContent = String(user.seedId ?? "—");
      open.append(nick, seed);
      nameCell.append(open);

      // 누적 시간
      const hoursCell = document.createElement("td");
      hoursCell.className = "data-table__num";
      hoursCell.textContent = formatHours(user.totalFocusSeconds);

      // 단계 배지 — iOS 의 식물학적 성장 단계와 같은 테이블
      const phaseCell = document.createElement("td");
      const { stage } = resolveMilestone(toHours(user.totalFocusSeconds));
      const phasePill = document.createElement("span");
      phasePill.className = "phase-pill phase-pill--quiet";
      phasePill.textContent = stage.label;
      phaseCell.append(phasePill);

      // 좋아요
      const likeCell = document.createElement("td");
      likeCell.className = "data-table__num";
      likeCell.textContent = formatCount(user.likes ?? 0);

      row.append(rankCell, nameCell, hoursCell, phaseCell, likeCell);
      fragment.append(row);
    });

    body.append(fragment);
  }

  /* ─────────────────────────── 2. 전역 요약 ─────────────────────────── */

  renderGlobalSummary() {
    const grid = this.el.globalSummary;
    if (!grid) return;

    const stats = this.stats;
    const cells = [
      { label: "참여 유저", value: formatCount(stats?.userCount ?? this.users.length, "명") },
      { label: "전체 누적", value: formatHours(stats?.totalFocusSeconds) },
      { label: "유저 평균", value: formatHours(stats?.averageFocusSeconds) },
      { label: "일일 평균", value: formatDuration(stats?.averageDailySeconds) },
    ];

    const fragment = document.createDocumentFragment();
    for (const cell of cells) {
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
    }
    grid.replaceChildren(fragment);
  }

  /* ─────────────────────────── 3. 카테고리 점유율 ─────────────────────────── */

  renderCategoryShare() {
    const host = this.el.categoryShare;
    if (!host) return;

    const share = Array.isArray(this.stats?.categoryShare)
      ? this.stats.categoryShare.slice()
      : [];
    host.replaceChildren();

    if (share.length === 0) {
      const empty = document.createElement("li");
      empty.className = "chip chip--empty";
      empty.textContent = "집계된 카테고리가 없습니다";
      host.append(empty);
      return;
    }

    // 조회한 유저가 어느 카테고리에 치우쳐 있는지 비교하기 위한 사전
    const mine = this.#currentCategoryShare();

    const fragment = document.createDocumentFragment();
    /** @type {Array<[HTMLElement, number]>} */
    const pending = [];

    share.forEach((category) => {
      const color = normalizeHex(category.colorHex);
      const percent = Math.max(0, toFiniteNumber(category.share));

      const row = document.createElement("li");
      row.className = "share-row";

      const head = document.createElement("div");
      head.className = "share-row__head";

      const name = document.createElement("span");
      name.className = "share-row__name";
      const dot = document.createElement("span");
      dot.className = "share-row__dot";
      dot.style.backgroundColor = color;
      const label = document.createElement("span");
      label.textContent = String(category.name ?? category.id ?? "미분류");
      name.append(dot, label);

      const value = document.createElement("span");
      value.className = "share-row__value";
      value.textContent = formatPercent(percent);

      head.append(name, value);

      const track = document.createElement("div");
      track.className = "share-row__track";
      const fill = document.createElement("div");
      fill.className = "share-row__fill";
      fill.style.backgroundColor = color;
      track.append(fill);
      pending.push([fill, percent]);

      row.append(head, track);

      // 조회 유저의 같은 카테고리 비중을 바로 아래 캡션으로 비교
      const myPercent = mine.get(String(category.id));
      if (typeof myPercent === "number") {
        const diff = myPercent - percent;
        const caption = document.createElement("span");
        caption.className = `share-row__diff ${diff >= 0 ? "is-above" : "is-below"}`;
        const sign = diff >= 0 ? "+" : "−";
        caption.textContent =
          `내 비중 ${formatPercent(myPercent)} (전체 대비 ${sign}${formatPercent(Math.abs(diff))})`;
        row.append(caption);
      }

      fragment.append(row);
    });

    host.append(fragment);
    // rAF 없이 강제 리플로우 후 폭을 대입 — 배경 탭에서도 바가 채워집니다.
    applyWidths(host, pending);
  }

  /* ─────────────────────────── 4. 백분위 ─────────────────────────── */

  /**
   * 조회 유저의 상대 위치를 게이지로 그립니다.
   *
   * 백분위 정의: 나보다 **적게** 집중한 유저의 비율.
   * 그래서 "상위 X%" 는 `100 - 백분위` 입니다. 1위면 상위 0%대가 되므로
   * 최소 0.1% 로 바닥을 잡아 "상위 0%" 같은 문구를 피합니다.
   */
  renderPercentile(tree) {
    const { percentileValue, percentileRank, percentileFill, percentileMarker, percentileCard } =
      this.el;
    if (!percentileValue || !percentileRank || !percentileFill) return;

    const seconds = toFiniteNumber(tree?.globalFocusSeconds, -1);
    const population = this.users.length;

    // 비교 대상이 없거나 조회 전이면 비활성 상태로 둡니다.
    if (seconds < 0 || population === 0) {
      percentileCard?.classList.add("is-idle");
      percentileValue.textContent = "—";
      percentileRank.textContent = "조회하면 전체 순위를 비교합니다";
      percentileFill.style.width = "0%";
      if (percentileMarker) percentileMarker.style.left = "0%";
      return;
    }

    percentileCard?.classList.remove("is-idle");

    const totals = this.users.map((u) => toFiniteNumber(u.totalFocusSeconds));
    // 조회 유저가 피드에 없으면 모집단에 더해 계산합니다.
    const seedId = normalizeSeed(tree?.seedId);
    const inFeed = this.users.some((u) => normalizeSeed(u.seedId) === seedId);
    const pool = inFeed ? totals : [...totals, seconds];

    const below = pool.filter((value) => value < seconds).length;
    const percentile = (below / pool.length) * 100;
    const rank = pool.filter((value) => value > seconds).length + 1;

    // 0.1 ~ 99.9 로 자릅니다.
    //   · 1위에게 "상위 0%" 는 값이 없다는 뜻처럼 읽힙니다.
    //   · 최하위에게 "상위 100%" 는 1등처럼 오해됩니다.
    // OP.GG 도 양 끝값을 그대로 노출하지 않습니다.
    const topPercent = Math.min(99.9, Math.max(0.1, 100 - percentile));

    percentileValue.textContent = `상위 ${formatPercent(topPercent)}`;
    percentileRank.textContent =
      `${formatCount(pool.length, "명")} 중 ${formatCount(rank, "위")}` +
      ` · 나보다 적게 집중한 유저 ${formatPercent(percentile)}`;

    // 게이지는 "이긴 비율" 입니다. 상위일수록 길어지므로 문구와 방향이 같고,
    // 아래 하위/중간/상위 스케일과도 읽는 방향이 일치합니다.
    const gaugePercent = Math.min(100, Math.max(0, percentile));
    applyWidths(percentileFill.parentElement ?? percentileFill, [
      [percentileFill, gaugePercent],
    ]);
    if (percentileMarker) {
      percentileMarker.style.left = `${gaugePercent}%`;
      percentileMarker.setAttribute("aria-hidden", "true");
    }
  }

  /* ─────────────────────────── 5. 일일 평균 비교 ─────────────────────────── */

  /**
   * 전체 평균 일일 집중 vs 조회 유저 일일 집중을 SVG 막대 두 개로 그립니다.
   *
   * SVG 를 직접 조립하는 이유: 차트 라이브러리는 이 화면 한 곳을 위해
   * 수십 KB 를 싣습니다. 막대 두 개는 `<rect>` 두 개로 끝나고,
   * 색도 CSS 변수를 그대로 받습니다.
   */
  renderComparison(tree) {
    const host = this.el.comparisonChart;
    if (!host) return;

    const globalDaily = Math.max(0, toFiniteNumber(this.stats?.averageDailySeconds));
    const mineDaily = this.#currentDailySeconds(tree);

    host.replaceChildren();

    if (globalDaily <= 0 && mineDaily <= 0) {
      const empty = document.createElement("p");
      empty.className = "card__desc";
      empty.textContent = "비교할 데이터가 아직 없습니다";
      host.append(empty);
      if (this.el.comparisonCaption) this.el.comparisonCaption.textContent = "";
      return;
    }

    const bars = [
      { label: "전체 평균", seconds: globalDaily, variant: "global" },
      { label: "조회 유저", seconds: mineDaily, variant: "mine" },
    ];
    const max = Math.max(...bars.map((b) => b.seconds), 1);

    // ── SVG 조립 (viewBox 좌표계 100x56, 폭은 CSS 가 늘립니다)
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 100 56");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("class", "compare-chart__svg");
    svg.setAttribute("role", "img");
    svg.setAttribute(
      "aria-label",
      `전체 평균 일일 ${formatDuration(globalDaily)}, 조회 유저 일일 ${formatDuration(mineDaily)}`,
    );

    const barHeight = 16;
    const gap = 8;

    bars.forEach((bar, index) => {
      const y = index * (barHeight + gap) + 6;
      const width = Math.max(0.6, (bar.seconds / max) * 100);

      const track = document.createElementNS(NS, "rect");
      track.setAttribute("x", "0");
      track.setAttribute("y", String(y));
      track.setAttribute("width", "100");
      track.setAttribute("height", String(barHeight));
      track.setAttribute("rx", "2");
      track.setAttribute("class", "compare-chart__track");
      svg.append(track);

      const fill = document.createElementNS(NS, "rect");
      fill.setAttribute("x", "0");
      fill.setAttribute("y", String(y));
      fill.setAttribute("width", String(width));
      fill.setAttribute("height", String(barHeight));
      fill.setAttribute("rx", "2");
      fill.setAttribute("class", `compare-chart__fill compare-chart__fill--${bar.variant}`);
      svg.append(fill);
    });

    const chart = document.createElement("div");
    chart.className = "compare-chart";

    const legend = document.createElement("div");
    legend.className = "compare-chart__legend";
    bars.forEach((bar) => {
      const item = document.createElement("div");
      item.className = `compare-chart__legend-item compare-chart__legend-item--${bar.variant}`;
      const name = document.createElement("span");
      name.textContent = bar.label;
      const value = document.createElement("b");
      value.textContent = formatDuration(bar.seconds);
      item.append(name, value);
      legend.append(item);
    });

    chart.append(svg, legend);
    host.append(chart);

    // 캡션: 몇 배 / 몇 % 차이인지 한 줄로
    if (this.el.comparisonCaption) {
      if (mineDaily <= 0) {
        this.el.comparisonCaption.textContent =
          "조회 유저의 활동일 정보가 없어 일일 평균을 계산하지 못했습니다";
      } else if (globalDaily <= 0) {
        this.el.comparisonCaption.textContent = "전체 평균이 아직 집계되지 않았습니다";
      } else {
        const ratio = mineDaily / globalDaily;
        const diffPercent = (ratio - 1) * 100;
        const direction = diffPercent >= 0 ? "많이" : "적게";
        this.el.comparisonCaption.textContent =
          `전체 평균보다 ${formatPercent(Math.abs(diffPercent))} ${direction} 집중했어요` +
          ` (${ratio.toFixed(2)}배)`;
      }
    }
  }

  /* ─────────────────────────── 파생 계산 ─────────────────────────── */

  /** 누적 시간 내림차순 유저 목록 */
  rankedUsers() {
    return this.users
      .slice()
      .sort(
        (a, b) =>
          toFiniteNumber(b.totalFocusSeconds) - toFiniteNumber(a.totalFocusSeconds) ||
          toFiniteNumber(b.likes) - toFiniteNumber(a.likes),
      );
  }

  /** 지금 조회 중인 유저인지 */
  #isCurrent(user) {
    const seedId = normalizeSeed(this.currentTree?.seedId);
    return Boolean(seedId) && normalizeSeed(user.seedId) === seedId;
  }

  /** 조회 유저의 카테고리 비중 (id → %) */
  #currentCategoryShare() {
    const categories = Array.isArray(this.currentTree?.categories)
      ? this.currentTree.categories
      : [];
    const total = categories.reduce(
      (sum, c) => sum + Math.max(0, toFiniteNumber(c.focusSeconds)),
      0,
    );
    const map = new Map();
    if (total <= 0) return map;
    for (const category of categories) {
      const seconds = Math.max(0, toFiniteNumber(category.focusSeconds));
      map.set(String(category.id), (seconds / total) * 100);
    }
    return map;
  }

  /**
   * 조회 유저의 일일 평균 집중 초.
   *
   * 트리에 활동일이 없으면 피드에서 같은 Seed ID 를 찾아 보완합니다.
   * 둘 다 없으면 0 을 돌려주고, 캡션이 그 사실을 알립니다.
   */
  #currentDailySeconds(tree) {
    const seconds = Math.max(0, toFiniteNumber(tree?.globalFocusSeconds));
    if (seconds <= 0) return 0;

    const seedId = normalizeSeed(tree?.seedId);
    const fromFeed = this.users.find((u) => normalizeSeed(u.seedId) === seedId);
    const days = Math.max(
      0,
      toFiniteNumber(tree?.activeDays, toFiniteNumber(fromFeed?.activeDays)),
    );

    if (days > 0) return seconds / days;

    // 최후 수단: 최장 연속 기록을 활동일로 대체합니다.
    const streak = Math.max(0, toFiniteNumber(tree?.longestStreakDays));
    return streak > 0 ? seconds / streak : 0;
  }

  /* ─────────────────────────── 이벤트 ─────────────────────────── */

  #bindEvents() {
    this.el.leaderboardBody?.addEventListener("click", (event) => {
      const action = event.target.closest("[data-action='open']");
      if (!action || !this.onOpenSeed) return;
      const row = action.closest(".leaderboard__row");
      if (row?.dataset.seedId) this.onOpenSeed(row.dataset.seedId);
    });
  }
}

/* ─────────────────────────── helpers ─────────────────────────── */

function emptyRow(colSpan, message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = colSpan;
  cell.className = "data-table__empty";
  cell.textContent = message;
  row.append(cell);
  return row;
}

function normalizeSeed(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
