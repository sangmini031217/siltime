/**
 * config.js — SilTime Web Viewer 전역 설정
 * 모든 매직 넘버는 이 파일에서만 정의합니다.
 */

/* ── Backend (Cloudflare Worker) ────────────────────────────────────────── */

/** Cloudflare Worker 엔드포인트 (배포된 siltime-api). */
export const API_BASE_URL = "https://siltime-api.sm031217.workers.dev";

/** Worker 라우트 빌더 */
export const API_ENDPOINTS = Object.freeze({
  /** 단일 트리 조회 */
  tree: (seedId) => `${API_BASE_URL}/api/tree/${encodeURIComponent(seedId)}`,
  /** iOS 앱이 트리를 올리는 동기화 엔드포인트 */
  sync: () => `${API_BASE_URL}/api/tree/sync`,
  /** 좋아요 +1 */
  like: (seedId) => `${API_BASE_URL}/api/tree/${encodeURIComponent(seedId)}/like`,
  /** 갤러리 / 리더보드용 유저 목록 */
  feed: (params = {}) => {
    const query = new URLSearchParams(
      Object.entries(params).filter(([, value]) => value != null && value !== ""),
    ).toString();
    return `${API_BASE_URL}/api/community/feed${query ? `?${query}` : ""}`;
  },
  /** 전역 집계 통계 */
  communityStats: () => `${API_BASE_URL}/api/community/stats`,
  health: () => `${API_BASE_URL}/api/health`,
});

/** fetch 타임아웃 (ms) */
export const REQUEST_TIMEOUT_MS = 8000;

/* ── Grid constraints ───────────────────────────────────────────────────── */

export const COLS = 48;
export const ROWS = 64;

/**
 * iOS 앱이 24x32 로 내보내던 시절의 격자.
 * 구버전 페이로드를 48x64 좌표계로 옮겨 심을 때 기준이 됩니다.
 */
export const LEGACY_COLS = 24;
export const LEGACY_ROWS = 32;

/** 지면(씨앗이 놓이는) 행 인덱스 */
export const GROUND_ROW = ROWS - 1;

/**
 * 셀 크기 한계 (CSS px)
 * 그리드가 24 × 32(3:4) 라서 셀이 커지면 카드 높이가 급격히 늘어납니다.
 * 상한을 두어 데스크톱 사이드바와 모바일에서 트리 크기를 일정하게 유지합니다.
 */
/* 48열이 좁은 카드(모바일 ~343px)에서도 넘치지 않는 하한 */
export const MIN_CELL_SIZE = 5;
export const MAX_CELL_SIZE = 13;

/** Retina 과부하 방지용 상한 */
export const MAX_DEVICE_PIXEL_RATIO = 3;

/** 좌표 눈금 간격 */
export const RULER_STEP = 4;

/* ── Dot model ──────────────────────────────────────────────────────────── */

export const DOT_TYPE = Object.freeze({
  SEED: "seed",
  BRANCH: "branch",
  LEAF: "leaf",
  WEED: "weed",
});

export const DOT_TYPE_LABEL = Object.freeze({
  [DOT_TYPE.SEED]: "씨앗",
  [DOT_TYPE.BRANCH]: "가지",
  [DOT_TYPE.LEAF]: "잎",
  [DOT_TYPE.WEED]: "잡초",
});

/** 타입 기본 색 (dot.colorHex 도, CSS 테마 변수도 없을 때의 최후 폴백).
 *  Starbucks 웜 팔레트 기준 — 크림/화이트 캔버스에서 읽히는 값입니다.
 *  실제 렌더링은 canvasRenderer 가 --dot-* 테마 변수를 먼저 읽습니다. */
export const PALETTE = Object.freeze({
  seed: "#795548",
  branch: "#1E3932",
  leaf: "#00754A",
  weed: "#6F8F7D",
});

/* ── Mastery ────────────────────────────────────────────────────────────── */

/** 10,000시간 = 36,000,000초 */
export const MASTERY_TARGET_SECONDS = 36_000_000;
export const SECONDS_PER_HOUR = 3600;

/* ── Botanical milestones ───────────────────────────────────────────────── */

/**
 * 누적 집중 시간(hours)에 따른 식물학적 성장 단계.
 * minHours 오름차순으로 정렬되어 있어야 합니다.
 */
export const MILESTONE_STAGES = Object.freeze([
  { id: "seed", label: "씨앗", minHours: 0, desc: "첫 집중을 땅에 심었습니다." },
  { id: "sprout", label: "새싹", minHours: 10, desc: "흙을 밀어 올린 첫 싹이 보입니다." },
  { id: "cotyledon", label: "떡잎", minHours: 100, desc: "떡잎이 펼쳐지며 줄기가 굵어집니다." },
  { id: "sapling", label: "묘목", minHours: 500, desc: "줄기가 곧게 서고 가지가 갈라집니다." },
  { id: "young-tree", label: "어린나무", minHours: 1000, desc: "가지가 사방으로 뻗기 시작합니다." },
  { id: "mature-tree", label: "성목", minHours: 3000, desc: "수관이 넓어지고 그늘을 만듭니다." },
  { id: "elder-tree", label: "큰나무", minHours: 6000, desc: "깊은 뿌리로 계절을 견딥니다." },
  { id: "canopy", label: "숲", minHours: 10000, desc: "10,000시간의 숲에 도달했습니다." },
]);

/* ── Tabs ───────────────────────────────────────────────────────────────── */

/** 사이드바 내비 항목. icon 은 24×24 viewBox 기준 SVG path 입니다. */
export const TABS = Object.freeze([
  {
    id: "overview",
    label: "종합",
    icon:
      "M13.5 1.515a3 3 0 0 0-3 0L3 5.845a2 2 0 0 0-1 1.732V21a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1v-6h3v6a1 1 0 0 0 1 1H21a1 1 0 0 0 1-1V7.577a2 2 0 0 0-1-1.732l-7.5-4.33Zm-2 1.732a1 1 0 0 1 1 0L20 7.577V20h-4.5v-6a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v6H4V7.577l7.5-4.33Z",
  },
  {
    id: "records",
    label: "기록",
    icon:
      "M3 3h18v2H3V3Zm0 5h18v2H3V8Zm0 5h12v2H3v-2Zm0 5h12v2H3v-2Zm15.5-5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
  },
  {
    id: "categories",
    label: "카테고리",
    icon:
      "M3 3h8v8H3V3Zm2 2v4h4V5H5Zm8-2h8v8h-8V3Zm2 2v4h4V5h-4ZM3 13h8v8H3v-8Zm2 2v4h4v-4H5Zm8-2h8v8h-8v-8Zm2 2v4h4v-4h-4Z",
  },
  {
    id: "gallery",
    label: "글로벌 갤러리",
    icon:
      "M12 21.35 10.55 20C5.4 15.36 2 12.28 2 8.5A5.5 5.5 0 0 1 12 5.09 5.5 5.5 0 0 1 22 8.5c0 3.78-3.4 6.86-8.55 11.5L12 21.35Zm0-2.7c4.35-3.94 7-6.35 7-10.15a3.5 3.5 0 0 0-6.36-2.01L12 7.5l-.64-1.01A3.5 3.5 0 0 0 5 8.5c0 3.8 2.65 6.21 7 10.15Z",
  },
  {
    id: "ranking",
    label: "랭킹 & 분석",
    icon:
      "M3 21V11h4v10H3Zm7 0V3h4v18h-4Zm7 0v-7h4v7h-4Z",
  },
]);

export const DEFAULT_TAB_ID = "overview";

/* ── Records (기록 탭) ──────────────────────────────────────────────────── */

/** "더 보기" 한 번에 노출할 행 수 */
export const RECORD_PAGE_SIZE = 12;

export const RECORD_SORTS = Object.freeze([
  { id: "recent", label: "최신순" },
  { id: "focus", label: "집중시간순" },
  { id: "height", label: "높이순" },
]);

export const DEFAULT_SORT_ID = "recent";

/** 필터 전체를 나타내는 예약 키 */
export const FILTER_ALL = "__all__";
/** 잡초만 보기 예약 키 */
export const FILTER_WEED = "__weed__";

/* ── Community (갤러리 / 랭킹) ──────────────────────────────────────────── */

/** 갤러리 정렬 옵션 */
export const GALLERY_SORTS = Object.freeze([
  { id: "recent", label: "최신순" },
  { id: "popular", label: "인기순" },
]);

export const DEFAULT_GALLERY_SORT = "recent";

/** 갤러리 한 페이지에 노출할 카드 수 */
export const GALLERY_PAGE_SIZE = 12;

/** 리더보드에 표시할 최대 순위 */
export const LEADERBOARD_LIMIT = 10;

/**
 * 갤러리 카드의 미니 캔버스 셀 크기(px).
 *
 * 48x64 격자를 3px 셀로 그리면 144x192px — 카드 썸네일로 적당하고,
 * 카드가 수십 장이어도 캔버스 백킹 스토어 총량이 과하지 않습니다.
 */
export const MINI_CELL_SIZE = 3;

/** 좋아요 중복 방지용 localStorage 키 */
export const STORAGE_KEY_LIKED_SEEDS = "siltime:liked-seeds";

/* ── UI ─────────────────────────────────────────────────────────────────── */

export const STORAGE_KEY_LAST_SEED = "siltime:last-seed-id";
export const STORAGE_KEY_SEARCH_HISTORY = "siltime:search-history";

/* ── Theme ──────────────────────────────────────────────────────────────── */

/** index.html 의 인라인 부트 스크립트와 동일한 키를 사용합니다. */
export const STORAGE_KEY_THEME = "siltime:theme";

export const THEME = Object.freeze({ DARK: "dark", LIGHT: "light" });

/** 상단바 색상 메타 태그에 넣을 값 (--bg 와 동일) */
export const THEME_COLOR = Object.freeze({
  dark: "#1E3932",
  light: "#F2F0EB",
});

/** 검색 기록 최대 보관 개수 (핀 고정 항목은 별도로 유지) */
export const MAX_HISTORY_ITEMS = 8;

export const CONNECTION_STATE = Object.freeze({
  IDLE: "idle",
  LOADING: "loading",
  LIVE: "live",
  DEMO: "demo",
  ERROR: "error",
});

export const CONNECTION_LABEL = Object.freeze({
  idle: "대기 중",
  loading: "불러오는 중",
  live: "연결됨",
  demo: "샘플 데이터",
  error: "연결 실패",
});
