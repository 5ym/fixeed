#!/usr/bin/env bun
/**
 * goonews.jp の壊れた RSS を取得し、日付を修正して出力する。
 *
 * 修正対象:
 *   1. <updated> の TZ 直後に連結された Unix タイムスタンプのゴミ
 *      例: "Thu, 16 Jul 2026 18:00:10 +09001784192410"
 *        → "Thu, 16 Jul 2026 18:00:10 +0900"
 *   2. <dc:date> に日本語の相対日付が埋め込まれて壊れた W3CDTF
 *      例: "17時39分T+09:00"  → "2026-07-16T17:39:00+09:00"  (時刻のみ = 当日)
 *          "07月15日T+09:00"  → "2026-07-15T00:00:00+09:00"  (月日のみ = 当年)
 *
 * 日付の基準時刻(now)には、可能なら <updated> の値を使う。
 * これにより「同じ入力なら同じ出力」となり冪等・再現可能になる。
 * 依存パッケージ無し。Bun で直接実行する (bun fix-rss.ts)。
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const URL = "https://www.goonews.jp/rss/rssall.xml";
// UA を付けないと 403 で弾かれる
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0 Safari/537.36 fixeed-rss-fixer";
const JST_OFFSET_MIN = 9 * 60;

// TZ (+0900 / -0500 など) の直後に続く余分な数字を除去
const UPDATED_JUNK = /([+-]\d{4})\d+/;
const UPDATED_TAG = /(<updated>)([\s\S]*?)(<\/updated>)/;
const DCDATE_TAG = /(<dc:date>)([\s\S]*?)(<\/dc:date>)/g;
const MONTHDAY = /(\d{1,2})月(\d{1,2})日/;
const HHMM = /(\d{1,2})時(\d{1,2})分/;

const RFC822_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const RFC822_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** JST 上の年月日時分秒を、その瞬間を表す UTC ベースの Date に変換する。 */
function jst(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  // 与えられた値を JST の壁時計として解釈 → UTC ミリ秒に変換
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MIN * 60_000);
}

/** Date を JST の各要素に分解する。 */
function jstParts(d: Date) {
  const shifted = new Date(d.getTime() + JST_OFFSET_MIN * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** <updated> 本文から末尾のゴミを除去する。 */
function cleanUpdatedText(text: string): string {
  return text.trim().replace(UPDATED_JUNK, "$1");
}

/** RFC822 日付文字列(TZは +0900 等)をパースして Date を返す。失敗時 null。 */
function parseRfc822(text: string): Date | null {
  // 例: "Thu, 16 Jul 2026 18:00:10 +0900"
  const m = text.match(
    /(?:\w{3},\s*)?(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})/,
  );
  if (!m) return null;
  const [, dd, mon, yyyy, hh, mm, ss, tz] = m;
  const monthIdx = RFC822_MONTHS.indexOf(mon);
  if (monthIdx < 0) return null;
  const offMin = (tz[0] === "-" ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  const ms = Date.UTC(Number(yyyy), monthIdx, Number(dd), Number(hh), Number(mm), Number(ss)) - offMin * 60_000;
  return new Date(ms);
}

/** Date を JST の RFC822 文字列にする。 */
function toRfc822Jst(d: Date): string {
  const p = jstParts(d);
  return (
    `${RFC822_DAYS[p.weekday]}, ${pad(p.day)} ${RFC822_MONTHS[p.month - 1]} ${p.year} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} +0900`
  );
}

/** 基準となる現在時刻を返す。<updated> を優先し、なければ実時刻。 */
function referenceNow(xml: string): Date {
  const m = xml.match(UPDATED_TAG);
  if (m) {
    const d = parseRfc822(cleanUpdatedText(m[2]));
    if (d) return d;
  }
  return new Date();
}

/** 壊れた dc:date 本文を W3CDTF (ISO8601) に修正する。 */
function fixDcDate(text: string, ref: Date): string {
  const raw = text.trim();
  const md = raw.match(MONTHDAY);
  const hm = raw.match(HHMM);
  if (!md && !hm) return text; // 想定外はそのまま

  const rp = jstParts(ref);
  const month = md ? Number(md[1]) : rp.month;
  const day = md ? Number(md[2]) : rp.day;
  const hour = hm ? Number(hm[1]) : 0;
  const minute = hm ? Number(hm[2]) : 0;

  // 月日のみ(年なし) → 当年。基準時刻より未来になったら前年扱い。
  let year = rp.year;
  let dt = jst(year, month, day, hour, minute, 0);
  if (md && dt.getTime() > ref.getTime() + 86_400_000) {
    year -= 1;
    dt = jst(year, month, day, hour, minute, 0);
  }
  const p = jstParts(dt);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}+09:00`;
}

/** 壊れた RSS 文字列を受け取り、修正済み文字列を返す。 */
export function fixRss(xml: string): string {
  const ref = referenceNow(xml);

  xml = xml.replace(UPDATED_TAG, (_all, open: string, body: string, close: string) => {
    const cleaned = cleanUpdatedText(body);
    const d = parseRfc822(cleaned);
    return `${open}${d ? toRfc822Jst(d) : cleaned}${close}`;
  });

  xml = xml.replace(DCDATE_TAG, (_all, open: string, body: string, close: string) => {
    return `${open}${fixDcDate(body, ref)}${close}`;
  });

  return xml;
}

async function fetchRss(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  return await res.text();
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, def?: string) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const input = opt("-i") ?? opt("--input");
  const output = opt("-o") ?? opt("--output") ?? "public/rssall.xml";
  const url = opt("--url") ?? URL;

  const xml = input ? await Bun.file(input).text() : await fetchRss(url);
  const fixed = fixRss(xml);

  if (output === "-") {
    process.stdout.write(fixed);
  } else {
    await mkdir(dirname(output) || ".", { recursive: true });
    await Bun.write(output, fixed);
    process.stderr.write(`wrote ${output} (${Buffer.byteLength(fixed)} bytes)\n`);
  }
}

// このファイルが直接実行されたときだけ main を走らせる
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
