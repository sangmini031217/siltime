/**
 * fieldMastery.js — 분야(카테고리)별 10,000시간 진행도
 *
 * "10,000시간의 법칙"은 한 분야에 10,000시간을 쏟자는 뜻입니다. 전체 합산 하나만이
 * 아니라 분야마다 따로 진행도를 계산합니다. 나무는 모든 분야를 합친 시간이고,
 * 이 모듈은 분야 하나가 쌓은 시간을 보여 줍니다.
 *
 * 입력 데이터의 모양
 * ─────────────────
 * 앱이 올리는 카테고리는 평평한 목록이고, 이름이 "상위 > 하위" 경로입니다.
 * 세션이 직접 기록된 카테고리만 들어 있으므로, 상위 분야의 시간은 이름 경로로
 * 묶어서 합산합니다. (예: "어학 > 영어" 420h + "어학 > 일본어" 3h → "어학" 423h)
 *
 * 분야가 아닌 항목
 * ───────────────
 * "미분류"(uncategorized)와 "기타"(other, 항목이 너무 많을 때 합친 묶음)는 하나의
 * 분야가 아니라서 목록에서 뺍니다.
 */

import { MASTERY_TARGET_SECONDS, SECONDS_PER_HOUR } from "./config.js";
import {
  formatCount,
  formatPercent,
  normalizeHex,
  resolveMilestone,
  toFiniteNumber,
  toHours,
} from "./statsRenderer.js";

/** 앱의 경로 구분자 */
const PATH_SEPARATOR = ">";

/** 분야로 보지 않는 앱의 특수 카테고리 ID */
const NON_FIELD_IDS = new Set(["uncategorized", "other"]);

/** 기록이 있는데도 막대가 안 보이는 것을 막는 최소 폭(%) */
const MIN_VISIBLE_PERCENT = 1.2;

/* ──────────────────────────── 순수 계산 ──────────────────────────── */

/**
 * 한 분야의 10,000시간 진행도.
 * @param {number} seconds 그 분야에 쌓인 집중 초
 */
export function calculateFieldMastery(seconds) {
  const safe = Math.max(0, toFiniteNumber(seconds));
  const percent = Math.min(100, (safe / MASTERY_TARGET_SECONDS) * 100);
  const remainingSeconds = Math.max(0, MASTERY_TARGET_SECONDS - safe);
  return {
    seconds: safe,
    hours: Math.floor(safe / SECONDS_PER_HOUR),
    percent,
    /** 막대에 그릴 폭. 기록이 있으면 최소 폭을 보장합니다. */
    barPercent: safe > 0 ? Math.max(percent, MIN_VISIBLE_PERCENT) : 0,
    remainingHours: Math.floor(remainingSeconds / SECONDS_PER_HOUR),
    isMastered: safe >= MASTERY_TARGET_SECONDS,
    stage: resolveMilestone(toHours(safe)).stage,
  };
}

/** "상위 > 하위" 경로를 조각으로 나눕니다. 빈 조각은 버립니다. */
export function splitCategoryPath(name) {
  return String(name ?? "")
    .split(PATH_SEPARATOR)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 카테고리 목록을 분야 트리로 묶어 화면에 그릴 줄(평탄화)로 돌려줍니다.
 *
 * 각 줄의 `focusSeconds` 는 그 분야와 하위를 모두 합친 값입니다. 같은 부모 아래에서는
 * 시간이 많은 순서로 정렬하고, 부모 바로 아래에 자식이 오도록 깊이 우선으로 펼칩니다.
 *
 * @param {Array<{id?:string,name?:string,colorHex?:string,focusSeconds?:number}>} categories
 * @returns {Array<{key:string,name:string,path:string[],depth:number,colorHex:string,focusSeconds:number}>}
 */
export function buildFieldRows(categories) {
  const list = Array.isArray(categories) ? categories : [];
  const root = { children: new Map() };

  for (const category of list) {
    if (NON_FIELD_IDS.has(String(category?.id ?? ""))) continue;

    const seconds = Math.max(0, toFiniteNumber(category?.focusSeconds));
    if (seconds <= 0) continue;

    const parts = splitCategoryPath(category?.name);
    if (parts.length === 0) continue;

    let node = root;
    parts.forEach((part, index) => {
      const key = part.toLowerCase();
      let child = node.children.get(key);
      if (!child) {
        child = { name: part, colorHex: null, ownSeconds: 0, children: new Map() };
        node.children.set(key, child);
      }
      // 이 카테고리 자신의 줄이 가장 구체적인 색을 가집니다.
      if (index === parts.length - 1) {
        child.ownSeconds += seconds;
        child.colorHex = normalizeHex(category?.colorHex);
      }
      node = child;
    });
  }

  const total = (node) =>
    node.ownSeconds + [...node.children.values()].reduce((sum, c) => sum + total(c), 0);

  /** 자기 줄이 없는 상위(경로에만 나온 부모)는 자식의 색을 빌립니다. */
  const colorOf = (node) => {
    if (node.colorHex) return node.colorHex;
    for (const child of node.children.values()) {
      const color = colorOf(child);
      if (color) return color;
    }
    return normalizeHex(null);
  };

  const rows = [];
  const walk = (node, depth, parentKey, parentPath) => {
    const sorted = [...node.children.values()]
      .map((child) => ({ child, sum: total(child) }))
      .sort((a, b) => b.sum - a.sum);
    for (const { child, sum } of sorted) {
      const key = `${parentKey}/${child.name}`;
      const path = [...parentPath, child.name];
      rows.push({
        key,
        name: child.name,
        /** 대분류부터 이 항목까지의 이름 경로 (이름에 "/" 가 있어도 안전) */
        path,
        depth,
        colorHex: colorOf(child),
        focusSeconds: sum,
      });
      walk(child, depth + 1, key, path);
    }
  };
  walk(root, 0, "", []);

  return rows;
}

/* ──────────────────────────── 렌더 ──────────────────────────── */

/**
 * 분야별 진행도 목록을 그립니다.
 *
 * @param {{list: HTMLElement|null, count?: HTMLElement|null}} elements
 * @param {Array<object>} categories
 */
export function renderFieldMastery(elements, categories) {
  const { list, count } = elements;
  if (!list) return;

  const rows = buildFieldRows(categories);
  list.replaceChildren();

  if (count) {
    const rootCount = rows.filter((row) => row.depth === 0).length;
    count.textContent = formatCount(rootCount, "개 분야");
  }

  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "field-mastery__empty";
    empty.textContent = "기록된 분야가 없습니다";
    list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  rows.forEach((row) => fragment.append(buildFieldItem(row)));
  list.append(fragment);
}

/** 분야 한 줄: 이름과 시간, 막대, 단계·남은 시간·퍼센트 */
function buildFieldItem(row) {
  const mastery = calculateFieldMastery(row.focusSeconds);

  const item = document.createElement("li");
  item.className = "field-mastery__item";
  item.dataset.depth = String(row.depth);
  item.style.setProperty("--field-depth", String(row.depth));
  item.style.setProperty("--field-color", row.colorHex);

  const head = document.createElement("div");
  head.className = "field-mastery__head";

  const swatch = document.createElement("span");
  swatch.className = "field-mastery__swatch";
  swatch.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "field-mastery__name";
  name.textContent = row.name;

  const hours = document.createElement("span");
  hours.className = "field-mastery__hours";
  hours.textContent = `${formatCount(mastery.hours)} / 10,000시간`;

  head.append(swatch, name, hours);

  const bar = document.createElement("div");
  bar.className = "field-mastery__bar";
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", `${row.name} 10,000시간 진행도`);
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.setAttribute("aria-valuenow", mastery.percent.toFixed(2));
  const fill = document.createElement("span");
  fill.className = "field-mastery__fill";
  fill.style.width = `${mastery.barPercent}%`;
  bar.append(fill);

  const meta = document.createElement("div");
  meta.className = "field-mastery__meta";
  const stage = document.createElement("span");
  stage.className = "field-mastery__stage";
  stage.textContent = mastery.stage.label;
  const remaining = document.createElement("span");
  remaining.textContent = mastery.isMastered
    ? "10,000시간 달성"
    : `${formatCount(mastery.remainingHours)}시간 남음`;
  const percent = document.createElement("span");
  percent.className = "field-mastery__percent";
  percent.textContent = formatPercent(mastery.percent);
  meta.append(stage, remaining, percent);

  item.append(head, bar, meta);
  return item;
}
