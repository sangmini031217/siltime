/**
 * mockData.js — 오프라인/데모용 트리 익스포트 JSON
 *
 * 실제 SilTime iOS 앱이 내보내는 형태와 동일한 스키마를 사용합니다.
 *  - 지면 씨앗: (12, 31)
 *  - 씨앗에서 위로 이어지는 줄기/가지: 각 점은 카테고리 colorHex 를 가집니다.
 *  - 잡초(weed): 지면 행에 초록 점, 같은 칸에 여러 개가 쌓입니다.
 */

import { COLS, DOT_TYPE, GROUND_ROW, PALETTE, ROWS } from "./config.js";

/* ── 카테고리 정의 ──────────────────────────────────────────────────────── */

const CATEGORIES = [
  { id: "dev", name: "개발", colorHex: "#00754A", focusSeconds: 2_412_000 },
  { id: "design", name: "디자인", colorHex: "#CBA258", focusSeconds: 928_800 },
  { id: "reading", name: "독서", colorHex: "#6F8F7D", focusSeconds: 561_600 },
  { id: "fitness", name: "운동", colorHex: "#8D6E63", focusSeconds: 313_200 },
  { id: "language", name: "외국어", colorHex: "#7B4B5A", focusSeconds: 190_800 },
];

const COLOR_BY_CATEGORY = new Map(CATEGORIES.map((c) => [c.id, c.colorHex]));

/* ── 나무 형태: 48x64 격자에 직접 생성 ───────────────────────────────────── */

/**
 * 이전에는 24x32 로 손배치한 좌표를 48x64 로 옮겨 심었습니다. 그러면 점이
 * 41개뿐이라 넓어진 격자가 거의 비어 보이고, 같은 유저의 갤러리 카드가
 * 420점이라고 표시해 숫자가 어긋났습니다.
 *
 * 그래서 48x64 규모로 직접 생성합니다. 1,224시간이면 iOS 레벨 곡선상 Lv.49,
 * 누적 지급 도트가 1,225개이므로 420점은 자연스러운 수치입니다.
 *
 * 색은 카테고리 비중에 비례해 배분합니다. 그래야 캔버스의 색 분포와
 * 카테고리 분포 패널이 서로 모순되지 않습니다.
 */
// 씨앗을 포함한 총 배치 수. 갤러리 카드의 `dotCount`(성장점 420)와
// 맞추려면 씨앗 1개를 더해 421 이어야 합니다.
const MAIN_DOT_COUNT = 421;

const EXPORT_EPOCH_MS = Date.parse("2025-11-02T09:00:00.000Z");
const ONE_DAY_MS = 86_400_000;

/** 결정적(deterministic) 의사 난수 — 매 실행마다 동일한 데모 데이터 보장 */
function pseudoRandom(index) {
  const x = Math.sin(index * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * 카테고리 비중에 비례한 색 "티켓" 배열.
 *
 * 순환 배분하면 비중이 무시되어 모든 카테고리가 같은 수가 됩니다.
 * 개발 55% 면 전체 점의 55% 가 개발 색이어야 합니다.
 */
function buildColorTickets(count) {
  const total = CATEGORIES.reduce((sum, c) => sum + c.focusSeconds, 0);
  const tickets = [];
  for (const category of CATEGORIES) {
    const share = Math.round((count * category.focusSeconds) / total);
    for (let i = 0; i < share; i += 1) {
      tickets.push({ id: category.id, hex: category.colorHex });
    }
  }
  while (tickets.length < count) {
    tickets.push({ id: CATEGORIES[0].id, hex: CATEGORIES[0].colorHex });
  }

  // 결정적으로 섞습니다 (Fisher-Yates).
  //
  // 섞지 않으면 수관을 "중심에서 가까운 칸부터" 채우는 순서와 티켓 순서가
  // 겹쳐, 가운데는 개발색, 그 바깥은 디자인색… 하는 동심원 과녁이 나옵니다.
  // 섞으면 비중은 그대로 유지되면서 색이 잎처럼 흩뿌려집니다.
  const shuffled = tickets.slice(0, count);
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(pseudoRandom(i * 2.718 + 7) * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/** 48x64 격자에 메인 샘플 트리를 생성합니다. */
function buildMainTree() {
  const centerX = Math.floor(COLS / 2);
  const taken = new Set();
  const dots = [];
  const tickets = buildColorTickets(MAIN_DOT_COUNT);
  let ticketCursor = 0;
  let rollCursor = 0;
  const roll = () => pseudoRandom(rollCursor++);

  const put = (x, y, type, forced) => {
    if (x < 0 || x >= COLS || y < 0 || y > GROUND_ROW) return false;
    const key = `${x},${y}`;
    if (taken.has(key)) return false;
    taken.add(key);

    const ticket = forced ?? tickets[ticketCursor++ % tickets.length];
    const index = dots.length;
    dots.push({
      id: `dot-${x}-${y}`,
      x,
      y,
      type,
      categoryId: ticket.id,
      colorHex: ticket.hex,
      // 잎은 짧게, 줄기/가지는 길게 — 세션 길이가 구조와 어울리도록
      focusSeconds:
        type === DOT_TYPE.LEAF
          ? 900 + Math.round(roll() * 3600)
          : 1800 + Math.round(roll() * 4200),
      createdAt: new Date(EXPORT_EPOCH_MS - (index + 1) * ONE_DAY_MS * 1.2).toISOString(),
    });
    return true;
  };

  // ── 씨앗 (바닥 중앙)
  put(centerX, GROUND_ROW, DOT_TYPE.SEED, { id: null, hex: PALETTE.seed });

  // ── 줄기: 아래쪽이 굵은 밑동
  const trunkHeight = 29;
  const trunkTopY = GROUND_ROW - trunkHeight;
  let x = centerX;
  for (let i = 1; i <= trunkHeight; i += 1) {
    if (roll() < 0.18) x += roll() < 0.5 ? -1 : 1;
    x = Math.max(3, Math.min(COLS - 4, x));
    const y = GROUND_ROW - i;
    put(x, y, DOT_TYPE.BRANCH);
    if (i < trunkHeight * 0.7) put(x + 1, y, DOT_TYPE.BRANCH);
    if (i < trunkHeight * 0.4) put(x - 1, y, DOT_TYPE.BRANCH);
    if (i < trunkHeight * 0.18) put(x + 2, y, DOT_TYPE.BRANCH);
  }

  // ── 뿌리: 바닥을 따라 좌우로
  for (let step = 1; step <= 6; step += 1) {
    put(centerX - step, GROUND_ROW, DOT_TYPE.BRANCH);
    put(centerX + step, GROUND_ROW, DOT_TYPE.BRANCH);
    if (step <= 3) {
      put(centerX - step, GROUND_ROW - 1, DOT_TYPE.BRANCH);
      put(centerX + step, GROUND_ROW - 1, DOT_TYPE.BRANCH);
    }
  }

  // ── 가지: 줄기 중상단에서 좌우로 비스듬히
  for (let a = 0; a < 5; a += 1) {
    const anchorY = trunkTopY + Math.round(((a + 1) / 6) * trunkHeight * 0.95);
    const span = 5 + Math.round(roll() * 5);
    for (const dir of [-1, 1]) {
      let bx = x;
      let by = anchorY;
      for (let step = 1; step <= span; step += 1) {
        bx += dir;
        if (step % 2 === 0) by -= 1;
        put(bx, by, DOT_TYPE.BRANCH);
      }
    }
  }

  // ── 수관: 줄기 상단 중심의 납작한 타원.
  // 중심에서 가까운 칸부터 채워, 점이 모자라도 가운데가 빈 고리가 되지 않게.
  const radius = 9;
  const crownY = Math.max(2, trunkTopY - 2);
  const cells = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -Math.round(radius * 1.3); dx <= Math.round(radius * 1.3); dx += 1) {
      const norm = (dx * dx) / (radius * 1.3 * radius * 1.3) + (dy * dy) / (radius * radius);
      if (norm <= 1) cells.push({ x: x + dx, y: crownY + dy, norm });
    }
  }
  cells.sort((a, b) => a.norm - b.norm);
  for (const cell of cells) {
    if (dots.length >= MAIN_DOT_COUNT) break;
    if (cell.norm > 0.74 && roll() < 0.42) continue;
    put(cell.x, cell.y, DOT_TYPE.LEAF);
  }

  // ── 부족분은 8방향 이웃으로 메웁니다 (인접 규칙 유지)
  let guard = 0;
  while (dots.length < MAIN_DOT_COUNT && guard < MAIN_DOT_COUNT * 12) {
    guard += 1;
    const anchor = dots[Math.floor(roll() * dots.length)];
    const dx = Math.floor(roll() * 3) - 1;
    const dy = Math.floor(roll() * 3) - 1;
    if (dx === 0 && dy === 0) continue;
    put(anchor.x + dx, anchor.y + dy, DOT_TYPE.LEAF);
  }

  return dots;
}

/** 잡초 — [x, count]. 48칸으로 넓어졌으므로 좌우로 더 흩뿌립니다. */
const WEED_SPOTS = [[6, 3], [10, 1], [14, 1], [34, 2], [38, 4], [42, 2], [45, 1]];

function buildWeeds() {
  return WEED_SPOTS.map(([x, count], index) => ({
    id: `weed-${x}-${GROUND_ROW}`,
    x,
    y: GROUND_ROW,
    type: DOT_TYPE.WEED,
    count,
    categoryId: null,
    colorHex: PALETTE.weed,
    focusSeconds: 0,
    createdAt: new Date(EXPORT_EPOCH_MS - (index + 1) * ONE_DAY_MS).toISOString(),
  }));
}

const DOTS = [...buildMainTree(), ...buildWeeds()];


const TOTAL_FOCUS_SECONDS = CATEGORIES.reduce((sum, c) => sum + c.focusSeconds, 0);

/* ── 익스포트 페이로드 ──────────────────────────────────────────────────── */

/**
 * @typedef {Object} TreeExport
 * @property {string} schemaVersion
 * @property {string} seedId
 * @property {string} ownerNickname
 * @property {string} exportedAt
 * @property {{cols:number, rows:number}} grid
 * @property {{x:number, y:number}} seed
 * @property {number} globalFocusSeconds
 * @property {{stageId:string}} milestone
 * @property {Array<Object>} categories
 * @property {Array<Object>} dots
 */

/** @type {TreeExport} */
export const MOCK_TREE = Object.freeze({
  schemaVersion: "1.2",
  seedId: "SEED-7F3A29",
  ownerNickname: "집중하는 상민",
  exportedAt: new Date(EXPORT_EPOCH_MS).toISOString(),
  timezone: "Asia/Seoul",
  grid: { cols: COLS, rows: ROWS },
  seed: { x: Math.floor(COLS / 2), y: GROUND_ROW },
  globalFocusSeconds: TOTAL_FOCUS_SECONDS,
  sessionCount: 1_842,
  longestStreakDays: 96,
  milestone: { stageId: "young-tree" },
  categories: CATEGORIES,
  dots: DOTS,
});

/** 새 객체로 복제해 반환 (렌더러가 원본을 변형하지 못하도록) */
export function getMockTree() {
  return structuredClone
    ? structuredClone(MOCK_TREE)
    : JSON.parse(JSON.stringify(MOCK_TREE));
}

/* ═══════════════════════════════════════════════════════════════════════════
   커뮤니티 목 데이터 — 갤러리 / 리더보드 / 전역 통계
   Worker 가 아직 없거나 조회에 실패했을 때 화면을 채우는 폴백입니다.
   `GET /api/community/feed` · `GET /api/community/stats` 응답 스키마와
   형태가 같습니다.
   ═══════════════════════════════════════════════════════════════════════════ */

/** 갤러리 카드에 쓰이는 전역 카테고리 색 사전 */
export const GLOBAL_CATEGORIES = Object.freeze([
  { id: "coding", name: "코딩", colorHex: "#00754A" },
  { id: "language", name: "언어", colorHex: "#7B4B5A" },
  { id: "major", name: "전공", colorHex: "#B7791F" },
  { id: "reading", name: "독서", colorHex: "#6F8F7D" },
  { id: "fitness", name: "운동", colorHex: "#8D6E63" },
  { id: "design", name: "디자인", colorHex: "#CBA258" },
]);

const CATEGORY_BY_ID = new Map(GLOBAL_CATEGORIES.map((c) => [c.id, c]));

/**
 * 유저 한 명의 미니 분재를 생성합니다.
 *
 * 격자 전체를 손으로 찍을 수는 없으므로, 결정적 의사 난수로 "바닥에서
 * 위로 자라는" 형태를 만듭니다. 같은 seedId 는 언제나 같은 모양이 나와서
 * 새로고침해도 갤러리가 흔들리지 않습니다.
 *
 * @param {string} seedId 모양을 결정하는 시드
 * @param {number} dotCount 점 개수
 * @param {string[]} categoryIds 사용할 카테고리
 * @returns {Array<{x:number,y:number,type:string,colorHex:string}>}
 */
function growMiniTree(seedId, dotCount, categoryIds) {
  // FNV-1a 로 문자열을 32비트 시드로 접습니다.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seedId.length; i += 1) {
    hash = ((hash ^ seedId.charCodeAt(i)) * 0x01000193) >>> 0;
  }
  let state = hash || 1;
  const random = () => {
    // xorshift32 — 결정적이고 가볍습니다.
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };

  const centerX = Math.floor(COLS / 2);
  const taken = new Set();
  const dots = [];

  /**
   * 카테고리 색을 고릅니다.
   *
   * 순환 배분하면 수관을 중심 거리순으로 채우는 순서와 맞물려 동심원
   * 과녁이 생깁니다. 매번 무작위로 뽑아 잎처럼 섞이게 합니다.
   */
  const nextColor = () => {
    const id = categoryIds[Math.floor(random() * categoryIds.length)];
    return { id, hex: CATEGORY_BY_ID.get(id)?.colorHex ?? PALETTE.branch };
  };

  const put = (x, y, type, forced) => {
    if (x < 0 || x >= COLS || y < 0 || y > GROUND_ROW) return false;
    const key = `${x},${y}`;
    if (taken.has(key)) return false;
    taken.add(key);
    const color = forced ?? nextColor();
    dots.push({
      x,
      y,
      type,
      colorHex: color.hex,
      categoryId: color.id ?? null,
    });
    return true;
  };

  // ── 씨앗
  put(centerX, GROUND_ROW, DOT_TYPE.SEED, { hex: PALETTE.seed, id: null });

  // ── 줄기
  // 높이를 점 개수의 제곱근에 비례시킵니다. 선형으로 묶으면 점이 많은 유저가
  // 격자 천장까지 치솟는 "국수" 가 됩니다. 제곱근이면 점이 늘어날수록
  // 높이보다 수관이 자라, 나무 실루엣이 유지됩니다.
  const trunkHeight = Math.max(
    6,
    Math.min(Math.round(ROWS * 0.46), Math.round(Math.sqrt(dotCount) * 1.7)),
  );
  const trunkTopY = GROUND_ROW - trunkHeight;

  let x = centerX;
  for (let i = 1; i <= trunkHeight; i += 1) {
    if (random() < 0.2) x += random() < 0.5 ? -1 : 1;
    x = Math.max(2, Math.min(COLS - 3, x));
    const y = GROUND_ROW - i;
    put(x, y, DOT_TYPE.BRANCH);
    // 아래쪽일수록 굵게 — 밑동이 두꺼운 분재 느낌
    if (i < trunkHeight * 0.65) put(x + 1, y, DOT_TYPE.BRANCH);
    if (i < trunkHeight * 0.35) put(x - 1, y, DOT_TYPE.BRANCH);
  }

  // ── 가지: 줄기 중상단에서 좌우로, 위로 비스듬히
  const branchAnchors = Math.max(2, Math.round(trunkHeight / 5));
  for (let a = 0; a < branchAnchors; a += 1) {
    const anchorY = trunkTopY + Math.round(((a + 1) / (branchAnchors + 1)) * trunkHeight * 0.9);
    const span = 3 + Math.round(random() * 5);
    for (const dir of [-1, 1]) {
      let bx = x;
      let by = anchorY;
      for (let step = 1; step <= span; step += 1) {
        bx += dir;
        if (step % 2 === 0) by -= 1;
        put(bx, by, DOT_TYPE.BRANCH);
      }
    }
  }

  // ── 수관: 줄기 상단을 중심으로 한 타원 영역을 채웁니다.
  // 남은 점 수에서 반지름을 역산해, 점이 많으면 수관이 넓어집니다.
  const remaining = Math.max(0, dotCount - dots.length);
  const radius = Math.max(3, Math.min(18, Math.round(Math.sqrt(remaining / 2.2))));
  const crownY = Math.max(2, trunkTopY - Math.round(radius * 0.35));

  const cells = [];
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -Math.round(radius * 1.25); dx <= Math.round(radius * 1.25); dx += 1) {
      // 타원: 가로로 살짝 납작하게
      const norm = (dx * dx) / (radius * 1.25 * radius * 1.25) + (dy * dy) / (radius * radius);
      if (norm <= 1) cells.push({ x: x + dx, y: crownY + dy, norm });
    }
  }
  // 중심에서 가까운 칸부터 채워, 점이 모자라도 가운데가 빈 고리가 되지 않게
  cells.sort((a, b) => a.norm - b.norm);
  for (const cell of cells) {
    if (dots.length >= dotCount) break;
    // 바깥쪽은 확률적으로 비워 수관 테두리를 자연스럽게
    if (cell.norm > 0.72 && random() < 0.45) continue;
    put(cell.x, cell.y, DOT_TYPE.LEAF);
  }

  // ── 그래도 모자라면 기존 점의 8방향 이웃으로 메웁니다 (인접 규칙 유지)
  let guard = 0;
  while (dots.length < dotCount && guard < dotCount * 12) {
    guard += 1;
    const anchor = dots[Math.floor(random() * dots.length)];
    const dx = Math.floor(random() * 3) - 1;
    const dy = Math.floor(random() * 3) - 1;
    if (dx === 0 && dy === 0) continue;
    put(anchor.x + dx, anchor.y + dy, DOT_TYPE.LEAF);
  }

  return dots;
}

/** 카테고리 분포를 비중 배열로 만듭니다. */
function splitCategories(totalSeconds, weights) {
  const sum = weights.reduce((acc, w) => acc + w.weight, 0) || 1;
  return weights.map((entry) => {
    const category = CATEGORY_BY_ID.get(entry.id);
    return {
      id: entry.id,
      name: category?.name ?? entry.id,
      colorHex: category?.colorHex ?? PALETTE.branch,
      focusSeconds: Math.round((totalSeconds * entry.weight) / sum),
    };
  });
}

/** 갤러리/리더보드에 올릴 유저 원본 정의 */
const COMMUNITY_SEEDS = [
  { seedId: "SEED-7F3A29", nickname: "집중하는 상민", hours: 1224, likes: 184, dots: 420, days: 520,
    mix: [{ id: "coding", weight: 55 }, { id: "design", weight: 21 }, { id: "reading", weight: 13 }, { id: "fitness", weight: 7 }, { id: "language", weight: 4 }] },
  { seedId: "SEED-A41C07", nickname: "새벽형 주니어", hours: 2310, likes: 412, dots: 760, days: 760,
    mix: [{ id: "coding", weight: 70 }, { id: "major", weight: 18 }, { id: "reading", weight: 12 }] },
  { seedId: "SEED-B92D55", nickname: "토익 950 간다", hours: 1876, likes: 357, dots: 610, days: 690,
    mix: [{ id: "language", weight: 64 }, { id: "reading", weight: 22 }, { id: "fitness", weight: 14 }] },
  { seedId: "SEED-C13E88", nickname: "전공책 씹어먹기", hours: 980, likes: 142, dots: 330, days: 430,
    mix: [{ id: "major", weight: 72 }, { id: "coding", weight: 18 }, { id: "reading", weight: 10 }] },
  { seedId: "SEED-D77A21", nickname: "야간 러너", hours: 640, likes: 96, dots: 215, days: 300,
    mix: [{ id: "fitness", weight: 48 }, { id: "reading", weight: 30 }, { id: "language", weight: 22 }] },
  { seedId: "SEED-E05B64", nickname: "픽셀 장인", hours: 1540, likes: 523, dots: 540, days: 600,
    mix: [{ id: "design", weight: 58 }, { id: "coding", weight: 30 }, { id: "major", weight: 12 }] },
  { seedId: "SEED-F38C92", nickname: "조용한 독서가", hours: 412, likes: 71, dots: 140, days: 220,
    mix: [{ id: "reading", weight: 76 }, { id: "language", weight: 24 }] },
  { seedId: "SEED-104D1B", nickname: "알고리즘 정복", hours: 3105, likes: 688, dots: 980, days: 880,
    mix: [{ id: "coding", weight: 82 }, { id: "major", weight: 18 }] },
  { seedId: "SEED-2B6E40", nickname: "작심삼일 탈출", hours: 96, likes: 18, dots: 36, days: 60,
    mix: [{ id: "language", weight: 50 }, { id: "fitness", weight: 50 }] },
  { seedId: "SEED-3C8F77", nickname: "논문 스프린트", hours: 1680, likes: 241, dots: 580, days: 610,
    mix: [{ id: "major", weight: 60 }, { id: "coding", weight: 25 }, { id: "reading", weight: 15 }] },
  { seedId: "SEED-4D9028", nickname: "매일 한 시간", hours: 730, likes: 134, dots: 248, days: 365,
    mix: [{ id: "reading", weight: 40 }, { id: "language", weight: 35 }, { id: "fitness", weight: 25 }] },
  { seedId: "SEED-5EA135", nickname: "주말 몰아치기", hours: 288, likes: 44, dots: 98, days: 150,
    mix: [{ id: "coding", weight: 45 }, { id: "design", weight: 40 }, { id: "major", weight: 15 }] },
  { seedId: "SEED-6FB249", nickname: "중간고사 생존", hours: 520, likes: 88, dots: 176, days: 240,
    mix: [{ id: "major", weight: 68 }, { id: "reading", weight: 32 }] },
  { seedId: "SEED-70C356", nickname: "꾸준함이 전부", hours: 2740, likes: 601, dots: 880, days: 820,
    mix: [{ id: "coding", weight: 40 }, { id: "language", weight: 30 }, { id: "major", weight: 20 }, { id: "fitness", weight: 10 }] },
];

/** 갤러리 / 리더보드용 유저 목록. `GET /api/community/feed` 와 같은 형태. */
export const MOCK_COMMUNITY_FEED = Object.freeze(
  COMMUNITY_SEEDS.map((entry, index) => {
    const totalSeconds = entry.hours * 3600;
    const categories = splitCategories(totalSeconds, entry.mix);
    const categoryIds = entry.mix.map((m) => m.id);

    return Object.freeze({
      seedId: entry.seedId,
      nickname: entry.nickname,
      totalFocusSeconds: totalSeconds,
      /** 레벨 — iOS FocusProgressionEngine 과 같은 곡선: n(n-1)/2 시간 */
      level: Math.max(1, Math.floor((1 + Math.sqrt(1 + 8 * entry.hours)) / 2)),
      likes: entry.likes,
      dotCount: entry.dots,
      activeDays: entry.days,
      /** 대표 카테고리 = 비중 1위 */
      primaryCategory: categories.slice().sort((a, b) => b.focusSeconds - a.focusSeconds)[0],
      categories,
      grid: { cols: COLS, rows: ROWS },
      dots: growMiniTree(entry.seedId, entry.dots, categoryIds),
      // 최신순 정렬용. 인덱스를 시간 간격으로 흩뜨립니다.
      syncedAt: new Date(EXPORT_EPOCH_MS - index * 5 * 3_600_000).toISOString(),
    });
  }),
);

/** 전역 집계 통계. `GET /api/community/stats` 와 같은 형태. */
export const MOCK_COMMUNITY_STATS = Object.freeze(buildCommunityStats());

/**
 * 피드에서 전역 통계를 집계합니다.
 *
 * Worker 쪽 집계와 같은 식을 쓰므로, 목 데이터로 본 화면과 실데이터로 본
 * 화면의 숫자 의미가 달라지지 않습니다.
 */
function buildCommunityStats() {
  const users = COMMUNITY_SEEDS.map((entry) => ({
    totalSeconds: entry.hours * 3600,
    days: entry.days,
    mix: entry.mix,
  }));

  const userCount = users.length;
  const totalFocusSeconds = users.reduce((sum, u) => sum + u.totalSeconds, 0);

  // 카테고리별 전역 점유율
  const byCategory = new Map();
  for (const user of users) {
    const weightSum = user.mix.reduce((acc, m) => acc + m.weight, 0) || 1;
    for (const slice of user.mix) {
      const seconds = (user.totalSeconds * slice.weight) / weightSum;
      byCategory.set(slice.id, (byCategory.get(slice.id) ?? 0) + seconds);
    }
  }

  const categoryShare = [...byCategory.entries()]
    .map(([id, seconds]) => {
      const category = CATEGORY_BY_ID.get(id);
      return {
        id,
        name: category?.name ?? id,
        colorHex: category?.colorHex ?? PALETTE.branch,
        focusSeconds: Math.round(seconds),
        share: totalFocusSeconds > 0 ? (seconds / totalFocusSeconds) * 100 : 0,
      };
    })
    .sort((a, b) => b.focusSeconds - a.focusSeconds);

  // 일일 평균: 유저별 (총 집중 / 활동일) 의 평균
  const dailyAverages = users
    .filter((u) => u.days > 0)
    .map((u) => u.totalSeconds / u.days);
  const averageDailySeconds =
    dailyAverages.length > 0
      ? dailyAverages.reduce((a, b) => a + b, 0) / dailyAverages.length
      : 0;

  return {
    userCount,
    totalFocusSeconds,
    averageFocusSeconds: userCount > 0 ? Math.round(totalFocusSeconds / userCount) : 0,
    averageDailySeconds: Math.round(averageDailySeconds),
    medianFocusSeconds: median(users.map((u) => u.totalSeconds)),
    categoryShare,
    updatedAt: new Date(EXPORT_EPOCH_MS).toISOString(),
  };
}

/** 중앙값 (짝수 개면 두 값의 평균) */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** 피드 사본을 반환 (렌더러가 원본을 변형하지 못하도록) */
export function getMockCommunityFeed() {
  return structuredClone
    ? structuredClone(MOCK_COMMUNITY_FEED)
    : JSON.parse(JSON.stringify(MOCK_COMMUNITY_FEED));
}

/** 전역 통계 사본을 반환 */
export function getMockCommunityStats() {
  return structuredClone
    ? structuredClone(MOCK_COMMUNITY_STATS)
    : JSON.parse(JSON.stringify(MOCK_COMMUNITY_STATS));
}
