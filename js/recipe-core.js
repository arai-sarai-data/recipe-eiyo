/*
 * recipe-core.js — レシピ文の解析・食品の対応付け・グラム換算・栄養計算（DOM に依存しない部分）
 * ブラウザでは window.RecipeCore、Node では require() で使う。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RecipeCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- 文字の正規化 ---------- */

  function normalize(s) {
    return String(s == null ? "" : s)
      .normalize("NFKC")
      .replace(/[​-‍﻿]/g, "")
      .replace(/⁄/g, "/") // ½ → 1⁄2 → 1/2
      .replace(/[〜～∼]/g, "~")
      .replace(/[‐‑‒–—―−ー](?=\d)/g, function (m, off, str) {
        // 「1-2個」の範囲記号だけを ~ にする（「ベーコン」の長音は残す）
        var prev = str.charAt(off - 1);
        return /\d/.test(prev) ? "~" : m;
      })
      .replace(/\s+/g, " ")
      .trim();
  }

  function toHiragana(s) {
    return s.replace(/[ァ-ヶ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
  }

  /** 検索用キー: NFKC → カタカナをひらがな → 空白・記号を除く → 英字小文字 */
  function searchKey(s) {
    return toHiragana(normalize(s))
      .toLowerCase()
      .replace(/[\s・,、。.()\[\]<>（）［］＜＞「」『』【】]/g, "");
  }

  /* ---------- 漢数字 ---------- */

  var KANJI_DIGIT = { "〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
  var KANJI_UNIT = { "十": 10, "百": 100, "千": 1000 };

  function kanjiToNumber(str) {
    if (!/^[〇零一二三四五六七八九十百千]+$/.test(str)) return null;
    var total = 0, current = 0;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      if (ch in KANJI_DIGIT) {
        current = current * 10 + KANJI_DIGIT[ch];
      } else {
        var u = KANJI_UNIT[ch];
        total += (current === 0 ? 1 : current) * u;
        current = 0;
      }
    }
    return total + current;
  }

  /** 数量部分の漢数字を算用数字に置き換える（「二分の一」「大さじ二」「一個半」など） */
  function convertKanjiNumerals(s) {
    return s.replace(/[〇零一二三四五六七八九十百千]+/g, function (m) {
      var n = kanjiToNumber(m);
      return n == null ? m : String(n);
    });
  }

  /* ---------- 数量の解析 ---------- */

  var VAGUE_WORDS = [
    "少々~適量", "少々", "少量", "適量", "適宜", "ひとつまみ", "一つまみ", "1つまみ", "ふたつまみ", "二つまみ", "2つまみ",
    "ひとつまみ程度", "少し", "お好みで", "好みで", "お好み", "好み", "適当", "ひとふり", "一振り", "1振り", "少しずつ", "ひとかけら", "各少々", "各適量"
  ];

  var PRE_UNITS = [
    ["大さじ", "大さじ"], ["大匙", "大さじ"], ["大スプーン", "大さじ"], ["tbsp", "大さじ"], ["大", "大さじ"],
    ["小さじ", "小さじ"], ["小匙", "小さじ"], ["小スプーン", "小さじ"], ["tsp", "小さじ"], ["小", "小さじ"],
    ["計量カップ", "カップ"], ["カップ", "カップ"], ["cup", "カップ"]
  ];

  // [表記, 正規化した単位, 種別, グラム/ミリリットルへの係数]
  var POST_UNITS = [
    ["キログラム", "kg", "mass", 1000], ["kg", "kg", "mass", 1000], ["キロ", "kg", "mass", 1000],
    ["ミリグラム", "mg", "mass", 0.001], ["mg", "mg", "mass", 0.001],
    ["グラム", "g", "mass", 1], ["gr", "g", "mass", 1], ["g", "g", "mass", 1],
    ["ミリリットル", "mL", "volume", 1], ["ml", "mL", "volume", 1], ["cc", "mL", "volume", 1],
    ["リットル", "L", "volume", 1000], ["l", "L", "volume", 1000],
    ["カップ", "カップ", "volume", null], ["cup", "カップ", "volume", null], ["合", "合", "volume", null],
    ["センチ", "cm", "piece"], ["cm", "cm", "piece"],
    ["切れ", "切れ", "piece"], ["切", "切れ", "piece"], ["かけ", "かけ", "piece"], ["片", "片", "piece"],
    ["パック", "パック", "piece"], ["袋", "袋", "piece"], ["缶", "缶", "piece"], ["箱", "箱", "piece"],
    ["個", "個", "piece"], ["コ", "個", "piece"], ["ケ", "個", "piece"], ["ヶ", "個", "piece"], ["こ", "個", "piece"], ["つ", "個", "piece"],
    ["匹", "匹", "piece"], ["尾", "尾", "piece"], ["本", "本", "piece"], ["枚", "枚", "piece"], ["丁", "丁", "piece"],
    ["玉", "玉", "piece"], ["株", "株", "piece"], ["束", "束", "piece"], ["把", "把", "piece"], ["房", "房", "piece"],
    ["粒", "粒", "piece"], ["杯", "杯", "piece"], ["膳", "膳", "piece"], ["腹", "腹", "piece"], ["節", "節", "piece"],
    ["羽", "羽", "piece"], ["枝", "枝", "piece"], ["さや", "さや", "piece"], ["かぶ", "株", "piece"], ["人分", "人分", "piece"]
  ];

  var VOLUME_PRE = { "大さじ": 1, "小さじ": 1, "カップ": 1 };

  var CONTAINERS = ["お茶碗", "茶碗", "茶わん", "どんぶり", "丼", "お椀", "椀", "湯のみ", "コップ", "グラス", "マグカップ"];

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  var NUM = "\\d+(?:\\.\\d+)?";
  var AMOUNT_RE = new RegExp(
    "^(?:" +
      "(" + NUM + ")\\s*(?:と|・|\\s|and)\\s*(\\d+)\\s*/\\s*(\\d+)" + // 1と1/2
      "|(\\d+)\\s*分の\\s*(\\d+)" + // 2分の1
      "|(\\d+)\\s*/\\s*(\\d+)" + // 1/2
      "|(" + NUM + ")" + // 1.5
      "|(半分|半)" +
    ")"
  );

  /** 先頭から数量を1つ読む。{value, len} */
  function readAmount(s) {
    var m = AMOUNT_RE.exec(s);
    if (!m) return null;
    var v;
    if (m[1] != null) v = parseFloat(m[1]) + parseInt(m[2], 10) / parseInt(m[3], 10);
    else if (m[4] != null) v = parseInt(m[5], 10) / parseInt(m[4], 10);
    else if (m[6] != null) v = parseInt(m[6], 10) / parseInt(m[7], 10);
    else if (m[8] != null) v = parseFloat(m[8]);
    else v = 0.5;
    if (!isFinite(v)) return null;
    return { value: v, len: m[0].length, text: m[0] };
  }

  /** 範囲（1~2、1から2）を含めて数量を読む */
  function readAmountWithRange(s) {
    var a = readAmount(s);
    if (!a) return null;
    var rest = s.slice(a.len);
    var rm = /^\s*(?:~|から|or|または)\s*/.exec(rest);
    if (rm) {
      var b = readAmount(rest.slice(rm[0].length));
      if (b) {
        return {
          value: (a.value + b.value) / 2,
          len: a.len + rm[0].length + b.len,
          range: [a.value, b.value],
          text: s.slice(0, a.len + rm[0].length + b.len)
        };
      }
    }
    return a;
  }

  function matchPostUnit(s) {
    for (var i = 0; i < POST_UNITS.length; i++) {
      var u = POST_UNITS[i];
      if (s.slice(0, u[0].length).toLowerCase() === u[0].toLowerCase()) {
        return { unit: u[1], type: u[2], factor: u[3], len: u[0].length };
      }
    }
    return null;
  }

  /**
   * 数量の文字列全体を解析する。全体が数量として読めなければ null。
   * 返り値: {amount, unit, unitType: mass|volume|piece|count|vague, range?, modifier?, container?}
   */
  function parseQuantity(raw) {
    var s = convertKanjiNumerals(normalize(raw)).replace(/^(?:約|およそ|各|ほど)\s*/, "");
    s = s.replace(/\s*(?:程度|くらい|ぐらい|位|ほど)$/, "");
    if (!s) return null;
    // 曖昧な量
    for (var i = 0; i < VAGUE_WORDS.length; i++) {
      if (s === normalize(VAGUE_WORDS[i])) return { amount: null, unit: s, unitType: "vague" };
    }
    if (/^(?:少々|適量|適宜|少量)/.test(s) && s.length <= 6) return { amount: null, unit: s, unitType: "vague" };

    // かなの数詞（ひとつ、ひとかけ、ふた切れ）
    s = s.replace(/^ひと(?=[つ切か房束袋枚本株玉粒片パ尾匹])/, "1")
      .replace(/^ふた(?=[つ切か房束袋枚本株玉粒片パ尾匹])/, "2")
      .replace(/^みっ(?=つ)/, "3").replace(/^よっ(?=つ)/, "4").replace(/^いつ(?=つ)/, "5");

    var modifier = null;
    var mm = /(強|弱)$/.exec(s);
    if (mm) { modifier = mm[1]; s = s.slice(0, -1).trim(); }

    // 容器 + 数量 + 杯（茶碗1杯）
    for (var c = 0; c < CONTAINERS.length; c++) {
      if (s.indexOf(CONTAINERS[c]) === 0) {
        var rest = s.slice(CONTAINERS[c].length).trim();
        var am = readAmountWithRange(rest);
        if (am) {
          var tail = rest.slice(am.len).trim();
          if (tail === "" || tail === "杯" || tail === "膳") {
            return finish({ amount: am.value, unit: CONTAINERS[c].replace(/^お/, "") + "1杯", unitType: "piece", range: am.range, container: CONTAINERS[c] });
          }
        }
      }
    }

    // 前置単位（大さじ2、小さじ1/2、カップ1と1/2）
    for (var p = 0; p < PRE_UNITS.length; p++) {
      var pu = PRE_UNITS[p];
      if (s.slice(0, pu[0].length).toLowerCase() === pu[0].toLowerCase()) {
        var r2 = s.slice(pu[0].length).trim();
        var a2 = readAmountWithRange(r2);
        if (a2) {
          var t2 = r2.slice(a2.len).trim();
          if (t2 === "" || t2 === "杯") {
            return finish({ amount: a2.value, unit: pu[1], unitType: "volume", range: a2.range });
          }
          // 「大さじ1杯半」「大さじ1と半分」
          if (t2 === "杯半" || t2 === "半" || t2 === "と半分" || t2 === "と半") {
            return finish({ amount: a2.value + 0.5, unit: pu[1], unitType: "volume" });
          }
        }
        if (r2 === "半分" || r2 === "半") return finish({ amount: 0.5, unit: pu[1], unitType: "volume" });
      }
    }

    // 「半丁」「半個」のように 半 + 単位
    if (s[0] === "半" && s !== "半" && s !== "半分") {
      var u0 = matchPostUnit(s.slice(1));
      if (u0 && u0.len === s.length - 1) return finish({ amount: 0.5, unit: u0.unit, unitType: u0.type, factor: u0.factor });
    }

    // 数量 + 後置単位（200g、1/2個、1個半、2~3本）
    var a3 = readAmountWithRange(s);
    if (a3) {
      var t3 = s.slice(a3.len).trim();
      if (t3 === "") {
        return finish({ amount: a3.value, unit: "", unitType: "count", range: a3.range });
      }
      var u3 = matchPostUnit(t3);
      if (u3) {
        var after = t3.slice(u3.len).trim();
        var amount = a3.value;
        if (after === "半" || after === "と半分") amount += 0.5;
        else if (after !== "") return null;
        return finish({ amount: amount, unit: u3.unit, unitType: u3.type, factor: u3.factor, range: a3.range });
      }
      // 「1/2個分」「1個分」
      var u4 = matchPostUnit(t3.replace(/分$/, ""));
      if (u4 && t3.replace(/分$/, "").length === u4.len) {
        return finish({ amount: a3.value, unit: u4.unit, unitType: u4.type, factor: u4.factor, range: a3.range });
      }
    }
    return null;

    function finish(q) {
      if (modifier) q.modifier = modifier;
      if (q.unitType === "mass") { q.grams = q.amount * q.factor; }
      if (q.unitType === "volume" && q.factor) { q.mL = q.amount * q.factor; }
      delete q.factor;
      if (!q.range) delete q.range;
      return q;
    }
  }

  /* ---------- 1行の解析 ---------- */

  var SECTION_WORDS = ["材料", "作り方", "つくり方", "作りかた", "手順", "調味料", "下味", "合わせ調味料", "たれ", "タレ", "ソース",
    "トッピング", "具材", "具", "生地", "仕上げ", "付け合わせ", "つけ合わせ", "ドレッシング", "煮汁", "漬けだれ", "衣", "A", "B", "C", "D"];
  var STEP_RE = /^(作り方|つくり方|手順|作りかた)/;

  /** 見出し行か（「材料（2人分）」「【A】」「作り方」「鶏の照り焼き 2人分」など） */
  function isHeaderLine(s, serv) {
    var t = convertKanjiNumerals(s)
      .replace(/\(?\s*\d+(?:\.\d+)?\s*(?:~\s*\d+(?:\.\d+)?\s*)?人(?:分|前)\s*\)?/g, " ")
      .replace(/[【】\[\]<>〈〉《》■●◆◇□☆★()（）:：\s]/g, "");
    if (t === "") return !!serv || /^[【\[<〈《■●◆◇□☆★]/.test(s);
    if (/^[【〈《\[<][^【】〈〉《》\[\]<>]+[】〉》\]>]$/.test(s.replace(/\s/g, "")) && !/\d/.test(t)) return true; // 【さんまの塩焼き】
    if (SECTION_WORDS.indexOf(t) >= 0) return true;
    if (/^(作り方|つくり方|手順|作りかた)/.test(t) && !/\d/.test(t)) return true;
    if (serv && !/\d/.test(t)) return true; // 料理名＋人数
    return false;
  }

  function detectServings(s) {
    var m = /(\d+(?:\.\d+)?)\s*(?:~\s*(\d+(?:\.\d+)?)\s*)?人(?:分|前)/.exec(convertKanjiNumerals(s));
    if (!m) return null;
    return { servings: parseFloat(m[1]), range: m[2] ? [parseFloat(m[1]), parseFloat(m[2])] : null };
  }

  function stripLeading(s) {
    return s
      .replace(/^[\s・\-*●○◎◯☆★■□◆◇▪▫※✓✔➤>+]+/, "")
      .replace(/^[(\[<〈【]\s*[A-Za-z]\s*[)\]>〉】]\s*/, "")
      .replace(/^[A-Z](?=\s*[^\x00-\x7F])\s*/, "")
      .trim();
  }

  /** 括弧書きを取り出す。{rest, notes:[], explicit:{grams|mL, net}} */
  function extractParens(s) {
    var notes = [];
    var explicit = null;
    var rest = s.replace(/\(([^()]*)\)/g, function (_, inner) {
      var t = convertKanjiNumerals(inner.trim());
      var m = /^(?:正味|可食部)?\s*(?:約|およそ)?\s*(\d+(?:\.\d+)?)\s*(kg|g|グラム|ml|mL|cc)\s*(?:程度|くらい|前後)?\s*(正味)?$/.exec(t);
      if (m && !explicit) {
        var v = parseFloat(m[1]);
        var unit = m[2].toLowerCase();
        explicit = {};
        if (unit === "kg") explicit.grams = v * 1000;
        else if (unit === "g" || unit === "グラム") explicit.grams = v;
        else explicit.mL = v;
        explicit.net = /正味|可食部/.test(t);
        explicit.text = inner.trim();
      } else if (inner.trim()) {
        notes.push(inner.trim());
      }
      return " ";
    });
    return { rest: rest.replace(/\s+/g, " ").trim(), notes: notes, explicit: explicit };
  }

  /**
   * 材料の1行を解析する。複数材料（「しょうゆ・みりん 各大さじ1」）は配列で返す。
   */
  function parseLine(rawLine) {
    var raw = String(rawLine);
    var s = normalize(raw);
    if (!s) return [{ raw: raw, kind: "blank" }];
    var serv = detectServings(s);
    if (isHeaderLine(s, serv)) {
      return [{ raw: raw, kind: "header", servings: serv, isSteps: STEP_RE.test(s.replace(/^[【\[<(〈《■●◆◇□☆★\s]+/, "")) }];
    }
    if (/^\d+[.)、．]\s*\S/.test(s) && s.length > 14 && /[をにでへと]/.test(s)) {
      return [{ raw: raw, kind: "step" }];
    }
    s = stripLeading(s);
    var p = extractParens(s);
    var body = p.rest;
    var each = false;

    // 区切り文字（…、:、全角/半角スペース）で 名前 と 数量 を分ける。
    // 最も左で「残り全体が数量として読める」位置を探す。
    var name = null, qty = null, qtyText = "";
    var cleaned = body.replace(/(?:\.{2,}|…+|‥+|・{2,}|:|：|\t)/g, " ").replace(/\s+/g, " ").trim();
    for (var i = 1; i < cleaned.length; i++) {
      var tail = cleaned.slice(i).trim();
      var head = cleaned.slice(0, i).trim();
      if (!head) continue;
      var tailNoEach = tail.replace(/^各\s*/, "");
      var q = parseQuantity(tailNoEach);
      if (q) {
        if (tailNoEach !== tail) each = true;
        name = head;
        qty = q;
        qtyText = tail;
        break;
      }
    }
    if (!qty) {
      name = cleaned;
      if (p.explicit && p.explicit.grams != null) {
        qty = { amount: p.explicit.grams, unit: "g", unitType: "mass", grams: p.explicit.grams, fromParen: true };
        p.explicit = null;
      } else if (p.explicit && p.explicit.mL != null) {
        qty = { amount: p.explicit.mL, unit: "mL", unitType: "volume", mL: p.explicit.mL, fromParen: true };
        p.explicit = null;
      }
    }
    name = (name || "").replace(/\s*各$/, "").replace(/[\s:：…・]+$/, "").trim();
    if (/各$/.test(name)) { each = true; name = name.replace(/各$/, "").trim(); }

    var names = [name];
    if (each) {
      names = name.split(/・|、|,/).map(function (x) { return x.trim(); }).filter(Boolean);
    }
    return names.map(function (n) {
      return {
        raw: raw,
        kind: "ingredient",
        name: n,
        qty: qty,
        qtyText: qtyText,
        notes: p.notes,
        explicit: p.explicit,
        each: names.length > 1
      };
    });
  }

  /** レシピ全文を解析する。作り方以降は材料として扱わない。 */
  function parseRecipe(text) {
    var lines = String(text || "").split(/\r?\n/);
    var out = [];
    var servings = null;
    var inSteps = false;
    lines.forEach(function (line, idx) {
      if (inSteps) { if (line.trim()) out.push({ raw: line, kind: "step", lineNo: idx + 1 }); return; }
      parseLine(line).forEach(function (r) {
        r.lineNo = idx + 1;
        if (r.kind === "header") {
          if (r.servings && servings == null) servings = r.servings;
          if (r.isSteps) inSteps = true;
        }
        if (r.kind !== "blank") out.push(r);
      });
    });
    return { items: out, servings: servings };
  }

  /* ---------- 食品検索 ---------- */

  var WATER_RE = /^(水|お湯|湯|熱湯|冷水|氷水|ぬるま湯|氷|水道水|水分)$/;

  function namePartsOf(food) { return food.n.split(/[　 ]+/).filter(Boolean); }

  function isCategory(p) { return /^[＜（［(<\[].*[＞）］)>\]]$/.test(p); }

  /** foods.json と lexicon.json から検索用の索引を作る */
  function buildIndex(foodsData, lexicon) {
    var foods = foodsData.foods;
    var byCode = {};
    var entries = foods.map(function (f) {
      byCode[f.c] = f;
      var parts = namePartsOf(f);
      var core = parts.filter(function (p) { return !isCategory(p); });
      var keys = core.map(searchKey);
      var alias = (f.a || []).map(searchKey);
      return {
        food: f,
        key: searchKey(core.join("")),
        fullKey: searchKey(f.n),
        partKeys: keys,
        aliasKeys: alias,
        raw: core.indexOf("生") >= 0,
        nParts: core.length
      };
    });
    var aliasMap = {};
    var aliasList = [];
    (lexicon && lexicon.aliases || []).forEach(function (a) {
      a.w.forEach(function (w) {
        var k = searchKey(w);
        if (!aliasMap[k]) { aliasMap[k] = a.c; aliasList.push({ key: k, code: a.c, word: w }); }
      });
    });
    aliasList.sort(function (x, y) { return y.key.length - x.key.length; });
    return { foods: foods, byCode: byCode, entries: entries, aliasMap: aliasMap, aliasList: aliasList, lexicon: lexicon };
  }

  /** 名前から初期候補の食品番号を決める（辞書 → 部分一致 → 全文検索） */
  function findAlias(index, name) {
    var k = searchKey(name);
    if (!k) return null;
    if (index.aliasMap[k]) return { code: index.aliasMap[k], how: "辞書（完全一致）", word: name };
    for (var i = 0; i < index.aliasList.length; i++) {
      var a = index.aliasList[i];
      if (a.key.length >= 2 && k.indexOf(a.key) >= 0) return { code: a.code, how: "辞書（「" + a.word + "」を含む）", word: a.word };
    }
    return null;
  }

  function scoreEntry(e, q) {
    var s = 0;
    if (e.partKeys.indexOf(q) >= 0) s += 100;
    else if (e.aliasKeys.indexOf(q) >= 0) s += 90;
    else if (e.key.indexOf(q) === 0) s += 60;
    else if (e.key.indexOf(q) >= 0) s += 40;
    else if (e.aliasKeys.some(function (a) { return a.indexOf(q) >= 0; })) s += 35;
    else if (e.fullKey.indexOf(q) >= 0) s += 20;
    else return 0;
    if (e.raw) s += 8;
    s -= e.nParts * 2;
    return s;
  }

  /** 食品を検索して候補を返す。[{code, name, score}] */
  function searchFoods(index, query, limit) {
    limit = limit || 20;
    var toks = normalize(query).split(/[\s・、,]+/).map(searchKey).filter(Boolean);
    if (toks.length > 1) {
      // 複数語（「さんま 焼き」）: すべての語を含む食品
      var multi = [];
      for (var j = 0; j < index.entries.length; j++) {
        var e = index.entries[j], total = 0, okAll = true;
        for (var k = 0; k < toks.length; k++) {
          var sc0 = scoreEntry(e, toks[k]);
          if (!sc0) { okAll = false; break; }
          total += sc0;
        }
        if (okAll) multi.push({ code: e.food.c, name: e.food.n, score: total });
      }
      if (multi.length) {
        multi.sort(function (a, b) { return b.score - a.score || a.name.length - b.name.length || (a.code < b.code ? -1 : 1); });
        return multi.slice(0, limit);
      }
    }
    var q = searchKey(query);
    if (!q) return [];
    var tries = [q];
    // 見つからないときは末尾・先頭を削って再検索（例: 豚こま切れ肉 → 豚こま…）
    for (var cut = 1; cut <= Math.max(0, q.length - 2); cut++) { tries.push(q.slice(0, q.length - cut)); tries.push(q.slice(cut)); }
    for (var t = 0; t < tries.length; t++) {
      var qq = tries[t];
      if (qq.length < 1 || (t > 0 && qq.length < 2)) continue;
      var hits = [];
      for (var i = 0; i < index.entries.length; i++) {
        var sc = scoreEntry(index.entries[i], qq);
        if (sc > 0) hits.push({ code: index.entries[i].food.c, name: index.entries[i].food.n, score: sc });
      }
      if (hits.length) {
        hits.sort(function (a, b) { return b.score - a.score || a.name.length - b.name.length || (a.code < b.code ? -1 : 1); });
        return hits.slice(0, limit).map(function (h) { h.partial = t > 0; h.query = qq; return h; });
      }
    }
    return [];
  }

  /** 名前に対する候補一覧（先頭が初期選択） */
  function candidatesFor(index, name, limit) {
    limit = limit || 15;
    var list = [];
    var seen = {};
    var al = findAlias(index, name);
    if (al && index.byCode[al.code]) {
      list.push({ code: al.code, name: index.byCode[al.code].n, how: al.how });
      seen[al.code] = 1;
      // 辞書の語で検索した近い食品も候補に足す
      searchFoods(index, al.word, limit).forEach(function (h) { if (!seen[h.code]) { seen[h.code] = 1; list.push({ code: h.code, name: h.name, how: "検索" }); } });
    }
    searchFoods(index, name, limit).forEach(function (h) {
      if (!seen[h.code]) { seen[h.code] = 1; list.push({ code: h.code, name: h.name, how: h.partial ? "部分一致（" + h.query + "）" : "検索" }); }
    });
    return list.slice(0, limit);
  }

  /* ---------- 成分値の解釈 ---------- */

  /** 原表の表記を数値に。{n, est, tr, missing} */
  function interpretValue(v) {
    if (v == null || v === "-" || v === "") return { n: null, missing: true };
    if (typeof v === "number") return { n: v };
    if (v === "Tr") return { n: 0, tr: true };
    if (v === "(Tr)") return { n: 0, tr: true, est: true };
    var m = /^\((-?\d+(?:\.\d+)?)\)$/.exec(v);
    if (m) return { n: parseFloat(m[1]), est: true };
    var f = parseFloat(v);
    if (isFinite(f)) return { n: f };
    return { n: null, missing: true };
  }

  /* ---------- グラム換算 ---------- */

  function fmt(n, d) {
    if (n == null || !isFinite(n)) return "-";
    var p = Math.pow(10, d == null ? 1 : d);
    return String(Math.round(n * p) / p);
  }

  function refuseOptions(food) {
    var opts = [];
    var r = interpretValue(food.r).n;
    opts.push({ id: "std", pct: r || 0, label: "成分表の廃棄率 " + (r || 0) + "%" + (food.rp ? "（廃棄部位: " + food.rp + "）" : "") });
    (food.ar || []).forEach(function (a, i) {
      opts.push({ id: "alt" + i, pct: a.pct, label: "備考: " + a.cond + " 廃棄率 " + a.pct + "%" });
    });
    opts.push({ id: "none", pct: 0, label: "廃棄なし（入力が可食部の重さ）" });
    return opts;
  }

  /** 個数単位で丸ごと扱うときの廃棄率の自動選択 */
  function autoRefuse(food, unit) {
    var opts = refuseOptions(food);
    if (unit === "匹" || unit === "尾") {
      for (var i = 1; i < opts.length; i++) {
        if (/魚体全体|全体の場合/.test(opts[i].label)) return opts[i];
      }
    }
    return opts[0];
  }

  /**
   * 1行の食材を可食部グラムに換算する。
   * opts: {lexicon, userWeight: 1単位あたりの丸ごと重量g（任意）, refuse: "auto"|"std"|"altN"|"none",
   *        massIsGross: bool, manualGrams: 可食部gの直接指定}
   * 返り値: {status, grams, basis:[...], refusePct, needs}
   */
  function resolveGrams(item, food, opts) {
    opts = opts || {};
    var lex = opts.lexicon || {};
    var basis = [];
    var q = item.qty;
    if (opts.manualGrams != null && isFinite(opts.manualGrams)) {
      return { status: "ok", grams: opts.manualGrams, basis: ["重さを直接指定: 可食部 " + fmt(opts.manualGrams) + " g"] };
    }
    if (WATER_RE.test(normalize(item.name))) {
      return { status: "water", grams: null, basis: ["水は成分表（本表）に収載がないため計算対象外"] };
    }
    if (q && q.unitType === "vague") {
      return { status: "vague", grams: null, basis: ["「" + q.unit + "」は量が決まらないため計算対象外"] };
    }
    if (!food) return { status: "nofood", grams: null, basis: ["成分表の食品が未選択のため計算対象外"] };

    var refOpt = pickRefuse(food, q ? q.unit : "", opts.refuse);

    // 括弧内の重量（「1枚(300g)」）
    if (item.explicit && item.explicit.grams != null) {
      var g0 = item.explicit.grams;
      if (item.explicit.net) {
        basis.push("括弧内の重量（正味）" + fmt(g0) + " g をそのまま可食部として使用");
        return { status: "ok", grams: g0, basis: basis, refusePct: 0 };
      }
      basis.push("括弧内の重量「" + item.explicit.text + "」を丸ごとの重さとして使用");
      return applyRefuse(g0, refOpt, basis);
    }
    if (!q) return { status: "noqty", grams: null, basis: ["分量が読み取れないため計算対象外（重さを入力すると計算します）"], needs: "grams" };

    if (q.unitType === "mass") {
      basis.push("入力の重さ " + fmt(q.grams) + " g");
      if (opts.massIsGross) return applyRefuse(q.grams, refOpt, basis);
      basis.push("可食部（正味）の重さとして計算");
      return { status: "ok", grams: q.grams, basis: basis, refusePct: 0 };
    }

    if (q.unitType === "volume") {
      var vols = (lex.measures && lex.measures.volumes) || {};
      var mL = q.mL;
      if (mL == null) {
        var vdef = vols[q.unit];
        if (!vdef) return { status: "needweight", grams: null, basis: ["単位「" + q.unit + "」の容量が未収録"], needs: "unit" };
        mL = q.amount * vdef.mL;
        basis.push(q.unit + " = " + vdef.mL + " mL（出典: " + srcNames(lex, vdef.sources) + "）→ " + fmt(mL) + " mL");
      } else {
        basis.push("容量 " + fmt(mL) + " mL");
      }
      if (food.d != null) {
        var g1 = mL * food.d / 100;
        basis.push("成分表の備考「100 mL：" + food.d + " g」より " + fmt(mL) + " mL × " + fmt(food.d / 100, 4) + " = " + fmt(g1) + " g");
        return { status: "ok", grams: g1, basis: basis, refusePct: 0 };
      }
      var ms = (lex.measures && lex.measures.byFood && lex.measures.byFood[food.c]) || [];
      for (var i = 0; i < ms.length; i++) {
        var e = ms[i];
        var key = { "小さじ": "tsp", "大さじ": "tbsp", "カップ": "cup", "合": "go" }[q.unit];
        var src = srcNames(lex, [e.src]);
        if (key && e[key] != null) {
          var g2 = q.amount * e[key];
          basis.push("計量表「" + e.label + "」" + q.unit + "1 = " + e[key] + " g（出典: " + src + "）→ " + fmt(g2) + " g");
          return { status: "ok", grams: g2, basis: basis, refusePct: 0 };
        }
        if (e.cup != null) {
          var g3 = mL * e.cup / 200;
          basis.push("計量表「" + e.label + "」カップ(200 mL) = " + e.cup + " g（出典: " + src + "）から比例換算 → " + fmt(g3) + " g");
          return { status: "ok", grams: g3, basis: basis, refusePct: 0 };
        }
      }
      basis.push("この食品の容量→重量の換算値は未収録（成分表の備考・計量表のどちらにもなし）");
      return { status: "needweight", grams: null, basis: basis, needs: "density" };
    }

    // 個数・長さなど（piece / count）
    var unitLabel = q.unit || "個";
    if (opts.userWeight != null && isFinite(opts.userWeight) && opts.userWeight > 0) {
      var gross = q.amount * opts.userWeight;
      basis.push("1" + unitLabel + " = " + fmt(opts.userWeight) + " g（あなたが入力した値）× " + fmt(q.amount, 3) + " = " + fmt(gross) + " g（丸ごと）");
      return applyRefuse(gross, refOpt, basis);
    }
    basis.push("「1" + unitLabel + "」の目安重量は未収録。1" + unitLabel + "あたりの重さを入力すると計算します");
    return { status: "needweight", grams: null, basis: basis, needs: "piece", unit: unitLabel };
  }

  function pickRefuse(food, unit, choice) {
    var opts = refuseOptions(food);
    if (!choice || choice === "auto") return autoRefuse(food, unit);
    for (var i = 0; i < opts.length; i++) if (opts[i].id === choice) return opts[i];
    return opts[0];
  }

  function applyRefuse(gross, refOpt, basis) {
    var pct = refOpt ? refOpt.pct : 0;
    var g = gross * (1 - pct / 100);
    if (pct > 0) basis.push(refOpt.label + " を差し引き → 可食部 " + fmt(gross) + " × " + fmt(1 - pct / 100, 3) + " = " + fmt(g) + " g");
    else basis.push("廃棄率 0%（" + (refOpt ? refOpt.label : "") + "）→ 可食部 " + fmt(g) + " g");
    return { status: "ok", grams: g, basis: basis, refusePct: pct, refuseId: refOpt && refOpt.id };
  }

  function srcNames(lex, ids) {
    var srcs = (lex.measures && lex.measures.sources) || {};
    return (ids || []).map(function (id) { return srcs[id] ? srcs[id].publisher : id; }).join("・");
  }

  /* ---------- 栄養計算 ---------- */

  /** 1食品・可食部 g の栄養量。[{n, est, tr, missing}] */
  function nutrientsFor(food, grams) {
    return food.v.map(function (raw) {
      var iv = interpretValue(raw);
      return { n: iv.n == null ? null : iv.n * grams / 100, est: !!iv.est, tr: !!iv.tr, missing: !!iv.missing };
    });
  }

  /** 合計。rows: [{food, grams}] → [{sum, missing: 件数, est: 件数}] */
  function sumNutrients(rows, nNutrients) {
    var tot = [];
    for (var i = 0; i < nNutrients; i++) tot.push({ sum: 0, missing: 0, est: 0 });
    rows.forEach(function (r) {
      var ns = nutrientsFor(r.food, r.grams);
      ns.forEach(function (x, i) {
        if (x.missing) tot[i].missing++;
        else { tot[i].sum += x.n; if (x.est) tot[i].est++; }
      });
    });
    return tot;
  }

  return {
    normalize: normalize,
    toHiragana: toHiragana,
    searchKey: searchKey,
    kanjiToNumber: kanjiToNumber,
    convertKanjiNumerals: convertKanjiNumerals,
    parseQuantity: parseQuantity,
    parseLine: parseLine,
    parseRecipe: parseRecipe,
    detectServings: detectServings,
    buildIndex: buildIndex,
    findAlias: findAlias,
    searchFoods: searchFoods,
    candidatesFor: candidatesFor,
    interpretValue: interpretValue,
    refuseOptions: refuseOptions,
    autoRefuse: autoRefuse,
    resolveGrams: resolveGrams,
    nutrientsFor: nutrientsFor,
    sumNutrients: sumNutrients,
    fmt: fmt
  };
});
