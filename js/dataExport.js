/**
 * dataExport.js — 나의 집중 기록을 분석용 데이터 파일로 내려받기
 *
 * 공공데이터 포털의 파일 데이터처럼, 받아서 바로 엑셀·파이썬·R 에 올려 분석할 수 있게
 * 만듭니다.
 *
 *   · CSV  : 기록(세션/점 단위 원본) 한 장. UTF-8 + BOM 이라 엑셀에서 한글이 깨지지 않고,
 *            Seed ID 와 닉네임이 모든 줄에 들어 있어 여러 사람의 파일을 이어 붙여도 됩니다.
 *   · 엑셀 : 시트 5장 (요약 / 분야별 10,000시간 / 카테고리 / 기록 / 데이터 설명).
 *            숫자는 숫자 셀로 들어가 바로 합계·피벗이 됩니다.
 *
 * 외부 라이브러리 없이 .xlsx(zip + XML)를 직접 만듭니다. 이 모듈의 계산은 모두 순수
 * 함수라서 브라우저 없이도 테스트할 수 있습니다. (DOM 은 내려받기 함수에서만 씁니다.)
 *
 * 사용자 입력(닉네임, 카테고리 이름)이 들어가므로 두 가지를 막습니다.
 *   · XML/CSV 에 넣을 수 없는 제어 문자 제거
 *   · CSV 를 엑셀로 열 때 수식으로 실행되는 "CSV 수식 주입" 방지 (= + - @ 로 시작하는 글자)
 */

import { DOT_TYPE_LABEL, GROUND_ROW } from "./config.js";
import { buildFieldRows, calculateFieldMastery } from "./fieldMastery.js";
import {
  aggregateTree,
  calculateMasteryPercent,
  resolveMilestone,
  toFiniteNumber,
  toHours,
} from "./statsRenderer.js";
import { dateStamp, downloadBlob, safeSeed } from "./reportExport.js";

/* ──────────────────────────── 상수 ──────────────────────────── */

export const SHEET_NAMES = Object.freeze({
  summary: "요약",
  fields: "분야별_10000시간",
  categories: "카테고리",
  records: "기록",
  dictionary: "데이터_설명",
});

const CSV_MIME = "text/csv;charset=utf-8";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 엑셀 셀 하나에 넣을 수 있는 글자 수 상한은 32,767 */
const MAX_CELL_CHARS = 32_000;

/** 앱의 특수 카테고리 ID */
const UNCATEGORIZED_ID = "uncategorized";
const OTHER_ID = "other";

/* ──────────────────────────── 값 정리 ──────────────────────────── */

/** XML 1.0 과 CSV 에 넣을 수 없는 제어 문자를 지웁니다. (탭, 줄바꿈은 남김) */
export function cleanText(value) {
  const text = String(value ?? "");
  // eslint-disable-next-line no-control-regex
  const stripped = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "");
  // 짝 없는 서로게이트는 XML 이 거부합니다.
  const safe = stripped.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
  return safe.length > MAX_CELL_CHARS ? safe.slice(0, MAX_CELL_CHARS) : safe;
}

/** 소수점 자리 반올림. 숫자가 아니면 null. */
export function roundTo(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/** ISO 시각 → 한국 시간 날짜 "YYYY-MM-DD". 잘못된 값이면 "". */
export function kstDate(iso) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(time));
  const pick = (type) => parts.find((p) => p.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** "어학 > 영어" 에서 대분류 이름 */
function rootOf(name) {
  const first = String(name ?? "").split(">")[0].trim();
  return first || String(name ?? "").trim();
}

/* ──────────────────────────── 데이터셋 만들기 ──────────────────────────── */

/**
 * 내려받을 시트들을 만듭니다.
 *
 * 시트 형태: `{ name, columns: [{label, desc, unit?, width?}], rows: [[셀...]] }`
 * 셀은 숫자, 문자열, null(빈칸) 중 하나입니다.
 *
 * @param {object} tree app.js 가 정규화한 트리
 * @param {Date} [now] 생성 시각
 */
export function buildDatasets(tree, now = new Date()) {
  const summary = aggregateTree(tree);
  const totalSeconds = Math.max(0, toFiniteNumber(tree.globalFocusSeconds));
  const { stage } = resolveMilestone(toHours(totalSeconds), tree.milestone?.stageId ?? null);
  const seedId = cleanText(tree.seedId);
  const nickname = cleanText(tree.ownerNickname);

  const categoryName = new Map(
    (Array.isArray(tree.categories) ? tree.categories : []).map((c) => [String(c.id), String(c.name)]),
  );

  /* 1. 요약 */
  const summarySheet = {
    name: SHEET_NAMES.summary,
    columns: [
      { label: "항목", desc: "요약 항목 이름", width: 26 },
      { label: "값", desc: "항목의 값. 숫자는 숫자로 들어 있습니다", width: 22 },
      { label: "단위", desc: "값의 단위", width: 10 },
    ],
    rows: [
      ["Seed ID", seedId, ""],
      ["닉네임", nickname, ""],
      ["앱 내보낸 시각(UTC)", cleanText(tree.exportedAt ?? ""), "ISO 8601"],
      ["파일 생성 시각(UTC)", now.toISOString(), "ISO 8601"],
      ["누적 집중", Math.round(totalSeconds), "초"],
      ["누적 집중", roundTo(totalSeconds / 3600, 2), "시간"],
      ["10,000시간 달성률", roundTo(calculateMasteryPercent(totalSeconds), 2), "%"],
      ["10,000시간까지 남은 시간", roundTo(Math.max(0, 10_000 - totalSeconds / 3600), 2), "시간"],
      ["성장 단계", cleanText(stage.label), ""],
      ["누적 세션 수", Math.round(summary.sessionCount), "회"],
      ["성장 점 수(씨앗·잡초 제외)", summary.dotCount, "개"],
      ["잡초 수", summary.weedCount, "개"],
      ["나무 높이", summary.treeHeight, "칸"],
      ["평균 집중", Math.round(summary.avgFocusSeconds), "초"],
      ["최고 집중", Math.round(summary.maxFocusSeconds), "초"],
      ["최장 연속", Math.round(summary.longestStreakDays), "일"],
      ["카테고리 수", summary.categories.length, "개"],
      ["격자 열 수", Math.round(toFiniteNumber(tree.grid?.cols)), "칸"],
      ["격자 행 수", Math.round(toFiniteNumber(tree.grid?.rows)), "칸"],
    ],
  };

  /* 2. 분야별 10,000시간 */
  const fieldsSheet = {
    name: SHEET_NAMES.fields,
    columns: [
      { label: "분야", desc: "분야 이름. 하위 분야는 이름만 표시", width: 24 },
      { label: "경로", desc: "대분류부터 이어 쓴 전체 이름 (구분자 ' > ')", width: 30 },
      { label: "깊이", desc: "1 = 대분류, 2 = 그 아래 분야, 3 = 그 아래", unit: "단계", width: 8 },
      { label: "집중시간(초)", desc: "이 분야와 하위 분야를 모두 합친 집중 시간", unit: "초", width: 16 },
      { label: "집중시간(시간)", desc: "집중시간(초)를 시간으로 환산 (소수 2자리)", unit: "시간", width: 16 },
      { label: "10000시간 달성률(%)", desc: "이 분야 집중시간 ÷ 10,000시간 × 100 (최대 100)", unit: "%", width: 20 },
      { label: "남은 시간(시간)", desc: "10,000시간까지 남은 시간", unit: "시간", width: 16 },
      { label: "성장 단계", desc: "이 분야 시간만으로 본 성장 단계", width: 12 },
    ],
    rows: buildFieldRows(tree.categories).map((row) => {
      const mastery = calculateFieldMastery(row.focusSeconds);
      return [
        cleanText(row.name),
        cleanText(row.path.join(" > ")),
        row.depth + 1,
        Math.round(row.focusSeconds),
        roundTo(row.focusSeconds / 3600, 2),
        roundTo(mastery.percent, 2),
        mastery.remainingHours,
        cleanText(mastery.stage.label),
      ];
    }),
  };

  /* 3. 카테고리 */
  const categoriesSheet = {
    name: SHEET_NAMES.categories,
    columns: [
      { label: "카테고리", desc: "앱에 표시되는 카테고리 이름 (하위는 '상위 > 하위')", width: 28 },
      { label: "대분류", desc: "카테고리 이름의 첫 번째 단계", width: 16 },
      { label: "유형", desc: "일반 / 미분류(카테고리 없이 기록) / 기타(항목이 많아 합친 묶음)", width: 10 },
      { label: "점 수", desc: "이 카테고리에 속한 성장 점의 개수", unit: "개", width: 10 },
      { label: "총 집중(초)", desc: "이 카테고리에 직접 기록된 집중 시간", unit: "초", width: 14 },
      { label: "총 집중(시간)", desc: "총 집중(초)를 시간으로 환산 (소수 2자리)", unit: "시간", width: 14 },
      { label: "점당 평균 집중(초)", desc: "점에 기록된 집중 시간의 평균", unit: "초", width: 18 },
      { label: "비중(%)", desc: "전체 카테고리 합계 중 이 카테고리의 비율", unit: "%", width: 10 },
    ],
    rows: summary.categories.map((category) => {
      const type =
        category.id === UNCATEGORIZED_ID ? "미분류" : category.id === OTHER_ID ? "기타" : "일반";
      return [
        cleanText(category.name),
        cleanText(rootOf(category.name)),
        type,
        category.dotCount,
        Math.round(category.focusSeconds),
        roundTo(category.focusSeconds / 3600, 2),
        category.dotCount > 0 ? Math.round(category.avgDotFocusSeconds) : null,
        roundTo(category.share, 2),
      ];
    }),
  };

  /* 4. 기록 — 점 하나가 한 줄. 오래된 것부터 */
  const dated = [];
  const undated = [];
  (Array.isArray(tree.dots) ? tree.dots : []).forEach((dot) => {
    const time = Date.parse(dot.createdAt ?? "");
    (Number.isNaN(time) ? undated : dated).push({ dot, time });
  });
  dated.sort((a, b) => a.time - b.time);
  const ordered = [...dated, ...undated.map((entry) => ({ ...entry, time: NaN }))];

  const recordsSheet = {
    name: SHEET_NAMES.records,
    columns: [
      { label: "Seed ID", desc: "사용자 식별용 Seed ID. 여러 사람의 파일을 합쳐도 구분됩니다", width: 16 },
      { label: "닉네임", desc: "사용자가 정한 이름", width: 14 },
      { label: "순번", desc: "오래된 기록부터 1, 2, 3 ... (날짜 없는 기록은 맨 뒤)", width: 8 },
      { label: "일시(UTC)", desc: "기록 시각. ISO 8601, 세계 표준시", width: 22 },
      { label: "날짜(KST)", desc: "한국 시간 기준 날짜 (YYYY-MM-DD)", width: 12 },
      { label: "종류", desc: "씨앗 / 가지 / 잎 / 잡초", width: 8 },
      { label: "카테고리", desc: "기록된 카테고리 이름. 없으면 빈칸", width: 24 },
      { label: "대분류", desc: "카테고리 이름의 첫 번째 단계", width: 14 },
      { label: "집중시간(초)", desc: "이 기록에 쌓인 집중 시간. 잡초는 0", unit: "초", width: 14 },
      { label: "집중시간(분)", desc: "집중시간(초)를 분으로 환산 (소수 2자리)", unit: "분", width: 14 },
      { label: "잡초 개수", desc: "잡초 기록이 쌓인 개수. 잡초가 아니면 빈칸", unit: "개", width: 10 },
      { label: "x좌표", desc: "나무 격자의 열 번호 (0부터, 왼쪽이 0)", width: 8 },
      { label: "y좌표", desc: `나무 격자의 행 번호 (0부터, 위쪽이 0, 땅은 ${GROUND_ROW})`, width: 8 },
      { label: "색상", desc: "점 색상 (#RRGGBB)", width: 10 },
    ],
    rows: ordered.map(({ dot, time }, index) => {
      const isWeed = dot.type === "weed";
      const name = dot.categoryId ? categoryName.get(String(dot.categoryId)) ?? "미분류" : "";
      const focus = Math.max(0, toFiniteNumber(dot.focusSeconds));
      return [
        seedId,
        nickname,
        index + 1,
        Number.isNaN(time) ? "" : new Date(time).toISOString(),
        Number.isNaN(time) ? "" : kstDate(dot.createdAt),
        cleanText(DOT_TYPE_LABEL[dot.type] ?? dot.type),
        cleanText(name),
        cleanText(name ? rootOf(name) : ""),
        Math.round(focus),
        roundTo(focus / 60, 2),
        isWeed ? Math.max(1, Math.round(toFiniteNumber(dot.count, 1))) : null,
        dot.x,
        dot.y,
        cleanText(dot.colorHex ?? ""),
      ];
    }),
  };

  /* 5. 데이터 설명 (공공데이터의 "컬럼 설명"에 해당) */
  const dictionarySheet = {
    name: SHEET_NAMES.dictionary,
    columns: [
      { label: "시트", desc: "시트 이름", width: 18 },
      { label: "컬럼", desc: "컬럼 이름", width: 24 },
      { label: "단위", desc: "값의 단위", width: 8 },
      { label: "설명", desc: "컬럼 설명", width: 70 },
    ],
    rows: [],
  };
  [summarySheet, fieldsSheet, categoriesSheet, recordsSheet].forEach((sheet) => {
    sheet.columns.forEach((column) => {
      dictionarySheet.rows.push([sheet.name, column.label, column.unit ?? "", column.desc]);
    });
  });

  return [summarySheet, fieldsSheet, categoriesSheet, recordsSheet, dictionarySheet];
}

/* ──────────────────────────── CSV ──────────────────────────── */

/** CSV 를 엑셀로 열 때 수식으로 실행될 수 있는 시작 글자 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** CSV 셀 하나를 만듭니다. */
export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";

  let text = cleanText(value);
  // 수식 주입 방지: 따옴표를 앞에 붙이면 엑셀이 글자로만 읽습니다. (OWASP 권고)
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 시트 하나를 CSV 문자열로 만듭니다.
 * BOM 으로 시작하고 줄바꿈은 CRLF 입니다. (엑셀이 UTF-8 한글을 바로 읽습니다)
 */
export function sheetToCsv(sheet) {
  const lines = [sheet.columns.map((c) => csvCell(c.label)).join(",")];
  sheet.rows.forEach((row) => lines.push(row.map(csvCell).join(",")));
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

/* ──────────────────────────── XLSX (zip + XML, 의존성 없음) ──────────────────────────── */

const textEncoder = new TextEncoder();

/** CRC-32 표 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Date → ZIP 에 쓰는 DOS 날짜/시간 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 압축 없이(저장 방식) ZIP 을 만듭니다. xlsx 는 이것으로 충분합니다.
 * @param {Array<{name:string, data:Uint8Array}>} files
 */
export function createZip(files, now = new Date()) {
  const { time, date } = dosDateTime(now);
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (bytes) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 필요한 버전
    local.setUint16(6, 0x0800, true); // UTF-8 이름
    local.setUint16(8, 0, true); // 저장(무압축)
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    const headerOffset = offset;
    push(new Uint8Array(local.buffer));
    push(nameBytes);
    push(file.data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true); // 만든 버전
    entry.setUint16(6, 20, true); // 필요한 버전
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, date, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint16(30, 0, true); // extra
    entry.setUint16(32, 0, true); // comment
    entry.setUint16(34, 0, true); // disk
    entry.setUint16(36, 0, true); // 내부 속성
    entry.setUint32(38, 0, true); // 외부 속성
    entry.setUint32(42, headerOffset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
  }

  const centralStart = offset;
  central.forEach(push);
  const centralSize = offset - centralStart;

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  push(new Uint8Array(end.buffer));

  const out = new Uint8Array(offset);
  let position = 0;
  chunks.forEach((chunk) => {
    out.set(chunk, position);
    position += chunk.length;
  });
  return out;
}

/** XML 본문/속성에 넣을 글자 이스케이프 */
export function xmlEscape(value) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 → A, 25 → Z, 26 → AA */
export function columnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

/** 시트 이름 규칙: 31자 이하, `: \ / ? * [ ]` 금지, 중복 금지 */
export function safeSheetName(name, taken = new Set()) {
  let base = cleanText(name).replace(/[:\\/?*[\]]/g, "_").trim().slice(0, 31) || "Sheet";
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = `_${n}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** 스타일: 0 기본, 1 머리글, 2 정수(천 단위 구분), 3 소수(천 단위 구분 + 2자리) */
const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Malgun Gothic"/></font>' +
  '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Malgun Gothic"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF1E3932"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
  '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  "</cellXfs>" +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** 셀 XML 하나 */
function cellXml(ref, value, style) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    const s = style ?? (Number.isInteger(value) ? 2 : 3);
    return `<c r="${ref}" s="${s}"><v>${value}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
}

/** 시트 하나의 XML */
function sheetXml(sheet) {
  const colCount = sheet.columns.length;
  const lastCol = columnName(colCount - 1);
  const rowCount = sheet.rows.length + 1;

  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.max(6, c.width ?? 14)}" customWidth="1"/>`)
    .join("");

  const headerCells = sheet.columns
    .map((c, i) => cellXml(`${columnName(i)}1`, c.label, 1))
    .join("");
  let rowsXml = `<row r="1" ht="22" customHeight="1">${headerCells}</row>`;

  sheet.rows.forEach((row, r) => {
    const cells = row.map((value, i) => cellXml(`${columnName(i)}${r + 2}`, value)).join("");
    rowsXml += `<row r="${r + 2}">${cells}</row>`;
  });

  const filter = sheet.rows.length > 0 ? `<autoFilter ref="A1:${lastCol}${rowCount}"/>` : "";

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<dimension ref="A1:${lastCol}${rowCount}"/>` +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    `<cols>${cols}</cols><sheetData>${rowsXml}</sheetData>${filter}</worksheet>`
  );
}

/**
 * 시트들을 .xlsx 파일(바이트)로 만듭니다.
 * @param {Array<{name:string, columns:object[], rows:Array<Array<number|string|null>>}>} sheets
 */
export function buildXlsx(sheets, now = new Date()) {
  const taken = new Set();
  const named = sheets.map((sheet) => ({ ...sheet, name: safeSheetName(sheet.name, taken) }));

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    named
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
    "</sheets></workbook>";

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    named
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join("") +
    `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    "</Relationships>";

  const files = [
    { name: "[Content_Types].xml", data: textEncoder.encode(contentTypes) },
    { name: "_rels/.rels", data: textEncoder.encode(rootRels) },
    { name: "xl/workbook.xml", data: textEncoder.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: textEncoder.encode(workbookRels) },
    { name: "xl/styles.xml", data: textEncoder.encode(STYLES_XML) },
    ...named.map((sheet, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: textEncoder.encode(sheetXml(sheet)),
    })),
  ];
  return createZip(files, now);
}

/* ──────────────────────────── 내려받기 ──────────────────────────── */

/** 파일 이름. 확장자 제외. kind 는 영문으로 두어 어디서나 안전합니다. */
export function dataFileName(tree, kind, now = new Date()) {
  return `SilTime_${safeSeed(tree.seedId)}_${kind}_${dateStamp(now)}`;
}

/** 기록을 CSV 로 내려받습니다. */
export function exportRecordsCsv(tree, now = new Date()) {
  const sheets = buildDatasets(tree, now);
  const records = sheets.find((s) => s.name === SHEET_NAMES.records);
  const csv = sheetToCsv(records);
  const fileName = `${dataFileName(tree, "records", now)}.csv`;
  downloadBlob(new Blob([csv], { type: CSV_MIME }), fileName);
  return { fileName, rows: records.rows.length, bytes: textEncoder.encode(csv).length };
}

/** 엑셀(.xlsx)로 내려받습니다. */
export function exportWorkbook(tree, now = new Date()) {
  const sheets = buildDatasets(tree, now);
  const bytes = buildXlsx(sheets, now);
  const fileName = `${dataFileName(tree, "data", now)}.xlsx`;
  downloadBlob(new Blob([bytes], { type: XLSX_MIME }), fileName);
  return { fileName, sheets: sheets.length, bytes: bytes.length };
}
