/**
 * reportExport.js — 나의 상세 학습 리포트를 PDF / 이미지로 내보내기
 *
 * 화면(밤/낮 테마, 반응형)과 상관없이 같은 모양이 나오도록, 내보내기 전용 "리포트 시트"를
 * 따로 만듭니다. 폭은 A4(794px)로 고정이고 색은 모두 라이트 고정값입니다.
 *
 *   · PDF  : 시트를 화면 밖 문서에 붙이고 `window.print()`. 브라우저의 "PDF로 저장"을
 *            쓰기 때문에 글자가 벡터로 남고 선택/검색이 됩니다. (인쇄 CSS: css/report.css)
 *   · 이미지: 같은 시트를 html2canvas 로 PNG 로 그려 내려받습니다. 라이브러리는 처음 쓸 때만
 *            불러옵니다. (js/vendor/html2canvas.min.js)
 *
 * 사용자 입력(닉네임, 카테고리 이름)은 전부 textContent 로만 넣습니다.
 */

import { DOT_TYPE, DOT_TYPE_LABEL, MILESTONE_STAGES } from "./config.js";
import { buildFieldRows, calculateFieldMastery } from "./fieldMastery.js";
import { drawMiniTree } from "./miniTreeRenderer.js";
import {
  aggregateTree,
  calculateMasteryPercent,
  findNextStage,
  formatCount,
  formatDate,
  formatDuration,
  formatHours,
  formatPercent,
  resolveMilestone,
  toFiniteNumber,
  toHours,
} from "./statsRenderer.js";

/** html2canvas 파일 위치 (이 모듈 기준 상대 경로) */
const HTML2CANVAS_URL = new URL("./vendor/html2canvas.min.js", import.meta.url).href;

/** 이미지 저장 배율. 2 = 레티나급 선명도 */
const IMAGE_SCALE = 2;

/** 리포트에 싣는 최대 줄 수 */
const MAX_FIELD_ROWS = 10;
const MAX_CATEGORY_ROWS = 10;
const MAX_RECENT_ROWS = 8;

/* ──────────────────────────── DOM 헬퍼 ──────────────────────────── */

/** 요소를 만들고 글자는 textContent 로만 넣습니다. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** `<dl>` 한 칸: 라벨 + 값 */
function statCell(label, value) {
  const cell = el("div", "rs-kpi");
  cell.append(el("dt", "rs-kpi__label", label), el("dd", "rs-kpi__value", value));
  return cell;
}

/** 가로 막대. 색은 CSS 변수로 넘깁니다. */
function barOf(percent, color, large = false) {
  const bar = el("div", large ? "rs-bar rs-bar--lg" : "rs-bar");
  const fill = el("span", "rs-bar__fill");
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (color) fill.style.backgroundColor = color;
  bar.append(fill);
  return bar;
}

function section(title, className) {
  const node = el("section", `rs-section ${className ?? ""}`.trim());
  node.append(el("h2", "rs-section__title", title));
  return node;
}

/* ──────────────────────────── 시트 만들기 ──────────────────────────── */

/**
 * 리포트 시트를 만듭니다. 문서에는 아직 붙지 않은 상태로 돌려줍니다.
 * @param {object} tree app.js 가 정규화한 트리
 * @param {Date} [now] 생성 시각 (테스트용)
 */
export function buildReportSheet(tree, now = new Date()) {
  const summary = aggregateTree(tree);
  const totalSeconds = Math.max(0, toFiniteNumber(tree.globalFocusSeconds));
  const percent = calculateMasteryPercent(totalSeconds);
  const { stage, index } = resolveMilestone(toHours(totalSeconds), tree.milestone?.stageId ?? null);
  const nextStage = findNextStage(toHours(totalSeconds));

  const sheet = el("article", "report-sheet");
  sheet.setAttribute("aria-label", "SilTime 학습 리포트");

  /* 머리글 */
  const head = el("header", "rs-head");
  const brand = el("div", "rs-brand");
  brand.append(el("span", "rs-mark"), el("span", "rs-brand__text", "SilTime 학습 리포트"));
  head.append(brand, el("span", "rs-head__date", `${formatDate(now.toISOString())} 생성`));

  /* 프로필 */
  const profile = el("div", "rs-profile");
  const who = el("div", "rs-profile__who");
  who.append(el("h1", "rs-name", tree.ownerNickname || "익명 사용자"), el("p", "rs-seed", tree.seedId));
  profile.append(who, el("span", "rs-stage-pill", `${stage.label} · ${index + 1}/${MILESTONE_STAGES.length}단계`));

  /* 핵심 수치 */
  const kpis = el("dl", "rs-kpis");
  kpis.append(
    statCell("누적 집중", formatDuration(totalSeconds)),
    statCell("10,000시간 달성률", formatPercent(percent)),
    statCell("누적 세션", formatCount(summary.sessionCount, "회")),
    statCell("평균 집중", formatDuration(summary.avgFocusSeconds)),
    statCell("최고 집중", formatDuration(summary.maxFocusSeconds)),
    statCell("최장 연속", formatCount(summary.longestStreakDays, "일")),
  );

  /* 나무 + 전체 진행도 */
  const main = el("div", "rs-main");

  const figure = el("figure", "rs-tree");
  const canvas = document.createElement("canvas");
  canvas.className = "rs-tree__canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${summary.dotCount}개의 점으로 자란 나무`);
  drawMiniTree(canvas, {
    dots: tree.dots,
    cols: tree.grid?.cols,
    rows: tree.grid?.rows,
    cell: 5,
    background: "#F2F0EB",
    groundColor: "#CFC9BF",
  });
  figure.append(canvas, el("figcaption", "rs-tree__caption", `${formatCount(summary.dotCount, "개")}의 점 · 높이 ${formatCount(summary.treeHeight, "칸")}`));

  const overall = el("div", "rs-overall");
  overall.append(el("h2", "rs-section__title", "전체 10,000시간"));
  overall.append(el("p", "rs-overall__value", formatHours(totalSeconds)));
  overall.append(barOf(Math.max(percent, totalSeconds > 0 ? 1.2 : 0), "#006241", true));
  const foot = el("p", "rs-overall__foot");
  foot.append(
    el("span", null, `남은 시간 ${formatHours(Math.max(0, 36_000_000 - totalSeconds))}`),
    el(
      "span",
      null,
      nextStage ? `다음 단계 ${nextStage.label}까지 ${formatHours(nextStage.minHours * 3600 - totalSeconds)}` : "모든 단계 달성",
    ),
  );
  overall.append(foot);

  const track = el("ol", "rs-track");
  MILESTONE_STAGES.forEach((item, i) => {
    const step = el("li", "rs-track__step");
    if (i <= index) step.classList.add("is-reached");
    if (i === index) step.classList.add("is-current");
    step.append(el("span", "rs-track__dot"), el("span", "rs-track__label", item.label));
    track.append(step);
  });
  overall.append(track);

  main.append(figure, overall);

  /* 분야별 10,000시간 */
  const fieldRows = buildFieldRows(tree.categories);
  const fields = section("분야별 10,000시간", "rs-fields");
  fields.append(el("p", "rs-note", "나무는 모든 분야를 합친 시간이에요. 분야마다 따로 10,000시간을 향해 쌓여요."));
  if (fieldRows.length === 0) {
    fields.append(el("p", "rs-empty", "기록된 분야가 없습니다"));
  } else {
    const list = el("ul", "rs-fieldlist");
    fieldRows.slice(0, MAX_FIELD_ROWS).forEach((row) => {
      const mastery = calculateFieldMastery(row.focusSeconds);
      const item = el("li", "rs-field");
      item.style.paddingLeft = `${row.depth * 16}px`;

      const top = el("div", "rs-field__top");
      const swatch = el("span", "rs-field__swatch");
      swatch.style.backgroundColor = row.colorHex;
      top.append(
        swatch,
        el("span", "rs-field__name", row.name),
        el("span", "rs-field__hours", `${formatCount(mastery.hours)} / 10,000시간`),
      );

      const meta = el("div", "rs-field__meta");
      meta.append(
        el("span", "rs-field__stage", mastery.stage.label),
        el("span", null, mastery.isMastered ? "10,000시간 달성" : `${formatCount(mastery.remainingHours)}시간 남음`),
        el("span", "rs-field__percent", formatPercent(mastery.percent)),
      );

      item.append(top, barOf(mastery.barPercent, row.colorHex), meta);
      list.append(item);
    });
    fields.append(list);
    if (fieldRows.length > MAX_FIELD_ROWS) {
      fields.append(el("p", "rs-more", `외 ${fieldRows.length - MAX_FIELD_ROWS}개 항목`));
    }
  }

  /* 카테고리 상세 */
  const categories = section("카테고리 상세", "rs-categories");
  if (summary.categories.length === 0) {
    categories.append(el("p", "rs-empty", "표시할 카테고리가 없습니다"));
  } else {
    const table = el("table", "rs-table");
    const thead = el("thead");
    const headRow = el("tr");
    ["카테고리", "점", "총 시간", "평균", "비중"].forEach((label, i) => {
      const th = el("th", i === 0 ? null : "is-num", label);
      th.scope = "col";
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = el("tbody");
    summary.categories.slice(0, MAX_CATEGORY_ROWS).forEach((category) => {
      const tr = el("tr");
      const nameCell = el("td", "rs-table__name");
      const dot = el("span", "rs-field__swatch");
      dot.style.backgroundColor = category.colorHex;
      nameCell.append(dot, el("span", null, category.name));
      tr.append(
        nameCell,
        el("td", "is-num", formatCount(category.dotCount, "개")),
        el("td", "is-num", formatDuration(category.focusSeconds)),
        el("td", "is-num", category.dotCount > 0 ? formatDuration(category.avgDotFocusSeconds) : "—"),
        el("td", "is-num", formatPercent(category.share)),
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    categories.append(table);
    if (summary.categories.length > MAX_CATEGORY_ROWS) {
      categories.append(el("p", "rs-more", `외 ${summary.categories.length - MAX_CATEGORY_ROWS}개 카테고리`));
    }
  }

  /* 최근 기록 */
  const recent = section("최근 기록", "rs-recent");
  const names = new Map((tree.categories ?? []).map((c) => [String(c.id), String(c.name)]));
  const records = (tree.dots ?? [])
    .filter((dot) => typeof dot.createdAt === "string" && !Number.isNaN(Date.parse(dot.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, MAX_RECENT_ROWS);
  if (records.length === 0) {
    recent.append(el("p", "rs-empty", "날짜가 기록된 항목이 없습니다"));
  } else {
    const table = el("table", "rs-table");
    const thead = el("thead");
    const headRow = el("tr");
    ["날짜", "종류", "카테고리", "집중"].forEach((label, i) => {
      const th = el("th", i === 3 ? "is-num" : null, label);
      th.scope = "col";
      headRow.append(th);
    });
    thead.append(headRow);
    const tbody = el("tbody");
    records.forEach((dot) => {
      const isWeed = dot.type === DOT_TYPE.WEED;
      const tr = el("tr");
      tr.append(
        el("td", null, formatDate(dot.createdAt)),
        el("td", null, DOT_TYPE_LABEL[dot.type] ?? "점"),
        el("td", null, dot.categoryId ? names.get(String(dot.categoryId)) ?? "미분류" : "—"),
        el("td", "is-num", isWeed ? `×${formatCount(dot.count)}` : formatDuration(dot.focusSeconds)),
      );
      tbody.append(tr);
    });
    table.append(thead, tbody);
    recent.append(table);
  }

  /* 바닥글 */
  const foot2 = el("footer", "rs-foot");
  foot2.append(
    el("span", null, `SilTime · ${tree.seedId}`),
    el("span", null, "10,000시간의 법칙: 한 분야에 10,000시간"),
  );

  sheet.append(head, profile, kpis, main, fields, categories, recent, foot2);
  return sheet;
}

/* ──────────────────────────── 내보내기 ──────────────────────────── */

/** 파일 이름에 쓸 수 있게 Seed ID 를 다듬습니다. */
export function safeSeed(seedId) {
  const cleaned = String(seedId ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return cleaned || "report";
}

export function dateStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

/** 내보내기 파일 이름. 확장자는 붙이지 않습니다. */
export function reportFileName(tree, now = new Date()) {
  return `SilTime_${safeSeed(tree.seedId)}_${dateStamp(now)}`;
}

/**
 * PDF 로 저장합니다. 브라우저 인쇄 창이 열리면 대상을 "PDF로 저장"으로 고르면 됩니다.
 * 인쇄 창이 닫히면(저장/취소) 임시 시트를 치웁니다.
 */
export function exportReportPdf(tree) {
  const sheet = buildReportSheet(tree);
  sheet.id = "report-sheet";
  sheet.classList.add("rs-print");

  const previousTitle = document.title;
  // 인쇄 창이 제안하는 파일 이름이 됩니다.
  document.title = reportFileName(tree);

  document.body.append(sheet);
  document.body.classList.add("is-printing-report");

  const cleanup = () => {
    window.removeEventListener("afterprint", cleanup);
    sheet.remove();
    document.body.classList.remove("is-printing-report");
    document.title = previousTitle;
  };
  window.addEventListener("afterprint", cleanup);

  // 시트가 레이아웃에 반영될 시간을 한 틱 줍니다. (rAF 는 백그라운드 탭에서 멈춥니다.)
  setTimeout(() => window.print(), 60);
  return sheet;
}

/** html2canvas 를 처음 쓸 때 한 번만 불러옵니다. */
let html2canvasPromise = null;
function loadHtml2Canvas() {
  if (typeof window.html2canvas === "function") return Promise.resolve(window.html2canvas);
  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = HTML2CANVAS_URL;
      script.async = true;
      script.onload = () =>
        typeof window.html2canvas === "function"
          ? resolve(window.html2canvas)
          : reject(new Error("html2canvas 를 초기화하지 못했습니다"));
      script.onerror = () => {
        html2canvasPromise = null; // 다음에 다시 시도할 수 있게
        reject(new Error("이미지 저장 도구를 불러오지 못했습니다"));
      };
      document.head.append(script);
    });
  }
  return html2canvasPromise;
}

/**
 * PNG 이미지로 저장합니다.
 * @returns {Promise<{width:number,height:number,bytes:number,fileName:string}>}
 */
export async function exportReportImage(tree) {
  const render = await loadHtml2Canvas();

  const stage = el("div", "rs-stage");
  const sheet = buildReportSheet(tree);
  stage.append(sheet);
  document.body.append(stage);

  try {
    // 웹폰트가 준비되기 전에 그리면 글자 폭이 달라집니다.
    if (document.fonts?.ready) await document.fonts.ready;

    const canvas = await render(sheet, {
      scale: IMAGE_SCALE,
      backgroundColor: "#FFFFFF",
      useCORS: true,
      logging: false,
    });

    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("이미지를 만들지 못했습니다"))), "image/png");
    });

    const fileName = `${reportFileName(tree)}.png`;
    downloadBlob(blob, fileName);
    return { width: canvas.width, height: canvas.height, bytes: blob.size, fileName };
  } finally {
    stage.remove();
  }
}

/** Blob 을 파일로 내려받게 합니다. */
export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // 다운로드가 시작될 시간을 준 뒤 해제합니다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
