/**
 * worker.js — SilTime Cloudflare Worker
 *
 * 라우트
 * ──────
 *   GET  /api/health                   헬스체크
 *   GET  /api/tree/:seedId             트리 단건 조회
 *   POST /api/tree/sync                iOS 앱이 트리를 올림
 *   POST /api/tree/:seedId/like        좋아요 +1
 *   GET  /api/community/feed           갤러리·리더보드용 유저 목록
 *   GET  /api/community/stats          전역 집계 통계
 *
 * KV 레이아웃
 * ───────────
 *   tree:<SEED_ID>    → 트리 전체 (도트 배열 포함). 무거우므로 단건 조회만.
 *   index:users       → 가벼운 요약 배열. 피드/통계가 읽는 유일한 키.
 *   likes:<SEED_ID>   → 좋아요 카운터 (문자열 숫자)
 *
 * 왜 인덱스를 따로 두는가
 * ───────────────────────
 * KV 는 `list()` 로 키를 훑을 수 있지만 값은 하나씩 `get()` 해야 합니다.
 * 유저가 500명이면 피드 한 번에 500번 읽기가 되고, 지연과 과금이 같이
 * 폭발합니다. 그래서 sync 시점에 요약만 뽑아 `index:users` 한 키에
 * 모아 둡니다. 피드는 KV 읽기 1번, 통계도 1번입니다.
 *
 * 인덱스에는 도트 배열을 **요약해서** 넣습니다. 갤러리 썸네일에는 좌표가
 * 필요하지만 전체(최대 3,072개)를 다 넣으면 인덱스가 25MB 제한을 넘깁니다.
 * `MAX_THUMBNAIL_DOTS` 개로 추려 넣고, 자세한 건 단건 조회에서 봅니다.
 *
 * 바인딩 (wrangler.toml)
 * ─────────────────────
 *   [[kv_namespaces]]
 *   binding = "SILTIME_KV"
 *   id = "<네임스페이스 ID>"
 *
 *   [vars]
 *   ALLOWED_ORIGIN = "*"                # 선택: CORS 허용 오리진
 *   SYNC_TOKEN = "<임의의 긴 문자열>"   # 선택: 운영자용 전체 잠금 (아래 참고)
 *
 * 쓰기 보호 — 누가 이 Seed ID 를 올릴 수 있나
 * ────────────────────────────────────────────
 * 사용자가 비밀번호를 입력하게 하지 않습니다. 대신 앱이 기기마다 무작위 "소유 열쇠"를
 * 만들어 `X-Owner-Key` 헤더로 보내고, 서버는 Seed ID 를 **처음 올린 열쇠의 해시**를
 * `owner:<SEED_ID>` 에 기억합니다. 그 뒤로는 같은 열쇠만 그 Seed ID 를 고칠 수
 * 있습니다 (처음 온 쪽이 점유하는 방식). 열쇠 원본은 서버에 저장하지 않습니다.
 *
 * 이것이 막는 것: 공개 갤러리에서 남의 Seed ID 를 보고 그 나무를 덮어쓰는 일.
 * 막지 못하는 것: 새 Seed ID 를 무한히 만들어 올리는 도배. 그래서 요청 크기
 * (`MAX_BODY_BYTES`)와 피드 인원(`MAX_INDEX_USERS`)에 상한을 둡니다.
 * 좋아요 위조도 막지 않습니다 (아래 handleLike 참고).
 *
 * `SYNC_TOKEN` 은 이제 선택입니다. 설정하면 소유 열쇠에 더해 Bearer 토큰도 요구하는
 * 운영자용 전체 잠금이 됩니다. 일반 사용자에게 입력시킬 값이 아니므로, 평소에는
 * 이 값을 지워 두세요.
 */

/* ─────────────────────────── 상수 ─────────────────────────── */

/** 격자 — iOS 앱과 반드시 일치해야 합니다. */
const COLS = 48;
const ROWS = 64;

/** 인덱스에 보관할 썸네일 도트 최대 개수 */
const MAX_THUMBNAIL_DOTS = 700;

/** 피드 기본/최대 반환 개수 */
const DEFAULT_FEED_LIMIT = 50;
const MAX_FEED_LIMIT = 200;

/** KV 키 */
const KEY_USER_INDEX = "index:users";
const keyTree = (seedId) => `tree:${seedId}`;
const keyLikes = (seedId) => `likes:${seedId}`;
const keyOwner = (seedId) => `owner:${seedId}`;

/** 1 EXP = 60초, 레벨 n 진입 = n(n-1)/2 시간 — iOS FocusProgressionEngine 과 동일 */
const SECONDS_PER_EXP = 60;

/** sync 본문 최대 크기 (바이트). 3,072점 나무도 약 190KB 라 넉넉하고, 도배는 막습니다. */
const MAX_BODY_BYTES = 300 * 1024;

/**
 * 피드 인덱스에 보관할 최대 인원. 넘으면 가장 오래 전에 올린 사람부터 피드에서 빠집니다
 * (나무 원본은 남아서 Seed ID 로는 계속 조회됩니다). 인덱스는 한 KV 값(25MB 제한)이고
 * 한 사람이 최대 수십 KB 라서, 상한이 없으면 도배로 인덱스가 터져 모두의 동기화가
 * 멈춥니다.
 */
const MAX_INDEX_USERS = 200;

/** 소유 열쇠 형식: 앱이 만드는 16진수 문자열 (32~128자). */
const OWNER_KEY_PATTERN = /^[0-9a-f]{32,128}$/;

/* ─────────────────────────── 엔트리 ─────────────────────────── */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS 사전 요청
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    try {
      // GET /api/health
      if (pathname === "/api/health" && request.method === "GET") {
        return json({ ok: true, grid: { cols: COLS, rows: ROWS } }, 200, env);
      }

      // POST /api/tree/sync
      if (pathname === "/api/tree/sync" && request.method === "POST") {
        return await handleSync(request, env);
      }

      // POST /api/tree/:seedId/like
      const likeMatch = pathname.match(/^\/api\/tree\/([^/]+)\/like$/);
      if (likeMatch && request.method === "POST") {
        return await handleLike(decodeURIComponent(likeMatch[1]), env);
      }

      // GET /api/tree/:seedId
      const treeMatch = pathname.match(/^\/api\/tree\/([^/]+)$/);
      if (treeMatch && request.method === "GET") {
        return await handleGetTree(decodeURIComponent(treeMatch[1]), env);
      }

      // GET /api/community/feed
      if (pathname === "/api/community/feed" && request.method === "GET") {
        return await handleFeed(url, env);
      }

      // GET /api/community/stats
      if (pathname === "/api/community/stats" && request.method === "GET") {
        return await handleStats(env);
      }

      return json({ error: "not_found", path: pathname }, 404, env);
    } catch (error) {
      // 예상 못 한 예외를 500 으로 흘려보내지 않고 형태를 맞춰 돌려줍니다.
      // 클라이언트의 폴백 로직이 일관되게 동작해야 합니다.
      return json({ error: "internal_error", message: String(error?.message ?? error) }, 500, env);
    }
  },
};

/* ─────────────────────────── 핸들러 ─────────────────────────── */

/**
 * `GET /api/tree/:seedId`
 *
 * 저장된 트리에 현재 좋아요 수를 합쳐 돌려줍니다. 좋아요는 별도 키라서
 * 트리를 다시 쓰지 않고도 카운터만 올릴 수 있습니다 (쓰기 경쟁 최소화).
 */
async function handleGetTree(rawSeedId, env) {
  const seedId = normalizeSeedId(rawSeedId);
  if (!seedId) return json({ error: "invalid_seed_id" }, 400, env);

  const stored = await env.SILTIME_KV.get(keyTree(seedId), "json");
  if (!stored) return json({ error: "not_found", seedId }, 404, env);

  const likes = await readLikes(env, seedId);
  return json({ ...stored, seedId, likes }, 200, env);
}

/**
 * `POST /api/tree/sync`
 *
 * iOS 앱이 트리 전체를 올립니다. 두 곳에 씁니다.
 *   1. `tree:<SEED_ID>` — 원본 전체
 *   2. `index:users`    — 피드/통계가 읽는 요약 (업서트)
 *
 * 검사 순서와 응답
 *   401 unauthorized       운영자 잠금(SYNC_TOKEN)을 켰는데 토큰이 틀림
 *   401 missing_owner_key  X-Owner-Key 가 없거나 형식이 틀림
 *   413 payload_too_large  본문이 MAX_BODY_BYTES 초과 (본문을 읽기 전에 Content-Length 로 먼저 거름)
 *   400 invalid_json / invalid_seed_id / empty_tree
 *   403 not_owner          이 Seed ID 를 먼저 올린 다른 열쇠가 있음
 *
 * 소유 확인은 본문 검증을 모두 통과한 뒤에 합니다. 쓸모없는 요청으로 Seed ID 가
 * 점유되는 일을 막기 위해서입니다.
 */
async function handleSync(request, env) {
  // 0) 운영자 전체 잠금 (선택)
  if (env.SYNC_TOKEN) {
    const auth = request.headers.get("Authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== env.SYNC_TOKEN) {
      return json({ error: "unauthorized" }, 401, env);
    }
  }

  // 1) 소유 열쇠 형식
  const ownerKey = request.headers.get("X-Owner-Key") ?? "";
  if (!OWNER_KEY_PATTERN.test(ownerKey)) {
    return json({ error: "missing_owner_key" }, 401, env);
  }

  // 2) 크기 제한. 선언된 길이로 먼저 거르고, 실제로 읽은 뒤에도 한 번 더 잽니다
  //    (Content-Length 는 거짓일 수 있고 chunked 요청에는 없습니다).
  const declared = Number.parseInt(request.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", limit: MAX_BODY_BYTES }, 413, env);
  }
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return json({ error: "payload_too_large", limit: MAX_BODY_BYTES }, 413, env);
  }

  // 3) 본문 검증
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400, env);
  }

  const tree = normalizeTree(payload);
  if (!tree.seedId) return json({ error: "invalid_seed_id" }, 400, env);
  if (tree.dots.length === 0) return json({ error: "empty_tree" }, 400, env);

  // 4) 소유 확인. 처음 오는 열쇠는 이 Seed ID 를 점유하고, 이후에는 같은 열쇠만 통과합니다.
  const keyHash = await sha256Hex(ownerKey);
  const claimed = await env.SILTIME_KV.get(keyOwner(tree.seedId));
  if (claimed) {
    if (!safeEqual(claimed, keyHash)) {
      return json({ error: "not_owner", seedId: tree.seedId }, 403, env);
    }
  } else {
    await env.SILTIME_KV.put(keyOwner(tree.seedId), keyHash);
  }

  const likes = await readLikes(env, tree.seedId);

  // 1) 원본 저장
  await env.SILTIME_KV.put(
    keyTree(tree.seedId),
    JSON.stringify({ ...tree, syncedAt: new Date().toISOString() }),
  );

  // 2) 인덱스 업서트
  const index = await readUserIndex(env);
  const summary = summarize(tree, likes);
  const position = index.findIndex((entry) => entry.seedId === tree.seedId);
  if (position >= 0) index[position] = summary;
  else index.push(summary);

  await writeUserIndex(env, capIndex(index));

  return json({ ok: true, seedId: tree.seedId, dotCount: tree.dots.length, likes }, 200, env);
}

/**
 * `POST /api/tree/:seedId/like`
 *
 * 카운터만 올립니다. 트리 본문은 건드리지 않습니다.
 *
 * 경쟁 조건에 대하여
 * ─────────────────
 * KV 는 원자적 증감을 제공하지 않습니다. read-modify-write 사이에 다른
 * 요청이 끼면 1 이 유실될 수 있습니다. 좋아요 카운터는 정확한 회계가
 * 아니라 인기 신호이므로 이 정도 오차를 허용합니다.
 * 엄격한 집계가 필요하면 Durable Objects 로 옮겨야 합니다.
 *
 * 중복 방지도 여기서는 하지 않습니다. 브라우저의 localStorage 가 1차
 * 방어선이고(`js/likeStore.js`), 서버 단에서 막으려면 IP 해시나 계정이
 * 필요합니다. 지금 구조에서는 "같은 사람"을 식별할 방법이 없습니다.
 */
async function handleLike(rawSeedId, env) {
  const seedId = normalizeSeedId(rawSeedId);
  if (!seedId) return json({ error: "invalid_seed_id" }, 400, env);

  // 존재하지 않는 Seed 에 좋아요가 쌓이면 유령 카운터가 남습니다.
  const exists = await env.SILTIME_KV.get(keyTree(seedId));
  if (!exists) return json({ error: "not_found", seedId }, 404, env);

  const next = (await readLikes(env, seedId)) + 1;
  await env.SILTIME_KV.put(keyLikes(seedId), String(next));

  // 인덱스의 likes 도 맞춰 둡니다. 안 하면 인기순 정렬이 과거 값으로
  // 돌아가, 방금 누른 하트가 순위에 반영되지 않습니다.
  const index = await readUserIndex(env);
  const entry = index.find((item) => item.seedId === seedId);
  if (entry) {
    entry.likes = next;
    await writeUserIndex(env, index);
  }

  return json({ ok: true, seedId, likes: next }, 200, env);
}

/**
 * `GET /api/community/feed?sort=recent|popular&limit=50`
 *
 * 인덱스 한 키만 읽습니다. 유저가 몇 명이든 KV 읽기는 1회입니다.
 */
async function handleFeed(url, env) {
  const sort = url.searchParams.get("sort") === "popular" ? "popular" : "recent";
  const limit = clampInt(
    url.searchParams.get("limit"),
    1,
    MAX_FEED_LIMIT,
    DEFAULT_FEED_LIMIT,
  );

  const index = await readUserIndex(env);
  const users = sortUsers(index, sort).slice(0, limit);

  return json({ users, total: index.length, sort }, 200, env);
}

/**
 * `GET /api/community/stats`
 *
 * 전역 누적/평균/카테고리 점유율을 집계합니다.
 * 프론트의 `mockData.buildCommunityStats` 와 같은 식을 씁니다 — 목으로 본
 * 화면과 실데이터로 본 화면의 숫자 의미가 달라지면 안 됩니다.
 */
async function handleStats(env) {
  const index = await readUserIndex(env);
  return json(aggregateStats(index), 200, env);
}

/* ─────────────────────────── KV 보조 ─────────────────────────── */

async function readUserIndex(env) {
  const stored = await env.SILTIME_KV.get(KEY_USER_INDEX, "json");
  return Array.isArray(stored) ? stored : [];
}

async function writeUserIndex(env, index) {
  await env.SILTIME_KV.put(KEY_USER_INDEX, JSON.stringify(index));
}

async function readLikes(env, seedId) {
  const raw = await env.SILTIME_KV.get(keyLikes(seedId));
  const value = Number.parseInt(raw ?? "0", 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/* ─────────────────────────── 소유 열쇠 / 인덱스 상한 ─────────────────────────── */

/** 문자열의 SHA-256 을 소문자 16진수로. 열쇠 원본 대신 이 해시만 저장합니다. */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 같은 길이의 문자열을 끝까지 비교합니다. 첫 불일치에서 멈추는 `===` 와 달리 걸리는
 * 시간이 내용에 덜 의존하게 해서, 응답 시간으로 해시를 한 글자씩 알아내는 공격을
 * 어렵게 합니다.
 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 인덱스를 `MAX_INDEX_USERS` 명으로 맞춥니다. 넘치면 가장 오래 전에 올린 사람부터 뺍니다.
 * 빠진 사람의 `tree:` 원본은 그대로라 Seed ID 로는 계속 조회됩니다.
 */
function capIndex(index) {
  if (index.length <= MAX_INDEX_USERS) return index;
  return index
    .slice()
    .sort((a, b) => Date.parse(b.syncedAt ?? 0) - Date.parse(a.syncedAt ?? 0))
    .slice(0, MAX_INDEX_USERS);
}

/* ─────────────────────────── 정규화 / 집계 ─────────────────────────── */

/** Seed ID 정규화. 허용 문자만 남겨 KV 키 오염을 막습니다. */
function normalizeSeedId(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toUpperCase();
  return /^[A-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : "";
}

/**
 * 업로드 페이로드를 신뢰하지 않고 형태를 강제합니다.
 *
 * 격자 밖 좌표, 숫자가 아닌 값, 색이 아닌 colorHex 는 전부 걸러냅니다.
 * 클라이언트가 보낸 값을 그대로 저장하면 렌더러가 깨집니다.
 */
function normalizeTree(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const body = source.tree && typeof source.tree === "object" ? source.tree : source;

  const categories = (Array.isArray(body.categories) ? body.categories : [])
    .map((category, index) => ({
      id: String(category?.id ?? `category-${index}`),
      name: String(category?.name ?? "미분류").slice(0, 40),
      colorHex: normalizeHex(category?.colorHex),
      focusSeconds: clampNumber(category?.focusSeconds, 0),
    }))
    .slice(0, 40);

  const dots = (Array.isArray(body.dots) ? body.dots : [])
    .map((dot) => ({
      x: Math.round(clampNumber(dot?.x, -1)),
      y: Math.round(clampNumber(dot?.y, -1)),
      type: String(dot?.type ?? "branch").slice(0, 16),
      categoryId: dot?.categoryId != null ? String(dot.categoryId).slice(0, 40) : null,
      colorHex: normalizeHex(dot?.colorHex, null),
      count: Math.max(1, Math.round(clampNumber(dot?.count, 1))),
      focusSeconds: clampNumber(dot?.focusSeconds, 0),
      createdAt: typeof dot?.createdAt === "string" ? dot.createdAt.slice(0, 40) : null,
    }))
    .filter((dot) => dot.x >= 0 && dot.y >= 0 && dot.x < COLS && dot.y < ROWS);

  const categoryTotal = categories.reduce((sum, c) => sum + c.focusSeconds, 0);

  return {
    schemaVersion: String(body.schemaVersion ?? "1.2").slice(0, 16),
    seedId: normalizeSeedId(body.seedId),
    nickname: String(body.nickname ?? body.ownerNickname ?? "익명 사용자").slice(0, 40),
    ownerNickname: String(body.ownerNickname ?? body.nickname ?? "익명 사용자").slice(0, 40),
    grid: { cols: COLS, rows: ROWS },
    globalFocusSeconds: clampNumber(body.globalFocusSeconds, categoryTotal),
    sessionCount: clampNumber(body.sessionCount, 0),
    activeDays: clampNumber(body.activeDays, 0),
    longestStreakDays: clampNumber(body.longestStreakDays, 0),
    exportedAt: typeof body.exportedAt === "string" ? body.exportedAt.slice(0, 40) : null,
    milestone: { stageId: body.milestone?.stageId ? String(body.milestone.stageId).slice(0, 32) : null },
    categories,
    dots,
  };
}

/**
 * 트리를 인덱스용 요약으로 줄입니다.
 *
 * 썸네일 도트는 `MAX_THUMBNAIL_DOTS` 개까지만 담습니다. 넘치면 균등
 * 샘플링으로 솎아내는데, 앞부분만 자르지 않는 이유는 도트가 성장 순서
 * (바닥→위)로 저장되기 때문입니다. 앞만 남기면 썸네일이 줄기만 남은
 * 몽당나무가 됩니다. 균등 샘플링은 전체 형태를 유지합니다.
 */
function summarize(tree, likes) {
  const sorted = tree.categories
    .slice()
    .sort((a, b) => b.focusSeconds - a.focusSeconds);

  return {
    seedId: tree.seedId,
    nickname: tree.nickname,
    totalFocusSeconds: tree.globalFocusSeconds,
    level: levelForSeconds(tree.globalFocusSeconds),
    likes,
    dotCount: tree.dots.length,
    activeDays: tree.activeDays,
    primaryCategory: sorted[0] ?? null,
    categories: sorted,
    grid: { cols: COLS, rows: ROWS },
    dots: sampleDots(tree.dots, MAX_THUMBNAIL_DOTS),
    syncedAt: new Date().toISOString(),
  };
}

/** 균등 샘플링 — 전체 실루엣을 유지하며 개수를 줄입니다. */
function sampleDots(dots, max) {
  if (dots.length <= max) return dots;

  const step = dots.length / max;
  const result = [];
  for (let i = 0; i < max; i += 1) {
    result.push(dots[Math.floor(i * step)]);
  }
  return result;
}

/**
 * 누적 집중 초 → 레벨.
 *
 * iOS `FocusProgressionEngine` 과 같은 곡선입니다.
 *   requiredExp(n) = 30n(n-1), 1 EXP = 60초
 *   ⇒ n(n-1)/2 시간이면 레벨 n
 *   ⇒ n = floor((1 + sqrt(1 + 8h)) / 2)
 */
function levelForSeconds(seconds) {
  const hours = Math.max(0, seconds) / 3600;
  const level = Math.floor((1 + Math.sqrt(1 + 8 * hours)) / 2);
  return Math.max(1, Math.min(99, level));
}

/** 정렬 — 프론트 `api.sortFeed` 와 같은 규칙 */
function sortUsers(users, sort) {
  const list = users.slice();
  if (sort === "popular") {
    list.sort(
      (a, b) =>
        (b.likes ?? 0) - (a.likes ?? 0) ||
        (b.totalFocusSeconds ?? 0) - (a.totalFocusSeconds ?? 0),
    );
  } else {
    list.sort((a, b) => Date.parse(b.syncedAt ?? 0) - Date.parse(a.syncedAt ?? 0));
  }
  return list;
}

/** 전역 통계 집계 */
function aggregateStats(users) {
  const userCount = users.length;
  const totals = users.map((u) => Math.max(0, Number(u.totalFocusSeconds) || 0));
  const totalFocusSeconds = totals.reduce((sum, value) => sum + value, 0);

  // 카테고리별 전역 점유율
  const byCategory = new Map();
  for (const user of users) {
    for (const category of Array.isArray(user.categories) ? user.categories : []) {
      const id = String(category?.id ?? "uncategorized");
      const seconds = Math.max(0, Number(category?.focusSeconds) || 0);
      const existing = byCategory.get(id);
      if (existing) {
        existing.focusSeconds += seconds;
      } else {
        byCategory.set(id, {
          id,
          name: String(category?.name ?? id),
          colorHex: normalizeHex(category?.colorHex),
          focusSeconds: seconds,
        });
      }
    }
  }

  const categorySum = [...byCategory.values()].reduce((s, c) => s + c.focusSeconds, 0);
  const categoryShare = [...byCategory.values()]
    .map((category) => ({
      ...category,
      share: categorySum > 0 ? (category.focusSeconds / categorySum) * 100 : 0,
    }))
    .sort((a, b) => b.focusSeconds - a.focusSeconds);

  // 일일 평균: 유저별 (총 집중 / 활동일) 의 평균.
  // 전체합/전체일수로 계산하면 헤비 유저가 평균을 지배합니다.
  const dailyAverages = users
    .map((u) => {
      const days = Math.max(0, Number(u.activeDays) || 0);
      const seconds = Math.max(0, Number(u.totalFocusSeconds) || 0);
      return days > 0 ? seconds / days : null;
    })
    .filter((value) => value != null);

  return {
    userCount,
    totalFocusSeconds,
    averageFocusSeconds: userCount > 0 ? Math.round(totalFocusSeconds / userCount) : 0,
    averageDailySeconds:
      dailyAverages.length > 0
        ? Math.round(dailyAverages.reduce((a, b) => a + b, 0) / dailyAverages.length)
        : 0,
    medianFocusSeconds: median(totals),
    categoryShare,
    updatedAt: new Date().toISOString(),
  };
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/* ─────────────────────────── 유틸 ─────────────────────────── */

function normalizeHex(value, fallback = "#B3B3B3") {
  if (typeof value !== "string") return fallback;
  const hex = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase();
  return fallback;
}

function clampNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env?.ALLOWED_ORIGIN ?? "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Owner-Key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // 뷰어가 항상 최신을 보도록 캐시를 끕니다.
      "Cache-Control": "no-store",
      ...corsHeaders(env),
    },
  });
}

/* ───────────────────────────────────────────────────────────────────────────
   테스트 훅
   wrangler 런타임 없이 핸들러 로직을 단위 테스트할 수 있게 내부 함수를
   노출합니다. 런타임 동작에는 영향이 없습니다.
   ─────────────────────────────────────────────────────────────────────────── */
export const __internals = {
  sha256Hex,
  safeEqual,
  capIndex,
  MAX_BODY_BYTES,
  MAX_INDEX_USERS,
  keyOwner,
  normalizeSeedId,
  normalizeTree,
  summarize,
  sampleDots,
  levelForSeconds,
  sortUsers,
  aggregateStats,
  normalizeHex,
  median,
  COLS,
  ROWS,
  MAX_THUMBNAIL_DOTS,
  KEY_USER_INDEX,
  keyTree,
  keyLikes,
};
