/**
 * api.js — Cloudflare Worker 통신 레이어
 *
 * 화면 코드가 fetch / 타임아웃 / 폴백을 직접 다루지 않게 한 겹 감쌉니다.
 * 설계 원칙 두 가지:
 *
 *   1. 화면은 절대 비어 있지 않다.
 *      Worker 가 없거나 죽어 있으면 mockData 로 폴백합니다. 졸업작품 시연
 *      중에 네트워크가 끊겨도 갤러리와 랭킹이 그대로 보입니다.
 *
 *   2. 폴백은 숨기지 않는다.
 *      모든 결과가 `source: "live" | "mock"` 을 달고 나오므로, 화면이
 *      "샘플 데이터" 배지를 정직하게 띄울 수 있습니다.
 */

import { API_ENDPOINTS, REQUEST_TIMEOUT_MS } from "./config.js";
import {
  getMockCommunityFeed,
  getMockCommunityStats,
  getMockTree,
  getMockTreeFor,
} from "./mockData.js";

/**
 * @typedef {Object} ApiResult
 * @property {any} data 응답 본문 (실패 시 목 데이터)
 * @property {"live"|"mock"} source 어디서 온 데이터인지
 * @property {string|null} error 실패 사유 (성공이면 null)
 */

/* ─────────────────────────── 공통 fetch ─────────────────────────── */

/**
 * 타임아웃이 붙은 JSON fetch.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function fetchJSON(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      mode: "cors",
      cache: "no-store",
      ...options,
      headers: { Accept: "application/json", ...(options.headers ?? {}) },
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

/** 오류를 사람이 읽을 수 있는 한 줄로 */
function describe(error) {
  if (error?.name === "AbortError") return "요청 시간 초과";
  return String(error?.message ?? "알 수 없는 오류");
}

/**
 * 조회 후 실패하면 목 데이터로 폴백합니다.
 *
 * @param {() => Promise<any>} load 실제 조회
 * @param {() => any} fallback 목 데이터 생성
 * @returns {Promise<ApiResult>}
 */
async function withFallback(load, fallback) {
  try {
    const data = await load();
    return { data, source: "live", error: null };
  } catch (error) {
    return { data: fallback(), source: "mock", error: describe(error) };
  }
}

/* ─────────────────────────── 트리 ─────────────────────────── */

/**
 * `GET /api/tree/:seedId`
 *
 * @param {string} seedId
 * @returns {Promise<ApiResult>}
 */
export function fetchTree(seedId) {
  return withFallback(
    () => fetchJSON(API_ENDPOINTS.tree(seedId)),
    // 샘플 유저를 조회했다면 그 사람의 샘플 전적을, 아니면 대표 샘플 나무를 줍니다.
    () => getMockTreeFor(seedId) ?? getMockTree(),
  );
}

/* ─────────────────────────── 커뮤니티 ─────────────────────────── */

/**
 * `GET /api/community/feed`
 *
 * 정렬은 서버에 넘기되, 폴백 경로에서는 클라이언트가 직접 정렬합니다.
 * 그래서 Worker 가 없어도 [최신순 / 인기순] 필터가 실제로 동작합니다.
 *
 * @param {Object} [params]
 * @param {"recent"|"popular"} [params.sort]
 * @param {number} [params.limit]
 * @returns {Promise<ApiResult>}
 */
export function fetchCommunityFeed({ sort = "recent", limit } = {}) {
  return withFallback(
    async () => {
      const payload = await fetchJSON(API_ENDPOINTS.feed({ sort, limit }));
      // Worker 가 { users: [...] } 로 감싸든 배열을 바로 주든 받아들입니다.
      return Array.isArray(payload) ? payload : (payload?.users ?? []);
    },
    () => sortFeed(getMockCommunityFeed(), sort, limit),
  );
}

/**
 * `GET /api/community/stats`
 *
 * @returns {Promise<ApiResult>}
 */
export function fetchCommunityStats() {
  return withFallback(
    () => fetchJSON(API_ENDPOINTS.communityStats()),
    () => getMockCommunityStats(),
  );
}

/**
 * `POST /api/tree/:seedId/like`
 *
 * 폴백이 없습니다. 좋아요는 "읽기"가 아니라 "쓰기"라서, 실패를 목 데이터로
 * 가리면 사용자는 올라갔다고 믿지만 서버에는 아무것도 남지 않습니다.
 * 실패는 실패로 돌려주고, 호출한 쪽이 낙관적 증가를 되돌립니다.
 *
 * @param {string} seedId
 * @returns {Promise<{ok: boolean, likes: number|null, error: string|null}>}
 */
export async function postLike(seedId) {
  try {
    const payload = await fetchJSON(API_ENDPOINTS.like(seedId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seedId }),
    });
    const likes = Number(payload?.likes);
    return {
      ok: true,
      likes: Number.isFinite(likes) ? likes : null,
      error: null,
    };
  } catch (error) {
    return { ok: false, likes: null, error: describe(error) };
  }
}

/* ─────────────────────────── 정렬 (폴백 경로) ─────────────────────────── */

/**
 * 피드를 정렬하고 자릅니다. Worker 쪽 정렬과 같은 규칙입니다.
 *
 * @param {Array<Object>} users
 * @param {"recent"|"popular"} sort
 * @param {number} [limit]
 */
export function sortFeed(users, sort = "recent", limit) {
  const list = Array.isArray(users) ? users.slice() : [];

  if (sort === "popular") {
    // 좋아요 내림차순. 동수면 누적 시간이 많은 쪽을 올려 순서를 확정합니다.
    list.sort(
      (a, b) =>
        (b.likes ?? 0) - (a.likes ?? 0) ||
        (b.totalFocusSeconds ?? 0) - (a.totalFocusSeconds ?? 0),
    );
  } else {
    list.sort((a, b) => parseTime(b.syncedAt) - parseTime(a.syncedAt));
  }

  return typeof limit === "number" && limit > 0 ? list.slice(0, limit) : list;
}

function parseTime(value) {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? 0 : time;
}
