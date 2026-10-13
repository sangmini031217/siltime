/**
 * app.js — 엔트리 포인트
 *
 * Cloudflare Worker 조회 → 실패 시 mockData 폴백 → DOM/캔버스/통계 갱신.
 * 사이드바 내비, 내 라이브러리(최근 검색·즐겨찾기), 하단 Now Bar 를 함께 오케스트레이션합니다.
 */

import {
  API_ENDPOINTS,
  COLS,
  CONNECTION_LABEL,
  CONNECTION_STATE,
  DEFAULT_TAB_ID,
  REQUEST_TIMEOUT_MS,
  ROWS,
  STORAGE_KEY_LAST_SEED,
  STORAGE_KEY_THEME,
  TABS,
  THEME,
  THEME_COLOR,
} from "./config.js";
import { AnalyticsRenderer } from "./analytics.js";
import { fetchCommunityFeed, fetchCommunityStats } from "./api.js";
import { CanvasRenderer } from "./canvasRenderer.js";
import { GalleryRenderer } from "./gallery.js";
import { renderFieldMastery } from "./fieldMastery.js";
import { exportRecordsCsv, exportWorkbook } from "./dataExport.js";
import { exportReportImage, exportReportPdf } from "./reportExport.js";
import { DotField } from "./dotField.js";
import { rankUsers } from "./forestShape.js";
import { buildImportLink } from "./shareTree.js";
import { DotEditor, EDITOR_PALETTE } from "./dotEditor.js";
import { getMockCommunityFeed, getMockCommunityStats, getMockTree } from "./mockData.js";
import { RecordsRenderer } from "./recordsRenderer.js";
import { SearchHistory, normalizeSeedId } from "./searchHistory.js";
import {
  StatsRenderer,
  aggregateTree,
  formatCount,
  formatDate,
  formatHours,
  formatRelativeTime,
  normalizeHex,
  toFiniteNumber,
} from "./statsRenderer.js";

/* ─────────────────────────── DOM refs ─────────────────────────── */

const $ = (id) => document.getElementById(id);

const dom = {
  // 검색
  form: $("seed-form"),
  seedInput: $("seed-input"),
  seedClear: $("seed-clear"),
  loadButton: $("load-button"),
  badge: $("connection-badge"),
  demoToggle: $("demo-toggle"),
  hint: $("seed-hint"),

  // 내 라이브러리
  historyList: $("history-list"),
  historyClear: $("history-clear"),

  // 허어로
  owner: $("tree-owner"),
  seedLabel: $("tree-seed"),
  heroHours: $("hero-hours"),
  heroDots: $("hero-dots"),
  heroSessions: $("hero-sessions"),
  pinButton: $("pin-button"),
  exportMenu: $("export-menu"),
  exportMenuButton: $("export-menu-button"),
  exportMenuLabel: $("export-menu-label"),
  exportMenuList: $("export-menu-list"),
  copyLinkButton: $("copy-link-button"),
  refreshButton: $("refresh-button"),
  lastUpdated: $("last-updated"),

  // 섹션 합계
  summaryTotal: $("summary-total"),
  categoryTotal: $("category-total"),

  // 내비 / 패널
  navList: $("nav-list"),
  gotoRecords: $("goto-records"),
  panels: {
    overview: $("panel-overview"),
    records: $("panel-records"),
    categories: $("panel-categories"),
    gallery: $("panel-gallery"),
    ranking: $("panel-ranking"),
  },

  // 커뮤니티
  rankingSource: $("ranking-source"),

  // 랜딩 (첫 화면)
  landingForm: $("landing-form"),
  landingInput: $("landing-input"),
  landingTheme: $("landing-theme"),
  landingDemo: $("landing-demo"),
  landingStats: $("landing-stats"),
  landingRecentSection: $("landing-recent-section"),
  landingRecent: $("landing-recent"),

  // 집중의 숲
  forestEmpty: $("forest-empty"),
  forestStatus: $("forest-status"),
  forestSampleToggle: $("forest-sample-toggle"),
  forestListWrap: $("forest-list-wrap"),
  forestList: $("forest-list"),

  // 테마
  themeToggle: $("theme-toggle"),
  importButton: $("import-button"),

  // 도트 그리기 에디터
  drawButton: $("draw-button"),
  landingDraw: $("landing-draw"),
  editorOverlay: $("editor-overlay"),
  editorClose: $("editor-close"),
  editorFrame: $("editor-frame"),
  editorCanvas: $("editor-canvas"),
  editorReadout: $("editor-readout"),
  editorCount: $("editor-count"),
  editorPalette: $("editor-palette"),
  editorName: $("editor-name"),
  editorClear: $("editor-clear"),
  editorWarn: $("editor-warn"),
  editorImport: $("editor-import"),
  editorCopy: $("editor-copy"),
  themeColorMeta: $("theme-color-meta"),

  // 캔버스 (기록 클릭 시 스크롤 대상)
  canvasFrame: $("canvas-frame"),
  canvasGridLabel: $("canvas-grid-label"),
};

const canvasRenderer = new CanvasRenderer({
  canvas: $("tree-canvas"),
  stage: $("canvas-stage"),
  frame: $("canvas-frame"),
  rulerX: $("ruler-x"),
  rulerY: $("ruler-y"),
  inspector: $("inspector"),
  readout: $("coord-readout"),
  countLabel: $("canvas-dot-count"),
});

const statsRenderer = new StatsRenderer({
  masteryPercent: $("mastery-percent"),
  masteryFill: $("mastery-fill"),
  masteryHours: $("mastery-hours"),
  masteryRemaining: $("mastery-remaining"),
  masteryProgress: $("mastery-progress"),
  phasePill: $("phase-pill"),
  phaseLabel: $("phase-label"),
  phaseDesc: $("phase-desc"),
  milestoneTrack: $("milestone-track"),
  breakdownTotal: $("breakdown-total"),
  stackBar: $("stack-bar"),
  chipList: $("chip-list"),
  summaryGrid: $("summary-grid"),
  categoryTableBody: $("category-table-body"),
});

/** 분야별 10,000시간 카드 */
const fieldMasteryEls = {
  list: $("field-mastery"),
  count: $("field-mastery-count"),
};

const recordsRenderer = new RecordsRenderer({
  list: $("records-list"),
  countLabel: $("records-count"),
  filterBar: $("records-filter"),
  sortSelect: $("records-sort"),
  moreButton: $("records-more"),
  previewList: $("recent-list"),
  previewLimit: 5,
  onSelect: (record) => focusRecordOnCanvas(record),
});

const galleryRenderer = new GalleryRenderer({
  grid: $("gallery-grid"),
  sortBar: $("gallery-sort"),
  countLabel: $("gallery-count"),
  moreButton: $("gallery-more"),
  statusLabel: $("gallery-status"),
  onOpenSeed: (seedId) => openSeedFromCommunity(seedId),
  onImportTree: (user) =>
    importTreeToApp({ name: user.nickname ?? user.seedId, dots: user.dots }, (message) => {
      const label = $("gallery-status");
      if (label) label.textContent = message;
    }),
});

const analyticsRenderer = new AnalyticsRenderer({
  leaderboardBody: $("leaderboard-body"),
  globalSummary: $("global-summary"),
  categoryShare: $("category-share"),
  percentileCard: $("percentile-card"),
  percentileValue: $("percentile-value"),
  percentileRank: $("percentile-rank"),
  percentileFill: $("percentile-fill"),
  percentileMarker: $("percentile-marker"),
  comparisonChart: $("comparison-chart"),
  comparisonCaption: $("comparison-caption"),
  onOpenSeed: (seedId) => openSeedFromCommunity(seedId),
});

/**
 * 첫 화면 전체를 덮는 도트 격자. 배경 격자, "SilTime" 로고, 도트 나무가 같은 칸 크기로 그려지고,
 * 나무의 점 하나는 사용자 한 명입니다. 누르면 그 사람의 전적으로 갑니다.
 */
const forest = new DotField({
  landing: $("landing"),
  canvas: $("dotfield"),
  wordSlot: $("dotword-slot"),
  treeSlot: $("forest-stage"),
  tip: $("forest-tip"),
  empty: $("forest-empty"),
  onSelect: (user) => openForestUser(user),
});

const searchHistory = new SearchHistory();

/* ─────────────────────────── State ─────────────────────────── */

const state = {
  connection: CONNECTION_STATE.IDLE,
  demoMode: false,
  inFlight: null,
  tree: null,
  seedId: "",
  loadedAt: null,
  exporting: false,

  /** 첫 화면 숲 데이터 */
  forest: {
    users: [],
    stats: null,
    source: null, // "live" | "mock"
    sample: false, // 샘플 숲 미리보기 중인지
    loadedAt: 0,
    loading: false,
  },
  activeTab: DEFAULT_TAB_ID,
  theme: THEME.DARK,

  /** 커뮤니티 피드/통계를 한 번만 불러오기 위한 캐시 */
  community: {
    users: [],
    stats: null,
    source: null,
    loading: false,
    loaded: false,
  },
};

/* ─────────────────────────── Networking ─────────────────────────── */

/**
 * Cloudflare Worker 에서 트리 익스포트 JSON 을 가져옵니다.
 * @param {string} seedId
 * @returns {Promise<object>}
 */
async function fetchTree(seedId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_ENDPOINTS.tree(seedId), {
      method: "GET",
      headers: { Accept: "application/json" },
      mode: "cors",
      cache: "no-store",
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────── Normalization ─────────────────────────── */

/**
 * 외부 JSON 을 렌더러가 기대하는 형태로 정규화합니다.
 * 잘못된 값은 조용히 보정하고, 최소 구조는 항상 보장합니다.
 */
function normalizeTree(raw, fallbackSeedId = "") {
  const source = raw && typeof raw === "object" ? raw : {};
  const payload = source.tree && typeof source.tree === "object" ? source.tree : source;

  const categories = (Array.isArray(payload.categories) ? payload.categories : []).map(
    (category, index) => ({
      id: String(category?.id ?? `category-${index}`),
      name: String(category?.name ?? "미분류"),
      colorHex: normalizeHex(category?.colorHex),
      focusSeconds: Math.max(0, toFiniteNumber(category?.focusSeconds)),
    }),
  );

  const dots = (Array.isArray(payload.dots) ? payload.dots : [])
    .map((dot, index) => ({
      id: String(dot?.id ?? `dot-${index}`),
      x: Math.round(toFiniteNumber(dot?.x, -1)),
      y: Math.round(toFiniteNumber(dot?.y, -1)),
      type: String(dot?.type ?? "branch"),
      categoryId: dot?.categoryId != null ? String(dot.categoryId) : null,
      colorHex: typeof dot?.colorHex === "string" ? dot.colorHex : null,
      count: Math.max(1, Math.round(toFiniteNumber(dot?.count, 1))),
      focusSeconds: Math.max(0, toFiniteNumber(dot?.focusSeconds)),
      createdAt: typeof dot?.createdAt === "string" ? dot.createdAt : null,
    }))
    .filter((dot) => dot.x >= 0 && dot.y >= 0 && dot.x < COLS && dot.y < ROWS);

  const categoryTotal = categories.reduce((sum, c) => sum + c.focusSeconds, 0);
  const globalFocusSeconds = Math.max(
    0,
    toFiniteNumber(payload.globalFocusSeconds, categoryTotal),
  );

  return {
    schemaVersion: String(payload.schemaVersion ?? "unknown"),
    seedId: String(payload.seedId ?? fallbackSeedId ?? "—"),
    ownerNickname: String(payload.ownerNickname ?? "익명 사용자"),
    exportedAt: typeof payload.exportedAt === "string" ? payload.exportedAt : null,
    grid: {
      cols: Math.round(toFiniteNumber(payload.grid?.cols, COLS)),
      rows: Math.round(toFiniteNumber(payload.grid?.rows, ROWS)),
    },
    seed: {
      x: Math.round(toFiniteNumber(payload.seed?.x, Math.floor(COLS / 2))),
      y: Math.round(toFiniteNumber(payload.seed?.y, ROWS - 1)),
    },
    globalFocusSeconds,
    sessionCount: Math.max(0, toFiniteNumber(payload.sessionCount)),
    longestStreakDays: Math.max(0, toFiniteNumber(payload.longestStreakDays)),
    milestone: { stageId: payload.milestone?.stageId ?? null },
    categories,
    dots,
  };
}

/* ─────────────────────────── Rendering ─────────────────────────── */

function setConnection(nextState, detail = "") {
  state.connection = nextState;
  dom.badge.className = `badge badge--${nextState}`;
  dom.badge.textContent = CONNECTION_LABEL[nextState] ?? nextState;
  if (detail) dom.hint.textContent = detail;
}

function renderTree(tree) {
  state.tree = tree;
  state.seedId = normalizeSeedId(tree.seedId);
  state.loadedAt = new Date().toISOString();

  // 집계는 app 에서 직접 계산합니다 (StatsRenderer.render 의 반환값에 의존하지 않도록)
  const summary = aggregateTree(tree);
  statsRenderer.render(tree);
  renderFieldMastery(fieldMasteryEls, tree.categories);

  dom.owner.textContent = tree.ownerNickname;
  dom.seedLabel.textContent = tree.seedId;
  dom.heroHours.textContent = formatHours(tree.globalFocusSeconds);
  dom.heroDots.textContent = `${formatCount(summary.dotCount, "개")}의 점`;
  dom.heroSessions.textContent = `${formatCount(summary.sessionCount, "회")} 세션`;

  dom.summaryTotal.textContent = formatHours(tree.globalFocusSeconds);
  dom.categoryTotal.textContent = formatHours(tree.globalFocusSeconds);

  canvasRenderer.setTree(tree);
  recordsRenderer.setTree(tree);

  // 백분위·비교 그래프는 "지금 보고 있는 유저"를 기준으로 그립니다.
  analyticsRenderer.setCurrentTree(tree);

  syncPinButton();
  syncExportButtons();
  updateLastUpdatedLabel();
}

function renderEmpty() {
  state.tree = null;
  state.seedId = "";
  state.loadedAt = null;

  statsRenderer.clear();
  renderFieldMastery(fieldMasteryEls, []);

  dom.owner.textContent = "데이터 없음";
  dom.seedLabel.textContent = "—";
  dom.heroHours.textContent = "0시간";
  dom.heroDots.textContent = "0개의 점";
  dom.heroSessions.textContent = "0회 세션";

  dom.summaryTotal.textContent = "0시간";
  dom.categoryTotal.textContent = "0시간";

  canvasRenderer.clear();
  recordsRenderer.clear();
  analyticsRenderer.setCurrentTree(null);

  syncPinButton();
  syncExportButtons();
  updateLastUpdatedLabel();
}

function setBusy(busy) {
  dom.loadButton.disabled = busy;
  dom.loadButton.textContent = busy ? "조회 중" : "검색";
  dom.refreshButton.disabled = busy;
  document.body.classList.toggle("is-loading", busy);
}

/** "3분 전 갱신" 표시. 30초 간격으로 자동 갱신됩니다. */
function updateLastUpdatedLabel() {
  if (!state.loadedAt) {
    dom.lastUpdated.textContent = "아직 조회하지 않았습니다";
    return;
  }
  const relative = formatRelativeTime(state.loadedAt);
  const exported = state.tree?.exportedAt
    ? ` · 내보낸 날짜 ${formatDate(state.tree.exportedAt)}`
    : "";
  dom.lastUpdated.textContent = `${relative} 갱신${exported}`;
}

/* ─────────────────────────── 테마 (밤/낮) ─────────────────────────── */

const darkMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** 저장값 우선, 없으면 시스템 설정을 따릅니다. */
function resolveInitialTheme() {
  const stored = readStoredTheme();
  if (stored) return stored;
  return darkMediaQuery.matches ? THEME.DARK : THEME.LIGHT;
}

/**
 * 테마를 적용합니다.
 * @param {"dark"|"light"} theme
 * @param {boolean} persist 사용자가 직접 바꾼 경우에만 저장
 */
function applyTheme(theme, persist = false) {
  const next = theme === THEME.LIGHT ? THEME.LIGHT : THEME.DARK;
  state.theme = next;

  document.documentElement.dataset.theme = next;
  dom.themeColorMeta?.setAttribute("content", THEME_COLOR[next]);

  const label = next === THEME.DARK ? "낮 모드로 전환" : "밤 모드로 전환";
  dom.themeToggle.setAttribute("aria-label", label);
  dom.themeToggle.title = label;

  if (persist) saveTheme(next);

  // 캔버스는 렌더 시점의 CSS 변수를 읽으므로 다시 그려야 합니다.
  canvasRenderer.render();
  forest.invalidate();
}

function toggleTheme() {
  applyTheme(state.theme === THEME.DARK ? THEME.LIGHT : THEME.DARK, true);
}

function readStoredTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY_THEME);
    return value === THEME.LIGHT || value === THEME.DARK ? value : null;
  } catch {
    return null;
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(STORAGE_KEY_THEME, theme);
  } catch {
    /* 프라이빗 모드 등에서 무시 */
  }
}

/* ─────────────────────────── 커뮤니티 (갤러리 / 랭킹) ─────────────────────────── */

/**
 * 커뮤니티 피드와 전역 통계를 불러옵니다.
 *
 * 갤러리와 랭킹이 같은 데이터를 쓰므로 한 번만 받아 두 렌더러에 나눠 줍니다.
 * 탭을 왕복할 때마다 네트워크를 때리지 않도록 `loaded` 로 한 번만 돕니다.
 *
 * @param {boolean} [force] 캐시를 무시하고 다시 불러옵니다 (갱신 버튼용).
 */
async function loadCommunity(force = false) {
  if (state.community.loading) return;
  if (state.community.loaded && !force) return;

  state.community.loading = true;

  // 두 요청은 서로 의존하지 않으므로 병렬로 보냅니다.
  const [feedResult, statsResult] = await Promise.all([
    fetchCommunityFeed({ sort: galleryRenderer.sortId }),
    fetchCommunityStats(),
  ]);

  state.community.users = Array.isArray(feedResult.data) ? feedResult.data : [];
  state.community.stats = statsResult.data ?? null;
  // 둘 중 하나라도 폴백이면 화면은 "샘플"로 표시합니다. 일부만 실데이터인
  // 상태를 실데이터라고 말하면 숫자의 출처를 오해하게 됩니다.
  state.community.source =
    feedResult.source === "live" && statsResult.source === "live" ? "live" : "mock";
  state.community.loaded = true;
  state.community.loading = false;

  galleryRenderer.setUsers(state.community.users);
  analyticsRenderer.setData({
    users: state.community.users,
    stats: state.community.stats,
  });
  analyticsRenderer.setCurrentTree(state.tree);

  if (dom.rankingSource) {
    dom.rankingSource.textContent =
      state.community.source === "live" ? "실시간 데이터" : "샘플 데이터";
  }
}

/**
 * 갤러리 카드나 리더보드 행에서 "전적 보기"를 눌렀을 때.
 *
 * 검색창을 채우고 내 전적 탭으로 이동한 뒤 조회합니다. 탭을 먼저 바꾸는
 * 이유는 조회 중 로딩 상태가 보여야 할 화면이 그쪽이기 때문입니다.
 *
 * @param {string} seedId
 */
function openSeedFromCommunity(seedId) {
  const id = normalizeSeedId(seedId);
  if (!id) return;

  dom.seedInput.value = id;
  dom.seedClear.hidden = false;
  setActiveTab("overview");
  loadSeed(id);
}

/* ─────────────────────────── 사이드바 내비 ─────────────────────────── */

function buildNav() {
  const fragment = document.createDocumentFragment();
  TABS.forEach((tab) => {
    const li = document.createElement("li");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav__item";
    button.id = `tab-${tab.id}`;
    button.dataset.tabId = tab.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(tab.id === state.activeTab));
    button.setAttribute("aria-controls", `panel-${tab.id}`);

    if (tab.icon) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", tab.icon);
      path.setAttribute("fill", "currentColor");
      svg.append(path);
      button.append(svg);
    }

    const label = document.createElement("span");
    label.textContent = tab.label;
    button.append(label);

    li.append(button);
    fragment.append(li);
  });
  dom.navList.replaceChildren(fragment);
}

function setActiveTab(tabId) {
  if (!dom.panels[tabId]) return;
  state.activeTab = tabId;

  dom.navList.querySelectorAll(".nav__item").forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.tabId === tabId));
  });

  Object.entries(dom.panels).forEach(([id, panel]) => {
    panel.hidden = id !== tabId;
  });

  // 커뮤니티 탭은 처음 열 때만 불러옵니다.
  // 캔버스가 있는 갤러리는 숨겨진 동안 그려 두면 폭이 0 이라 깨지므로,
  // 보이게 된 다음에 렌더가 일어나야 합니다.
  if (tabId === "gallery" || tabId === "ranking") {
    loadCommunity();
  }
}

/* ─────────────────────────── 기록 → 캔버스 연동 ─────────────────────────── */

/** 캔버스는 사이드바 허어로에 항상 표시되므로 좌표만 지목합니다. */
function focusRecordOnCanvas(record) {
  canvasRenderer.focusCell(record.x, record.y);
  dom.canvasFrame?.scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ─────────────────────────── 내 라이브러리 ─────────────────────────── */

function renderHistory() {
  const items = searchHistory.list();
  dom.historyList.replaceChildren();

  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = "조회한 트리가 없습니다";
    dom.historyList.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const li = document.createElement("li");
    li.className = "history-item";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "history-item__main";

    const text = document.createElement("span");
    text.className = "history-item__text";
    const seed = document.createElement("span");
    seed.className = "history-item__seed";
    seed.textContent = item.seedId;
    const meta = document.createElement("span");
    meta.className = "history-item__meta";
    meta.textContent = [item.nickname, formatRelativeTime(item.viewedAt)]
      .filter(Boolean)
      .join(" · ");
    text.append(seed, meta);
    main.append(text);

    main.addEventListener("click", () => {
      dom.seedInput.value = item.seedId;
      dom.seedClear.hidden = false;
      loadSeed(item.seedId);
    });

    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "history-item__action";
    pin.setAttribute("aria-pressed", String(item.pinned));
    pin.setAttribute("aria-label", item.pinned ? "즐겨찾기 해제" : "즐겨찾기 추가");
    pin.title = item.pinned ? "즐겨찾기 해제" : "즐겨찾기 추가";
    pin.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.86 3.77 4.16.6-3.01 2.93.71 4.14L8 11.09l-3.72 1.95.71-4.14L1.98 5.97l4.16-.6L8 1.6Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      searchHistory.togglePin(item.seedId, item.nickname);
      renderHistory();
      syncPinButton();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "history-item__action";
    remove.setAttribute("aria-label", "기록 삭제");
    remove.title = "기록 삭제";
    remove.innerHTML =
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      searchHistory.remove(item.seedId);
      renderHistory();
      syncPinButton();
    });

    li.append(main, pin, remove);
    fragment.append(li);
  });

  dom.historyList.append(fragment);
}

function syncPinButton() {
  const pinned = state.seedId ? searchHistory.isPinned(state.seedId) : false;
  dom.pinButton.setAttribute("aria-pressed", String(pinned));
  dom.pinButton.disabled = !state.seedId;
  const label = pinned ? "라이브러리에서 제거" : "라이브러리에 추가";
  dom.pinButton.title = label;
  dom.pinButton.setAttribute("aria-label", label);
}

/* ─────────────────────────── 랜딩 / 리포트 전환 ─────────────────────────── */


/**
 * 첫 화면(랜딩)으로 돌아갑니다.
 *
 * OP.GG 처럼 "검색이 먼저"인 흐름을 위해, 전적 리포트 셸을 숨기고 큰 중앙
 * 검색창 + 집중의 숲 + 보조 콘텐츠(최근 검색 · 통계)를 보여줍니다.
 */
function showLanding() {
  document.body.classList.add("is-landing");
  // 리포트가 비어 있도록 되돌려, 랜딩에서 리포트로 넘어갈 때 이전 잔상이 없게 합니다.
  renderEmpty();
  setConnection(CONNECTION_STATE.IDLE, "공유된 Seed ID 로 트리를 조회합니다.");
  dom.demoToggle.setAttribute("aria-checked", "false");
  state.demoMode = false;

  renderLandingRecent();
  loadLandingForest();
  // 랜딩이 다시 보이면 숲 폭을 새로 잽니다.
  forest.resize();

  dom.landingInput?.focus();
}

/** 랜딩의 "최근 검색" 칩을 라이브러리에서 채웁니다. */
function renderLandingRecent() {
  if (!dom.landingRecent || !dom.landingRecentSection) return;

  const items = searchHistory.list().slice(0, 6);
  if (items.length === 0) {
    dom.landingRecentSection.hidden = true;
    dom.landingRecent.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "landing__recent-chip";
    const seed = document.createElement("b");
    seed.textContent = item.seedId;
    chip.append(seed);
    if (item.nickname) {
      const name = document.createElement("span");
      name.textContent = item.nickname;
      chip.append(name);
    }
    chip.addEventListener("click", () => {
      dom.seedInput.value = item.seedId;
      dom.seedClear.hidden = false;
      dom.landingInput.value = item.seedId;
      loadSeed(item.seedId);
    });
    fragment.append(chip);
  }
  dom.landingRecent.replaceChildren(fragment);
  dom.landingRecentSection.hidden = false;
}

/* ─────────────────────────── 집중의 숲 (첫 화면) ─────────────────────────── */

/** 같은 데이터를 다시 받아 오기 전까지 기다리는 시간 */
const FOREST_REFRESH_MS = 60_000;

/** 숲에 올릴 사용자 수 상한. 서버 피드 상한과 같습니다. */
const FOREST_FEED_LIMIT = 200;

/**
 * 첫 화면의 "집중의 숲"을 채웁니다.
 *
 * 커뮤니티 피드로 사용자를 받아 랭킹순으로 나무에 앉히고, 전역 통계 한 줄도 같이 채웁니다.
 * 랜딩을 오갈 때마다 네트워크를 때리지 않도록 1분 안에는 다시 받지 않습니다.
 */
async function loadLandingForest() {
  const info = state.forest;
  if (info.loading) return;
  if (info.loadedAt && Date.now() - info.loadedAt < FOREST_REFRESH_MS) {
    renderForest();
    return;
  }

  info.loading = true;
  try {
    const [feedResult, statsResult] = await Promise.all([
      fetchCommunityFeed({ sort: "recent", limit: FOREST_FEED_LIMIT }),
      fetchCommunityStats(),
    ]);
    info.users = Array.isArray(feedResult.data) ? feedResult.data : [];
    info.stats = statsResult.data ?? null;
    info.source = feedResult.source;
    info.loadedAt = Date.now();
  } finally {
    info.loading = false;
  }
  renderForest();
}

/** 지금 보여줄 사용자와 통계 (샘플 미리보기 중이면 샘플) */
function forestView() {
  const info = state.forest;
  const serverDown = info.source === "mock";

  // 서버에 못 붙었으면 api.js 가 이미 샘플로 채워 준 값을 그대로 씁니다.
  if (serverDown) return { users: info.users, stats: info.stats, isSample: true, serverDown };

  // 사용자가 "샘플 숲 미리보기"를 켠 경우
  if (info.sample) {
    return { users: getMockCommunityFeed(), stats: getMockCommunityStats(), isSample: true, serverDown };
  }

  return { users: info.users, stats: info.stats, isSample: false, serverDown };
}

/** 숲 화면 전체(나무, 안내, 목록, 통계 한 줄)를 현재 상태로 다시 그립니다. */
function renderForest() {
  const { users, stats, isSample, serverDown } = forestView();
  const ranked = rankUsers(users);
  forest.setUsers(ranked);

  // 빈 숲 안내
  dom.forestEmpty.hidden = ranked.length > 0;

  // 상태 줄
  const seated = forest.seated;
  let status = "";
  if (serverDown) status = "서버에 연결하지 못해 샘플 데이터를 보여드려요";
  else if (isSample) status = `샘플 데이터 · ${formatCount(ranked.length, "명")}`;
  else if (ranked.length > 0) status = `${formatCount(ranked.length, "명")}이 숲에 있어요`;
  if (ranked.length > seated) status += ` (상위 ${formatCount(seated, "명")}만 표시)`;
  dom.forestStatus.textContent = status;

  // 샘플 토글 (서버에 못 붙었을 때는 이미 샘플이라 필요 없음)
  dom.forestSampleToggle.hidden = serverDown;
  dom.forestSampleToggle.textContent = state.forest.sample ? "실제 숲 보기" : "샘플 숲 미리보기";
  dom.forestSampleToggle.setAttribute("aria-pressed", String(state.forest.sample));

  // 키보드/스크린 리더용 랭킹 목록
  const fragment = document.createDocumentFragment();
  ranked.slice(0, seated).forEach((user) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("aria-label", `${user.rank}위 ${user.nickname || user.seedId} 전적 보기`);

    const no = document.createElement("span");
    no.className = "forest__rank-no";
    no.textContent = `${user.rank}`;
    const name = document.createElement("span");
    name.className = "forest__rank-name";
    name.textContent = user.nickname || user.seedId;
    const meta = document.createElement("span");
    meta.className = "forest__rank-meta";
    meta.textContent = formatHours(user.totalFocusSeconds ?? 0);

    button.append(no, name, meta);
    button.addEventListener("click", () => openForestUser(user));
    item.append(button);
    fragment.append(item);
  });
  dom.forestList.replaceChildren(fragment);
  dom.forestListWrap.hidden = ranked.length === 0;

  // 목록·안내가 생기거나 사라지면 나무 자리가 밀리므로, 도트 좌표를 다시 잽니다.
  forest.resize();

  // 전역 통계 한 줄
  if (dom.landingStats) {
    const count = Number(stats?.userCount ?? ranked.length) || 0;
    if (count > 0) {
      const people = formatCount(count, "명");
      const hours = formatHours(stats?.totalFocusSeconds ?? 0);
      dom.landingStats.innerHTML = `지금까지 <b>${people}</b>이 <b>${hours}</b> 집중했어요`;
    } else {
      dom.landingStats.textContent = "첫 번째 기록을 기다리고 있어요";
    }
  }
}

/** 숲에서 점을 골랐을 때: 그 사람의 전적으로 넘어갑니다. */
function openForestUser(user) {
  if (forestView().isSample) {
    loadSampleUser(user);
    return;
  }
  openSeedFromCommunity(user.seedId);
}

/**
 * 샘플 숲의 사용자는 서버에 없으므로, 피드가 들고 있는 그 사람의 트리를 그대로 전적 화면에 올립니다.
 * (서버 조회를 거치면 어느 사용자를 눌러도 같은 샘플 전적이 나옵니다.)
 */
function loadSampleUser(user) {
  enterReport();
  const tree = normalizeTree({
    seedId: user.seedId,
    ownerNickname: user.nickname,
    globalFocusSeconds: user.totalFocusSeconds,
    categories: user.categories,
    dots: user.dots,
    grid: user.grid,
  });
  renderTree(tree);

  searchHistory.add(tree.seedId, tree.ownerNickname);
  renderHistory();
  syncPinButton();

  setConnection(CONNECTION_STATE.DEMO);
  dom.hint.textContent = "샘플 데이터를 표시하고 있습니다.";
  dom.demoToggle.setAttribute("aria-checked", "true");
  state.demoMode = true;
}

/** 랜딩을 걷어내고 전적 리포트 화면으로 진입합니다. */
function enterReport() {
  document.body.classList.remove("is-landing");
  // 리포트가 보이게 된 뒤에야 캔버스가 올바른 폭을 측정할 수 있습니다.
  canvasRenderer.resize();
}

/* ─────────────────────────── Flows ─────────────────────────── */

/** 샘플 데이터 로드 */
function loadDemo(reason = "") {
  enterReport();
  const tree = normalizeTree(getMockTree());
  renderTree(tree);

  // 샘플도 "조회한 트리"로 취급해 라이브러리에 남깁니다.
  searchHistory.add(tree.seedId, tree.ownerNickname);
  renderHistory();
  syncPinButton();

  setConnection(CONNECTION_STATE.DEMO);
  dom.hint.textContent = reason
    ? `${reason} · 샘플 데이터로 표시합니다.`
    : "샘플 데이터를 표시하고 있습니다.";
  dom.demoToggle.setAttribute("aria-checked", "true");
  state.demoMode = true;
}

/** Seed ID 로 실데이터 조회 (실패 시 샘플 폴백) */
async function loadSeed(seedId) {
  const trimmed = normalizeSeedId(seedId);
  if (!trimmed) {
    dom.hint.textContent = "Seed ID 를 입력해 주세요.";
    dom.seedInput.focus();
    return;
  }

  setBusy(true);
  setConnection(CONNECTION_STATE.LOADING, "Cloudflare Worker 에서 트리를 가져오는 중…");

  const request = fetchTree(trimmed);
  state.inFlight = request;

  try {
    const raw = await request;
    if (state.inFlight !== request) return; // 최신 요청이 아니면 폐기

    const tree = normalizeTree(raw, trimmed);
    if (tree.dots.length === 0) {
      throw new Error("트리에 점 데이터가 없습니다");
    }

    enterReport();
    renderTree(tree);
    setConnection(CONNECTION_STATE.LIVE, "실시간 데이터를 표시하고 있습니다.");
    dom.demoToggle.setAttribute("aria-checked", "false");
    state.demoMode = false;

    saveLastSeed(trimmed);
    searchHistory.add(trimmed, tree.ownerNickname);
    renderHistory();
    syncPinButton();
  } catch (error) {
    if (state.inFlight !== request) return;

    const message =
      error?.name === "AbortError"
        ? "요청 시간 초과"
        : String(error?.message ?? "알 수 없는 오류");

    // 사용자가 빈 화면을 보지 않도록 즉시 샘플 데이터로 폴백
    loadDemo(`조회 실패: ${message}`);
    setConnection(CONNECTION_STATE.ERROR);
  } finally {
    if (state.inFlight === request) {
      state.inFlight = null;
      setBusy(false);
    }
  }
}

/** 전적 갱신: 현재 보고 있는 대상을 다시 불러옵니다. */
function refresh() {
  if (state.demoMode || !state.seedId) {
    loadDemo();
    return;
  }
  loadSeed(state.seedId);
}

/** 공유 링크 복사 */
/**
 * 나무를 앱 스튜디오의 청사진으로 보냅니다.
 *
 * 앱이 설치된 기기에서는 siltime:// 링크가 앱을 엽니다. 데스크톱처럼 앱이 없는
 * 환경에서는 열리는 곳이 없으므로, 링크를 클립보드에 먼저 복사해 두고
 * 휴대폰에서 열 수 있게 안내합니다. 커스텀 스킴은 성공 여부를 알 수 없어서
 * 안내 문구는 두 경우를 함께 말합니다.
 *
 * @param {{name?: string, dots: Array}} tree
 * @param {(message: string) => void} report 결과 문구를 보여 줄 곳
 */
async function importTreeToApp(tree, report) {
  const link = buildImportLink(tree);
  if (!link) {
    report("가져올 나무 점이 없어요");
    return;
  }

  let copied = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(link.url);
      copied = true;
    }
  } catch {
    copied = false;
  }

  report(
    copied
      ? `앱을 여는 중 · ${link.dotCount}점 · 열리지 않으면 복사된 링크를 휴대폰에서 열어 주세요`
      : `앱을 여는 중 · ${link.dotCount}점`,
  );
  window.location.href = link.url;
}

/* ─────────────────────────── 도트 그리기 에디터 ─────────────────────────── */

/** 에디터 인스턴스. 처음 열릴 때 한 번만 생성합니다. */
let dotEditor = null;

/** 팔레트 버튼을 그리고 색 선택을 연결합니다. */
function buildEditorPalette() {
  if (!dom.editorPalette) return;

  /** 한 색을 고른 상태로 표시 — 다른 스와치의 활성 표시는 해제. */
  const selectSwatch = (swatch, hex) => {
    dotEditor?.setColor(hex);
    dom.editorPalette
      .querySelectorAll(".editor__swatch")
      .forEach((el) => el.classList.toggle("is-active", el === swatch));
  };

  /** 색 하나를 나타내는 스와치 버튼을 만듭니다. */
  const makeSwatch = (hex, label, active) => {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.className = "editor__swatch" + (active ? " is-active" : "");
    swatch.style.backgroundColor = hex;
    swatch.dataset.hex = hex;
    swatch.title = label;
    swatch.setAttribute("aria-label", label);
    swatch.addEventListener("click", () => selectSwatch(swatch, hex));
    return swatch;
  };

  const fragment = document.createDocumentFragment();
  EDITOR_PALETTE.forEach((entry, index) => {
    fragment.append(makeSwatch(entry.hex, entry.label, index === 0));
  });

  // ── 커스텀 색 추가: 네이티브 색 선택기 ──────────────────────────────
  // 라벨을 스와치처럼 보이게 하고 그 안에 숨긴 color input 을 둡니다.
  // 색을 고르면 그 색의 스와치를 팔레트에 더하고 바로 선택합니다.
  const picker = document.createElement("label");
  picker.className = "editor__swatch editor__swatch--add";
  picker.title = "색 추가";
  picker.setAttribute("aria-label", "색 추가");

  const input = document.createElement("input");
  input.type = "color";
  input.value = "#00754A";
  input.className = "editor__color-input";
  input.addEventListener("input", () => {
    const hex = input.value.toUpperCase();
    // 이미 있는 색이면 그 스와치를 선택만, 없으면 새로 추가.
    const existing = dom.editorPalette.querySelector(
      `.editor__swatch[data-hex="${hex}"]`,
    );
    if (existing) {
      selectSwatch(existing, hex);
      return;
    }
    const swatch = makeSwatch(hex, hex, true);
    // 추가 버튼 앞에 끼워 넣어, 추가 버튼은 항상 맨 뒤에 둡니다.
    dom.editorPalette.insertBefore(swatch, picker);
    selectSwatch(swatch, hex);
  });

  picker.append(input);
  fragment.append(picker);

  dom.editorPalette.replaceChildren(fragment);
}

/** 에디터 상태 요약을 받아 버튼/경고 문구를 갱신합니다. */
function onEditorChange(summary) {
  if (dom.editorCount) dom.editorCount.textContent = String(summary.total);

  const canImport = summary.canImport;
  if (dom.editorImport) dom.editorImport.disabled = !canImport;
  if (dom.editorCopy) dom.editorCopy.disabled = !canImport;

  if (!dom.editorWarn) return;
  let message = "";
  if (summary.total === 0) {
    message = "";
  } else if (!summary.hasGround) {
    message = "맨 아랫줄(지면)에 점을 하나 이상 찍어야 씨앗이 생겨요.";
  } else if (summary.strayCount > 0) {
    message = `씨앗과 이어지지 않은 점 ${summary.strayCount}개는 앱에서 빠져요. 선으로 이어 보세요.`;
  }
  dom.editorWarn.textContent = message;
  dom.editorWarn.hidden = message.length === 0;
}

/** 에디터를 엽니다. 처음 열 때 인스턴스를 만들고, 매번 크기를 다시 잽니다. */
function openEditor() {
  if (!dom.editorOverlay) return;
  dom.editorOverlay.hidden = false;

  if (!dotEditor) {
    buildEditorPalette();
    dotEditor = new DotEditor({
      canvas: dom.editorCanvas,
      frame: dom.editorFrame,
      readout: dom.editorReadout,
      countLabel: dom.editorCount,
      onChange: onEditorChange,
    });
  }

  // 숨겨져 있던 동안에는 폭이 0 이라, 보이게 한 다음 측정해야 합니다.
  requestAnimationFrame(() => {
    dotEditor.resize();
    onEditorChange(dotEditor.analyze());
  });
}

/** 에디터를 닫습니다. 그린 내용은 다음에 열 때까지 유지됩니다. */
function closeEditor() {
  if (dom.editorOverlay) dom.editorOverlay.hidden = true;
}

/** 에디터의 현재 그림을 앱으로 보내거나 링크만 복사합니다. */
async function sendEditorTree({ copyOnly }) {
  if (!dotEditor) return;
  const tree = { name: dom.editorName?.value ?? "", dots: dotEditor.toDots() };

  if (copyOnly) {
    const link = buildImportLink(tree);
    const button = dom.editorCopy;
    if (!link) return;
    try {
      await navigator.clipboard?.writeText(link.url);
      if (button) button.textContent = "복사됨";
    } catch {
      if (button) button.textContent = "복사 실패";
    } finally {
      setTimeout(() => {
        if (button) button.textContent = "링크 복사";
      }, 1600);
    }
    return;
  }

  importTreeToApp(tree, (message) => {
    if (dom.editorWarn) {
      dom.editorWarn.textContent = message;
      dom.editorWarn.hidden = false;
    }
  });
}

async function copyShareLink() {
  const seedId = state.seedId || normalizeSeedId(dom.seedInput.value);
  const url = new URL(window.location.href);
  url.search = seedId ? `?seed=${encodeURIComponent(seedId)}` : "";

  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(url.toString());
    dom.copyLinkButton.textContent = "복사됨";
  } catch {
    dom.copyLinkButton.textContent = "복사 실패";
    dom.hint.textContent = `링크를 직접 복사하세요: ${url.toString()}`;
  } finally {
    setTimeout(() => {
      dom.copyLinkButton.textContent = "링크 복사";
    }, 1600);
  }
}

/* ─────────────────────────── Storage ─────────────────────────── */

function saveLastSeed(seedId) {
  try {
    localStorage.setItem(STORAGE_KEY_LAST_SEED, seedId);
  } catch {
    /* 프라이빗 모드 등에서 무시 */
  }
}

function readLastSeed() {
  try {
    return localStorage.getItem(STORAGE_KEY_LAST_SEED) ?? "";
  } catch {
    return "";
  }
}

/* ─────────────────────────── Events ─────────────────────────── */

dom.form.addEventListener("submit", (event) => {
  event.preventDefault();
  loadSeed(dom.seedInput.value);
});

dom.seedInput.addEventListener("input", () => {
  dom.seedClear.hidden = dom.seedInput.value.length === 0;
});

dom.seedClear.addEventListener("click", () => {
  dom.seedInput.value = "";
  dom.seedClear.hidden = true;
  dom.seedInput.focus();
});

dom.historyClear.addEventListener("click", () => {
  searchHistory.clearUnpinned();
  renderHistory();
  syncPinButton();
});

dom.navList.addEventListener("click", (event) => {
  const button = event.target.closest(".nav__item");
  if (!button) return;
  setActiveTab(button.dataset.tabId);
});

dom.gotoRecords.addEventListener("click", () => setActiveTab("records"));

// 피처 밴드 등 어디서든 data-goto-tab 으로 탭을 전환할 수 있게 위임합니다.
document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.("[data-goto-tab]");
  if (!trigger) return;
  setActiveTab(trigger.dataset.gotoTab);
});

dom.pinButton.addEventListener("click", () => {
  if (!state.seedId) return;
  searchHistory.togglePin(state.seedId, state.tree?.ownerNickname ?? "");
  renderHistory();
  syncPinButton();
});

dom.copyLinkButton.addEventListener("click", () => copyShareLink());

/* ─────────────────────────── 내보내기 메뉴 ─────────────────────────── */

/** 내보내기는 지금 조회한 트리가 있을 때만 켜집니다. */
function syncExportButtons() {
  const enabled = Boolean(state.tree);
  dom.exportMenuButton.disabled = !enabled || state.exporting;
  if (!enabled) setExportMenuOpen(false);
}

function exportMenuItems() {
  return [...dom.exportMenuList.querySelectorAll('[role="menuitem"]')];
}

/**
 * 메뉴가 화면 밖으로 나가지 않게 정렬합니다.
 * 기본은 버튼 오른쪽 끝에 맞추고, 그러면 왼쪽이 잘리는 좁은 화면에서는 왼쪽 끝에 맞춥니다.
 */
function alignExportMenu() {
  const list = dom.exportMenuList;
  list.classList.remove("is-align-left");
  if (list.getBoundingClientRect().left < 8) list.classList.add("is-align-left");
}

/** 메뉴를 열고 닫습니다. 열면 첫 항목에 포커스를 줍니다. */
function setExportMenuOpen(open, { focusFirst = false } = {}) {
  const isOpen = !dom.exportMenuList.hidden;
  if (open === isOpen) return;
  dom.exportMenuList.hidden = !open;
  dom.exportMenuButton.setAttribute("aria-expanded", String(open));
  if (open) alignExportMenu();
  if (open && focusFirst) exportMenuItems()[0]?.focus();
}

/** 선택한 형식으로 내보냅니다. 오래 걸리는 작업은 버튼에 진행 상태를 보여 줍니다. */
async function runExport(kind) {
  const tree = state.tree;
  if (!tree || state.exporting) return;

  if (kind === "pdf") {
    // 인쇄 창이 열리면 대상을 "PDF로 저장"으로 고르면 됩니다.
    dom.hint.textContent = "인쇄 창에서 대상을 'PDF로 저장'으로 선택하세요.";
    exportReportPdf(tree);
    return;
  }

  state.exporting = true;
  const label = dom.exportMenuLabel.textContent;
  dom.exportMenuLabel.textContent = "만드는 중";
  syncExportButtons();
  try {
    if (kind === "image") {
      const result = await exportReportImage(tree);
      dom.hint.textContent = `리포트 이미지를 저장했습니다 (${result.fileName})`;
    } else if (kind === "xlsx") {
      const result = exportWorkbook(tree);
      dom.hint.textContent = `엑셀 파일을 저장했습니다 (${result.fileName} · 시트 ${result.sheets}개)`;
    } else if (kind === "csv") {
      const result = exportRecordsCsv(tree);
      dom.hint.textContent = `CSV 파일을 저장했습니다 (${result.fileName} · ${formatCount(result.rows, "건")})`;
    }
  } catch (error) {
    dom.hint.textContent = `저장에 실패했습니다: ${error?.message ?? "알 수 없는 오류"}`;
  } finally {
    state.exporting = false;
    dom.exportMenuLabel.textContent = label;
    syncExportButtons();
  }
}

dom.exportMenuButton.addEventListener("click", () => {
  setExportMenuOpen(dom.exportMenuList.hidden, { focusFirst: true });
});

dom.exportMenuList.addEventListener("click", (event) => {
  const item = event.target.closest("[data-export]");
  if (!item) return;
  setExportMenuOpen(false);
  dom.exportMenuButton.focus();
  runExport(item.dataset.export);
});

// 메뉴 바깥을 누르면 닫습니다.
document.addEventListener("click", (event) => {
  if (!dom.exportMenu.contains(event.target)) setExportMenuOpen(false);
});

// 키보드: Esc 로 닫기, 위/아래/Home/End 로 이동
dom.exportMenu.addEventListener("keydown", (event) => {
  if (dom.exportMenuList.hidden) {
    if (event.key === "ArrowDown" && event.target === dom.exportMenuButton) {
      event.preventDefault();
      setExportMenuOpen(true, { focusFirst: true });
    }
    return;
  }
  const items = exportMenuItems();
  const index = items.indexOf(document.activeElement);
  switch (event.key) {
    case "Escape":
      event.preventDefault();
      setExportMenuOpen(false);
      dom.exportMenuButton.focus();
      break;
    case "ArrowDown":
      event.preventDefault();
      items[(index + 1) % items.length]?.focus();
      break;
    case "ArrowUp":
      event.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
      break;
    case "Home":
      event.preventDefault();
      items[0]?.focus();
      break;
    case "End":
      event.preventDefault();
      items[items.length - 1]?.focus();
      break;
    case "Tab":
      // 메뉴 밖으로 나가면 닫습니다.
      setExportMenuOpen(false);
      break;
    default:
  }
});

dom.importButton?.addEventListener("click", () => {
  if (!state.tree) return;
  importTreeToApp(
    { name: state.tree.ownerNickname || state.seedId, dots: state.tree.dots },
    (message) => {
      dom.hint.textContent = message;
    },
  );
});
dom.refreshButton.addEventListener("click", () => refresh());
dom.themeToggle.addEventListener("click", () => toggleTheme());

// 도트 그리기 에디터
dom.drawButton?.addEventListener("click", () => openEditor());
dom.landingDraw?.addEventListener("click", () => openEditor());
dom.editorClose?.addEventListener("click", () => closeEditor());
dom.editorClear?.addEventListener("click", () => dotEditor?.clear());
dom.editorImport?.addEventListener("click", () => sendEditorTree({ copyOnly: false }));
dom.editorCopy?.addEventListener("click", () => sendEditorTree({ copyOnly: true }));

// 배경(오버레이) 클릭 또는 ESC 로 닫기
dom.editorOverlay?.addEventListener("click", (event) => {
  if (event.target === dom.editorOverlay) closeEditor();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && dom.editorOverlay && !dom.editorOverlay.hidden) {
    closeEditor();
  }
});

// 랜딩의 큰 검색창 → 메인 검색으로 넘깁니다. 입력값을 헤더 검색창에도 반영해
// 리포트 진입 후 상단 검색창이 비어 보이지 않게 합니다.
dom.landingForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = dom.landingInput?.value ?? "";
  dom.seedInput.value = value;
  dom.seedClear.hidden = value.length === 0;
  loadSeed(value);
});

dom.landingTheme?.addEventListener("click", () => toggleTheme());

// 둘러보기 — Seed ID 없이 바로 샘플 전적으로 진입합니다.
dom.landingDemo?.addEventListener("click", () => loadDemo());

// 샘플 숲 미리보기 ↔ 실제 숲
dom.forestSampleToggle?.addEventListener("click", () => {
  state.forest.sample = !state.forest.sample;
  renderForest();
});

// 로고 클릭 시 첫 화면(랜딩)으로 돌아갑니다. (헤더/랜딩 양쪽 로고)
document.addEventListener("click", (event) => {
  const brand = event.target.closest?.(".brand, .landing__brand");
  if (!brand) return;
  event.preventDefault();
  showLanding();
});

// 사용자가 직접 고른 적이 없을 때만 시스템 설정 변경을 따라갑니다.
darkMediaQuery.addEventListener("change", (event) => {
  if (readStoredTheme()) return;
  applyTheme(event.matches ? THEME.DARK : THEME.LIGHT);
});

dom.demoToggle.addEventListener("click", () => {
  const nextChecked = dom.demoToggle.getAttribute("aria-checked") !== "true";
  if (nextChecked) {
    loadDemo();
    return;
  }
  dom.demoToggle.setAttribute("aria-checked", "false");
  state.demoMode = false;
  const seedId = normalizeSeedId(dom.seedInput.value);
  if (seedId) {
    loadSeed(seedId);
  } else {
    // 조회 중인 Seed 가 없으면 첫 화면(랜딩)으로 돌아갑니다.
    showLanding();
  }
});

// 폰트 로딩 후 레이아웃 확정 시 캔버스 재측정
if (document.fonts?.ready) {
  document.fonts.ready.then(() => canvasRenderer.resize());
}

// "n분 전 갱신" 표시를 주기적으로 최신화
setInterval(updateLastUpdatedLabel, 30_000);

/* ─────────────────────────── Boot ─────────────────────────── */

function boot() {
  applyTheme(resolveInitialTheme());

  // 격자 크기는 config 에서 받아 씁니다. 마크업에 숫자를 박아 두면
  // COLS/ROWS 를 바꿀 때 캡션만 옛 값으로 남습니다
  // (24x32 → 48x64 전환에서 실제로 발생했던 버그).
  if (dom.canvasGridLabel) {
    dom.canvasGridLabel.textContent = `${COLS} × ${ROWS}`;
  }

  buildNav();
  setActiveTab(DEFAULT_TAB_ID);
  renderHistory();

  const params = new URLSearchParams(window.location.search);
  const seedFromUrl = normalizeSeedId(params.get("seed") ?? params.get("seedId") ?? "");

  // 공유 링크(?seed=...)로 들어온 경우에만 곧장 조회해 리포트로 진입합니다.
  // 그 외에는 OP.GG 처럼 빈 랜딩(큰 검색창)에서 시작합니다. 지난 조회 기록은
  // 라이브러리에 남아 있으니 한 번 더 눌러 들어가면 됩니다.
  if (seedFromUrl) {
    dom.seedInput.value = seedFromUrl;
    dom.seedClear.hidden = false;
    loadSeed(seedFromUrl);
  } else {
    showLanding();
  }
}

boot();
