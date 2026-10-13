/**
 * likeStore.js — 좋아요 중복 클릭 방지
 *
 * 로그인이 없는 서비스라서 "이미 눌렀는지"를 서버가 알 수 없습니다.
 * 그래서 브라우저가 기억합니다. localStorage 에 누른 Seed ID 집합을 두고,
 * 같은 기기에서 같은 분재에 두 번 눌리지 않게 막습니다.
 *
 * 한계를 분명히 해 둡니다: 이건 보안 장치가 아니라 UX 장치입니다.
 * 시크릿 창이나 다른 기기에서는 다시 누를 수 있습니다. 진짜 1인 1표가
 * 필요하면 Worker 쪽에서 IP 해시나 계정 단위로 막아야 합니다.
 * (worker.js 의 `handleLike` 주석 참고)
 */

import { STORAGE_KEY_LIKED_SEEDS } from "./config.js";

export class LikeStore {
  constructor(storageKey = STORAGE_KEY_LIKED_SEEDS) {
    this.storageKey = storageKey;
    /** @type {Set<string>} 이미 좋아요를 누른 Seed ID */
    this.liked = this.#load();
  }

  /** 이 분재에 이미 좋아요를 눌렀는지 */
  has(seedId) {
    return this.liked.has(normalize(seedId));
  }

  /**
   * 좋아요를 기록합니다.
   *
   * @param {string} seedId
   * @returns {boolean} 새로 기록되었으면 `true`, 이미 있었으면 `false`
   */
  add(seedId) {
    const id = normalize(seedId);
    if (!id || this.liked.has(id)) return false;
    this.liked.add(id);
    this.#save();
    return true;
  }

  /** 좋아요를 취소합니다 (낙관적 업데이트 롤백용). */
  remove(seedId) {
    const id = normalize(seedId);
    if (!this.liked.delete(id)) return false;
    this.#save();
    return true;
  }

  /** 누른 개수 */
  get count() {
    return this.liked.size;
  }

  /** 전체 초기화 */
  clear() {
    this.liked.clear();
    this.#save();
  }

  /* ── private ──────────────────────────────────────────────────────────── */

  #load() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.map(normalize).filter(Boolean));
    } catch {
      // 프라이빗 모드나 손상된 JSON — 메모리 전용으로 계속 동작합니다.
      return new Set();
    }
  }

  #save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify([...this.liked]));
    } catch {
      /* 저장 실패는 무시 */
    }
  }
}

/** Seed ID 정규화 — 공백 제거 + 대문자 */
function normalize(value) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}
