/**
 * searchHistory.js — 최근 조회한 Seed ID 기록과 즐겨찾기(핀) 관리
 *
 * OP.GG 의 "최근 검색 / 즐겨찾기" 패턴을 그대로 옮긴 모듈입니다.
 * 저장 형태: [{ seedId, nickname, pinned, viewedAt }]
 *  - 핀 고정 항목은 개수 제한에서 제외됩니다.
 *  - localStorage 접근이 막힌 환경(프라이빗 모드)에서도 메모리로 동작합니다.
 */

import { MAX_HISTORY_ITEMS, STORAGE_KEY_SEARCH_HISTORY } from "./config.js";

export class SearchHistory {
  constructor() {
    /** @type {Array<{seedId:string, nickname:string, pinned:boolean, viewedAt:string}>} */
    this.items = this.#load();
  }

  /** 핀 고정 우선 → 최근 조회 순으로 정렬된 목록 */
  list() {
    return this.items.slice().sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return Date.parse(b.viewedAt) - Date.parse(a.viewedAt);
    });
  }

  has(seedId) {
    return this.items.some((item) => item.seedId === normalizeSeedId(seedId));
  }

  isPinned(seedId) {
    const id = normalizeSeedId(seedId);
    return this.items.some((item) => item.seedId === id && item.pinned);
  }

  /** 조회 성공 시 기록에 추가(또는 갱신) */
  add(seedId, nickname = "") {
    const id = normalizeSeedId(seedId);
    if (!id) return;

    const existing = this.items.find((item) => item.seedId === id);
    if (existing) {
      existing.viewedAt = new Date().toISOString();
      if (nickname) existing.nickname = nickname;
    } else {
      this.items.push({
        seedId: id,
        nickname: nickname || "",
        pinned: false,
        viewedAt: new Date().toISOString(),
      });
    }

    this.#trim();
    this.#save();
  }

  remove(seedId) {
    const id = normalizeSeedId(seedId);
    this.items = this.items.filter((item) => item.seedId !== id);
    this.#save();
  }

  /** 핀 토글. 기록에 없으면 먼저 추가합니다. */
  togglePin(seedId, nickname = "") {
    const id = normalizeSeedId(seedId);
    if (!id) return false;

    let target = this.items.find((item) => item.seedId === id);
    if (!target) {
      this.add(id, nickname);
      target = this.items.find((item) => item.seedId === id);
    }
    target.pinned = !target.pinned;
    this.#trim();
    this.#save();
    return target.pinned;
  }

  /** 핀 고정되지 않은 항목만 비웁니다. */
  clearUnpinned() {
    this.items = this.items.filter((item) => item.pinned);
    this.#save();
  }

  /* ── private ──────────────────────────────────────────────────────────── */

  /** 핀 아닌 항목을 최신순으로 MAX_HISTORY_ITEMS 개까지만 유지 */
  #trim() {
    const pinned = this.items.filter((item) => item.pinned);
    const recent = this.items
      .filter((item) => !item.pinned)
      .sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt))
      .slice(0, MAX_HISTORY_ITEMS);
    this.items = [...pinned, ...recent];
  }

  #load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_SEARCH_HISTORY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .map((item) => ({
          seedId: normalizeSeedId(item?.seedId),
          nickname: typeof item?.nickname === "string" ? item.nickname : "",
          pinned: Boolean(item?.pinned),
          viewedAt:
            typeof item?.viewedAt === "string" ? item.viewedAt : new Date(0).toISOString(),
        }))
        .filter((item) => item.seedId.length > 0);
    } catch {
      return [];
    }
  }

  #save() {
    try {
      localStorage.setItem(STORAGE_KEY_SEARCH_HISTORY, JSON.stringify(this.items));
    } catch {
      /* 저장 실패는 무시하고 메모리 상태만 유지 */
    }
  }
}

/** 공백 제거 + 대문자 정규화 */
export function normalizeSeedId(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
