/**
 * shareTree.js — 나무를 앱으로 넘기는 딥링크 인코더
 *
 * 웹 갤러리의 나무를 앱 스튜디오의 청사진으로 "따라 그리기" 위한 링크를 만듭니다.
 *
 *   siltime://import?v=1&n=<이름>&d=<base64url>
 *
 * 서버를 거치지 않고 링크 안에 점 데이터를 담습니다. Worker 에 실제 데이터가
 * 없어도(샘플 모드) 동작하고, 인증이나 네트워크가 필요 없습니다.
 *
 * ── 페이로드(d) 바이너리 포맷, 버전 1 ───────────────────────────────
 *   [0]            버전 (1)
 *   [1]            팔레트 크기 K (1..255)
 *   [2 .. 2+3K)    팔레트 RGB × K
 *   [나머지]       점 × N, 점당 3바이트: x, y, 팔레트 인덱스
 *
 * 점당 3바이트라 420점 나무가 약 1.7KB(base64url) 입니다.
 * iOS 쪽 디코더(SharedTreeLink.swift)와 반드시 같은 포맷이어야 합니다.
 */

import { COLS, DOT_TYPE, ROWS } from "./config.js";
import { normalizeHex } from "./statsRenderer.js";

export const LINK_SCHEME = "siltime";
export const LINK_VERSION = 1;

/** 이름 최대 길이. 앱 쪽 검증과 같은 값을 씁니다. */
export const MAX_NAME_LENGTH = 40;

/** 격자 칸 수 이상은 담을 수 없습니다. */
export const MAX_DOTS = COLS * ROWS;

/**
 * 나무 도트를 링크용 점 목록으로 거릅니다.
 * 잡초는 나무가 아니므로 제외하고, 격자 밖/중복/잘못된 좌표는 버립니다.
 * @param {Array<{x:number,y:number,type?:string,colorHex?:string}>} dots
 * @returns {Array<{x:number,y:number,hex:string}>}
 */
export function pickTreeDots(dots) {
  const seen = new Set();
  const result = [];
  for (const dot of Array.isArray(dots) ? dots : []) {
    if (!dot || dot.type === DOT_TYPE.WEED) continue;
    const { x, y } = dot;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue;
    const key = y * COLS + x;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ x, y, hex: normalizeHex(dot.colorHex, "#1E3932") });
  }
  return result.slice(0, MAX_DOTS);
}

/**
 * 점 목록 → 바이너리 페이로드.
 * @param {Array<{x:number,y:number,hex:string}>} points
 * @returns {Uint8Array}
 */
export function encodePayload(points) {
  const palette = [];
  const indexOf = new Map();
  for (const point of points) {
    if (!indexOf.has(point.hex)) {
      // 팔레트 인덱스는 1바이트이므로 255색을 넘으면 마지막 색으로 합칩니다.
      if (palette.length >= 255) {
        indexOf.set(point.hex, palette.length - 1);
      } else {
        indexOf.set(point.hex, palette.length);
        palette.push(point.hex);
      }
    }
  }

  const bytes = new Uint8Array(2 + palette.length * 3 + points.length * 3);
  bytes[0] = LINK_VERSION;
  bytes[1] = palette.length;
  palette.forEach((hex, i) => {
    bytes[2 + i * 3] = parseInt(hex.slice(1, 3), 16);
    bytes[3 + i * 3] = parseInt(hex.slice(3, 5), 16);
    bytes[4 + i * 3] = parseInt(hex.slice(5, 7), 16);
  });

  let offset = 2 + palette.length * 3;
  for (const point of points) {
    bytes[offset++] = point.x;
    bytes[offset++] = point.y;
    bytes[offset++] = indexOf.get(point.hex);
  }
  return bytes;
}

/** 바이트 → base64url (패딩 없음). */
export function toBase64Url(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url → 바이트. 테스트와 디버깅용입니다. */
export function fromBase64Url(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 표시 이름 정리: 제어문자 제거, 공백 정리, 길이 제한. */
export function sanitizeName(name) {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join("");
}

/* ── 복사 코드 ─────────────────────────────────────────────────────────────
 * 링크(siltime://)는 메신저·메모 앱에서 눌러도 앱이 열리지 않는 경우가 있습니다.
 * 그래서 같은 내용을 "복사해서 붙여넣는 코드"로도 줍니다. 앱 스튜디오의
 * '코드로 가져오기'에 붙여넣으면 됩니다.
 *
 *   SIL1.<payload>[.<이름 base64url(UTF-8)>]
 *
 * payload 는 링크의 d= 값과 완전히 같습니다. 문자는 영문·숫자·-_· 뿐이라
 * 어디에 붙여도 깨지지 않고, 앱은 공백·줄바꿈을 지우고 읽습니다.
 */
export const CODE_PREFIX = "SIL1";

/**
 * 나무를 복사 코드로 만듭니다.
 * @param {{name?:string, dots:Array}} tree
 * @returns {{code:string, dotCount:number}|null} 담을 점이 없으면 null
 */
export function buildShareCode(tree) {
  const points = pickTreeDots(tree?.dots);
  if (points.length === 0) return null;

  const parts = [CODE_PREFIX, toBase64Url(encodePayload(points))];
  const name = sanitizeName(tree?.name);
  if (name) parts.push(toBase64Url(new TextEncoder().encode(name)));

  return { code: parts.join("."), dotCount: points.length };
}

/**
 * 앱에서 열리는 "따라 그리기" 링크를 만듭니다.
 * @param {{name?:string, dots:Array}} tree
 * @returns {{url:string, dotCount:number}|null} 담을 점이 없으면 null
 */
export function buildImportLink(tree) {
  const points = pickTreeDots(tree?.dots);
  if (points.length === 0) return null;

  const payload = toBase64Url(encodePayload(points));
  const name = sanitizeName(tree?.name);
  const query = [`v=${LINK_VERSION}`];
  if (name) query.push(`n=${encodeURIComponent(name)}`);
  query.push(`d=${payload}`);

  return { url: `${LINK_SCHEME}://import?${query.join("&")}`, dotCount: points.length };
}
