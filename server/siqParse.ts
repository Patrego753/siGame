import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import unzipper from "unzipper";
import { XMLParser } from "fast-xml-parser";
import type {
  BoardRound,
  BoardTheme,
  ContentItem,
  ParsedQuestion,
} from "../shared/gameTypes.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  trimValues: true,
  isArray: (name) =>
    [
      "round",
      "theme",
      "question",
      "item",
      "param",
      "answer",
      "atom",
      "author",
      "source",
    ].includes(name),
});

function listRounds(pkg: Record<string, unknown>): unknown[] {
  const flat = asArray(pkg.round);
  if (flat.length) return flat;
  const wrapped = pkg.rounds as Record<string, unknown> | undefined;
  return asArray(wrapped?.round);
}
function listThemes(r: Record<string, unknown>): unknown[] {
  const flat = asArray(r.theme);
  if (flat.length) return flat;
  const wrapped = r.themes as Record<string, unknown> | undefined;
  return asArray(wrapped?.theme);
}
function listQuestions(t: Record<string, unknown>): unknown[] {
  const flat = asArray(t.question);
  if (flat.length) return flat;
  const wrapped = t.questions as Record<string, unknown> | undefined;
  return asArray(wrapped?.question);
}
function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}
function readText(el: unknown): string {
  if (el === null || el === undefined) return "";
  if (typeof el === "string" || typeof el === "number") return String(el);
  if (typeof el === "object" && "#text" in (el as object)) {
    return String((el as { "#text": string })["#text"]);
  }
  return "";
}
function parseBracketMediaRef(raw: string): { type: string; value: string } | null {
  const m = raw.match(/^\[(image|video|audio|voice|sound)\]\s*(.+)$/i);
  if (!m) return null;
  return { type: m[1].toLowerCase(), value: m[2].trim() };
}
function parseContentItems(param: unknown): ContentItem[] {
  if (!param || typeof param !== "object") return [];
  const items = asArray((param as { item?: unknown }).item);
  const out: ContentItem[] = [];
  for (const raw of items) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    let type = String(o["@_type"] ?? "text");
    const isRefAttr = o["@_isRef"];
    let isRef = isRefAttr === true || String(isRefAttr ?? "").toLowerCase().trim() === "true";
    let placement = String(o["@_placement"] ?? (type === "audio" ? "background" : "screen"));
    const duration = o["@_duration"] !== undefined ? String(o["@_duration"]) : undefined;
    const waitForFinish = o["@_waitForFinish"] === undefined
      ? true
      : o["@_waitForFinish"] === true || String(o["@_waitForFinish"]).toLowerCase().trim() === "true";
    let value = readText(o["#text"] ?? o);
    const bracketMedia = parseBracketMediaRef(value);
    if (bracketMedia) {
      type = bracketMedia.type;
      value = bracketMedia.value;
      isRef = true;
      if (o["@_placement"] === undefined) {
        placement = type === "audio" || type === "voice" || type === "sound" ? "background" : "screen";
      }
    }
    out.push({ type, value, isRef, placement, duration, waitForFinish });
  }
  return out;
}
function findParam(params: unknown, name: string): unknown {
  const list = asArray((params as { param?: unknown })?.param);
  for (const p of list) {
    if (typeof p !== "object" || p === null) continue;
    const o = p as Record<string, unknown>;
    if (String(o["@_name"] ?? "") === name) return p;
  }
  return null;
}
function atomsToContent(atoms: unknown[]): { q: ContentItem[]; a: ContentItem[] } {
  const q: ContentItem[] = [];
  const a: ContentItem[] = [];
  let inAnswer = false;
  for (const raw of atoms) {
    if (typeof raw !== "object" || raw === null) continue;
    const o = raw as Record<string, unknown>;
    const type = String(o["@_type"] ?? "text");
    if (type === "marker") {
      inAnswer = true;
      continue;
    }
    const atomTime = o["@_time"];
    const text = readText(o["#text"] ?? o);
    const isLink = text.length > 0 && text[0] === "@";
    const value = isLink ? text.slice(1) : text;
    const mapType = (t: string) => (t === "oral" ? "text" : t === "sound" ? "audio" : t);
    const nt = mapType(type);
    const placement = type === "oral" ? "replic" : type === "sound" || nt === "audio" ? "background" : "screen";
    const item: ContentItem = { type: nt, value, isRef: isLink, placement, duration: atomTime !== undefined ? String(atomTime) : undefined, waitForFinish: true };
    (inAnswer ? a : q).push(item);
  }
  return { q, a };
}
function parseQuestion(raw: unknown): ParsedQuestion {
  const o = raw as Record<string, unknown>;
  const price = Number(o["@_price"] ?? 0);
  const typeName = String(o["@_type"] ?? "simple");
  let questionContent: ContentItem[] = [];
  let answerContent: ContentItem[] = [];
  const rightTextAnswers: string[] = [];
  const wrongTextAnswers: string[] = [];
  const params = o.params;
  if (params) {
    const qParam = findParam(params, "question");
    if (qParam) questionContent = parseContentItems(qParam);
    const aParam = findParam(params, "answer");
    if (aParam) answerContent = parseContentItems(aParam);
  }
  const scenario = o.scenario;
  if (scenario && questionContent.length === 0) {
    const atoms = asArray((scenario as { atom?: unknown }).atom);
    const conv = atomsToContent(atoms);
    questionContent = conv.q;
    answerContent = conv.a;
  }
  const right = o.right as { answer?: unknown } | undefined;
  for (const ans of asArray(right?.answer)) rightTextAnswers.push(typeof ans === "string" ? ans : readText(ans));
  const wrong = o.wrong as { answer?: unknown } | undefined;
  for (const ans of asArray(wrong?.answer)) wrongTextAnswers.push(typeof ans === "string" ? ans : readText(ans));
  if (rightTextAnswers.length === 0) rightTextAnswers.push("");
  return { price, typeName, questionContent, answerContent, rightTextAnswers, wrongTextAnswers };
}

export type LoadedPack = {
  name: string;
  restriction?: string;
  language?: string;
  difficulty?: number;
  rounds: BoardRound[];
  questions: ParsedQuestion[][][];
  /** Нормализованный путь внутри SIQ -> извлечённый файл на диске. */
  files: Map<string, string>;
  storageDir: string;
};

function normalizeZipPath(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/^\/+/, "");
  try { return decodeURIComponent(s); } catch { return s; }
}
function safeTarget(root: string, zipPath: string): string {
  const normalized = normalizeZipPath(zipPath);
  const target = path.resolve(root, normalized);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error("Небезопасный путь в архиве");
  return target;
}

export async function parseSiqFile(inputPath: string, storageDir: string): Promise<LoadedPack> {
  await fsp.mkdir(storageDir, { recursive: true });
  const directory = await unzipper.Open.file(inputPath);
  const files = new Map<string, string>();
  let xml = "";
  for (const entry of directory.files) {
    const zipPath = normalizeZipPath(entry.path);
    if (!zipPath || entry.type === "Directory") continue;
    const target = safeTarget(storageDir, zipPath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    if (zipPath.toLowerCase() === "content.xml" || zipPath.toLowerCase().endsWith("/content.xml")) {
      xml = (await entry.buffer()).toString("utf-8");
      files.set(zipPath, target);
    } else {
      await pipeline(entry.stream(), fs.createWriteStream(target));
      files.set(zipPath, target);
    }
  }
  if (!xml) throw new Error("В архиве нет content.xml");
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  const doc = parser.parse(xml) as { package?: unknown };
  const pkg = doc.package as Record<string, unknown> | undefined;
  if (!pkg) throw new Error("Некорректный content.xml");
  const name = String(pkg["@_name"] ?? "Пакет");
  const restriction = pkg["@_restriction"] ? String(pkg["@_restriction"]) : undefined;
  const language = pkg["@_language"] ? String(pkg["@_language"]) : undefined;
  const difficulty = pkg["@_difficulty"] !== undefined ? Number(pkg["@_difficulty"]) : undefined;
  const roundsRaw = listRounds(pkg);
  const rounds: BoardRound[] = [];
  const questions: ParsedQuestion[][][] = [];
  for (const rr of roundsRaw) {
    if (typeof rr !== "object" || rr === null) continue;
    const r = rr as Record<string, unknown>;
    const themesRaw = listThemes(r);
    const themes: BoardTheme[] = [];
    const rq: ParsedQuestion[][] = [];
    for (const tt of themesRaw) {
      if (typeof tt !== "object" || tt === null) continue;
      const t = tt as Record<string, unknown>;
      const themeName = String(t["@_name"] ?? "Тема");
      const questionsRaw = listQuestions(t);
      const cells: { price: number; played: boolean }[] = [];
      const tq: ParsedQuestion[] = [];
      for (const qq of questionsRaw) {
        const pq = parseQuestion(qq);
        tq.push(pq);
        cells.push({ price: pq.price, played: false });
      }
      themes.push({ name: themeName, questions: cells });
      rq.push(tq);
    }
    rounds.push({ name: String(r["@_name"] ?? "Раунд"), type: r["@_type"] ? String(r["@_type"]) : undefined, themes });
    questions.push(rq);
  }
  if (rounds.length === 0) throw new Error("В пакете нет раундов");
  return { name, restriction, language, difficulty, rounds, questions, files, storageDir };
}

export function resolveMediaPath(files: Map<string, string>, ref: string): string | null {
  const clean = ref.replace(/^@/, "").trim();
  const candidates = [clean, `Images/${clean}`, `Audio/${clean}`, `Video/${clean}`, `Html/${clean}`];
  for (const c of candidates) {
    if (files.has(c)) return files.get(c)!;
    const enc = encodeURI(c);
    if (files.has(enc)) return files.get(enc)!;
  }
  for (const [k, value] of files) if (k.endsWith(clean) || k.endsWith("/" + clean)) return value;
  return null;
}
export function guessMime(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return "application/octet-stream";
}
