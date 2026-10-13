/**
 * forestShape.js — 첫 화면 "집중의 숲" 나무의 모양과 자리 배정
 *
 * 첫 화면에는 도트로 그린 큰 나무가 있고, 점 하나가 사용자 한 명입니다.
 * 이 모듈은 화면과 상관없는 순수 계산만 합니다.
 *
 *   1. buildSilhouette : 나무 모양을 이루는 칸(자리)들을 만듭니다. 매번 똑같은 모양입니다.
 *   2. rankUsers       : 사용자를 누적 집중 시간순(랭킹)으로 줄 세웁니다.
 *   3. assignSlots     : 랭킹 1위는 나무 꼭대기, 꼴찌는 줄기 밑동 쪽에 오도록, 사용자 수가
 *                        적어도 나무 전체에 고르게 퍼지게 자리를 나눠 줍니다.
 *
 * 사용자가 아직 적어도 나무는 항상 완전한 모양으로 보이고, 주인이 있는 자리만 켜집니다.
 * (사람이 늘수록 나무가 채워지는 구조입니다.)
 */

import { normalizeSeedId } from "./searchHistory.js";
import { toFiniteNumber } from "./statsRenderer.js";

/** 숲 격자. 앱의 나무(48x64)보다 성기게 잡아 점이 또렷하게 보이게 합니다. */
export const FOREST_COLS = 40;
export const FOREST_ROWS = 52;

/** 모양을 정하는 난수 시드. 바꾸면 나무 모양이 바뀝니다. */
const SHAPE_SEED = 20261012;

/** 결정적 난수 (mulberry32). 같은 시드는 언제나 같은 수열입니다. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 점 (px, py) 에서 선분 (ax,ay)-(bx,by) 까지의 거리 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * 나무 모양의 칸들을 만듭니다.
 *
 * 수관(둥근 잎 덩어리 여섯 개) + 줄기(위로 갈수록 가늘어지며 살짝 흔들림) + 굵은 가지 네 개.
 * 가장자리는 시드 난수로 들쭉날쭉하게 만들어 손으로 그린 도트 나무처럼 보이게 합니다.
 *
 * @returns {Array<{x:number, y:number}>} 위에서 아래로, 같은 줄에서는 가운데에서 바깥으로 정렬된 자리
 */
export function buildSilhouette({ cols = FOREST_COLS, rows = FOREST_ROWS, seed = SHAPE_SEED } = {}) {
  const random = mulberry32(seed);
  const cx = (cols - 1) / 2;
  const groundY = rows - 1;

  // [중심x, 중심y, 가로반지름, 세로반지름] — 격자 크기에 대한 비율
  const lobes = [
    [0.5, 0.3, 0.36, 0.2],
    [0.27, 0.37, 0.2, 0.14],
    [0.73, 0.37, 0.2, 0.14],
    [0.5, 0.14, 0.22, 0.12],
    [0.33, 0.22, 0.19, 0.13],
    [0.67, 0.22, 0.19, 0.13],
  ].map(([x, y, rx, ry]) => [x * cols, y * rows, rx * cols, ry * rows]);

  // 굵은 가지: [시작x, 시작y, 끝x, 끝y] 비율
  const branches = [
    [0.5, 0.62, 0.22, 0.44],
    [0.5, 0.62, 0.78, 0.44],
    [0.5, 0.75, 0.3, 0.63],
    [0.5, 0.75, 0.7, 0.63],
  ].map(([ax, ay, bx, by]) => [ax * cols, ay * rows, bx * cols, by * rows]);

  const cells = [];
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      let inside = false;

      // 수관: 안쪽은 확실히, 가장자리는 확률로
      for (const [lx, ly, rx, ry] of lobes) {
        const d = ((x - lx) / rx) ** 2 + ((y - ly) / ry) ** 2;
        if (d <= 0.78) {
          inside = true;
        } else if (d < 1.12 && random() < (1.12 - d) / 0.34) {
          inside = true;
        }
        if (inside) break;
      }

      // 줄기: 밑동은 넓고 위로 갈수록 가늘어집니다.
      if (!inside && y >= rows * 0.4) {
        const progress = (y - rows * 0.4) / (groundY - rows * 0.4); // 0(위) → 1(땅)
        const half = 1.1 + progress * 1.5 + (y >= groundY - 2 ? 2 + (y - (groundY - 2)) * 0.8 : 0);
        const sway = Math.sin(progress * 5.2) * 0.9;
        if (Math.abs(x - (cx + sway)) <= half) inside = true;
      }

      // 가지
      if (!inside) {
        for (const [ax, ay, bx, by] of branches) {
          if (distanceToSegment(x, y, ax, ay, bx, by) <= 1.05) {
            inside = true;
            break;
          }
        }
      }

      if (inside) cells.push({ x, y });
    }
  }

  cells.sort((a, b) => a.y - b.y || Math.abs(a.x - cx) - Math.abs(b.x - cx) || a.x - b.x);
  return cells;
}

/* ──────────────────────────── 랭킹 ──────────────────────────── */

/**
 * 사용자를 랭킹순으로 줄 세웁니다.
 *
 * 누적 집중 시간이 많은 순. 같으면 좋아요가 많은 쪽, 그래도 같으면 Seed ID 순으로 확정해서
 * 새로 고침해도 순서가 흔들리지 않게 합니다. Seed ID 가 없는 항목은 뺍니다.
 *
 * @param {Array<object>} feed 커뮤니티 피드
 * @returns {Array<object>} 순위가 붙은 새 배열 (`rank`: 1부터)
 */
export function rankUsers(feed) {
  const list = (Array.isArray(feed) ? feed : [])
    .map((user) => ({ user, seedId: normalizeSeedId(user?.seedId ?? "") }))
    .filter((entry) => entry.seedId);

  list.sort(
    (a, b) =>
      toFiniteNumber(b.user.totalFocusSeconds) - toFiniteNumber(a.user.totalFocusSeconds) ||
      toFiniteNumber(b.user.likes) - toFiniteNumber(a.user.likes) ||
      a.seedId.localeCompare(b.seedId),
  );

  // 같은 Seed ID 가 두 번 들어와도 한 번만 씁니다.
  const seen = new Set();
  const unique = [];
  for (const entry of list) {
    if (seen.has(entry.seedId)) continue;
    seen.add(entry.seedId);
    unique.push(entry);
  }

  return unique.map((entry, index) => ({ ...entry.user, seedId: entry.seedId, rank: index + 1 }));
}

/* ──────────────────────────── 자리 배정 ──────────────────────────── */

/**
 * 사용자 `userCount` 명에게 `slotCount` 개의 자리 중 어디를 줄지 정합니다.
 *
 * 자리는 위에서 아래로 정렬되어 있으므로, 1위가 맨 위(꼭대기)에, 마지막 순위가 맨 아래(밑동)에
 * 옵니다. 사용자가 자리보다 적으면 나무 전체에 고르게 퍼뜨리고, 많으면 상위 `slotCount` 명만
 * 앉힙니다.
 *
 * @returns {number[]} i 번째 순위 사용자가 앉을 자리 번호. 길이는 min(userCount, slotCount)
 */
export function assignSlots(slotCount, userCount) {
  const slots = Math.max(0, Math.floor(slotCount));
  const users = Math.max(0, Math.floor(userCount));
  if (slots === 0 || users === 0) return [];
  if (users >= slots) return Array.from({ length: slots }, (_, i) => i);

  // 칸 사이를 같은 간격으로 나누고 각 구간의 가운데를 씁니다. 사용자 < 자리이면 겹치지 않습니다.
  return Array.from({ length: users }, (_, i) => Math.floor(((i + 0.5) * slots) / users));
}
