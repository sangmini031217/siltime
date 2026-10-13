/**
 * dotFont.js — 5x7 도트 글자 (첫 화면 "SilTime" 로고용)
 *
 * 글자 한 칸이 도트 격자의 한 칸이 됩니다. 그래서 로고가 배경 격자와 한 몸으로 보입니다.
 * 로고에 쓰는 글자만 정의했습니다. 정의되지 않은 글자는 건너뜁니다.
 */

/** 글자 한 개: 7줄 x 5칸. `#` 이 켜진 도트입니다. */
const GLYPHS = Object.freeze({
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  i: ["..#..", ".....", ".##..", "..#..", "..#..", "..#..", ".###."],
  l: [".##..", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  m: [".....", ".....", "##.#.", "#.#.#", "#.#.#", "#.#.#", "#.#.#"],
  e: [".....", ".....", ".###.", "#...#", "#####", "#....", ".###."],
});

/** 글자 높이(칸) */
export const GLYPH_ROWS = 7;

/** 글자 폭(칸) */
export const GLYPH_COLS = 5;

/** 글자 사이 빈 칸 */
const LETTER_GAP = 1;

/**
 * 문자열을 켜진 칸 좌표 목록으로 바꿉니다.
 * @param {string} text
 * @returns {{cells: Array<[number, number]>, cols: number, rows: number}}
 *   cells 는 [열, 행] 쌍, cols/rows 는 전체 크기(칸)
 */
export function dotText(text) {
  const cells = [];
  let cursor = 0;
  let drawn = 0;

  for (const char of String(text ?? "")) {
    const glyph = GLYPHS[char];
    if (!glyph) continue; // 정의 없는 글자는 건너뜀
    if (drawn > 0) cursor += LETTER_GAP;

    glyph.forEach((line, row) => {
      for (let col = 0; col < GLYPH_COLS; col += 1) {
        if (line[col] === "#") cells.push([cursor + col, row]);
      }
    });
    cursor += GLYPH_COLS;
    drawn += 1;
  }

  return { cells, cols: cursor, rows: drawn > 0 ? GLYPH_ROWS : 0 };
}

/** 로고 글자 */
export const WORDMARK = "SilTime";
