/* app.js — 画面の組み立て。計算本体は recipe-core.js */
(function () {
  "use strict";
  var C = window.RecipeCore;
  var LS_TEXT = "recipe-eiyou:text";
  var LS_SERV = "recipe-eiyou:servings";
  var LS_WEIGHTS = "recipe-eiyou:weights";
  var LS_CHOICE = "recipe-eiyou:choices";
  var LS_THEME = "recipe-eiyou:theme";

  var MAIN = [
    { id: "ENERC_KCAL", label: "エネルギー", d: 0 },
    { id: "PROT-", label: "たんぱく質", d: 1 },
    { id: "FAT-", label: "脂質", d: 1 },
    { id: "CHOCDF-", label: "炭水化物", d: 1 },
    { id: "FIB-", label: "食物繊維総量", d: 1 },
    { id: "NACL_EQ", label: "食塩相当量", d: 1 }
  ];

  /* 目標量：厚生労働省「日本人の食事摂取基準（2025年版）」（成人・1日あたり）。出典は index.html の「計算のしかた・出典」に記載 */
  var DRI = {
    salt: [{ who: "女性", lt: 6.5 }, { who: "男性", lt: 7.5 }],
    pfc: {
      P: { lo: 13, hi: 20, mark: "※" },
      F: { lo: 20, hi: 30 },
      C: { lo: 50, hi: 65 }
    },
    atwater: { P: 4, F: 9, C: 4 }
  };

  /* サンプル（入力例。重さや数値のデータではなく、ふつうのレシピの書き方の例）。本体は js/recipes.js */
  var RECIPES = window.RECIPES || [];
  var SAMPLES = {};
  RECIPES.forEach(function (r) { SAMPLES[r.id] = r.text; });
  var SAMPLE = SAMPLES.sanma;

  var state = {
    foodsData: null, lexicon: null, index: null, nutrients: [],
    weights: loadJSON(LS_WEIGHTS, {}),
    choices: loadJSON(LS_CHOICE, {}), // key -> {code, refuse, gross, manual}
    lastRows: [],
    openDetails: {}
  };

  var el = function (id) { return document.getElementById(id); };
  var $text = el("recipe"), $serv = el("servings"), $status = el("status");
  var SVGNS = "http://www.w3.org/2000/svg";

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても計算は続ける */ } }
  function loadJSON(k, d) { try { var v = JSON.parse(lsGet(k)); return v == null ? d : v; } catch (e) { return d; } }
  function saveJSON(k, v) { lsSet(k, JSON.stringify(v)); }

  function h(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null) return;
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function s(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  function nIdx(id) { for (var i = 0; i < state.nutrients.length; i++) if (state.nutrients[i].id === id) return i; return -1; }
  function shortName(n) { return n.replace(/[＜（［][^＞）］]*[＞）］]　?/g, "").replace(/　/g, " ").trim(); }
  function lineKey(item) { return C.searchKey(item.name) + "|" + C.normalize(item.qtyText || ""); }
  function weightKey(code, unit) { return code + "|" + unit; }
  function f(n, d) { var t = C.fmt(n, d); return /^-?\d+(\.\d+)?$/.test(t) ? Number(t).toLocaleString("ja-JP", { maximumFractionDigits: d == null ? 1 : d }) : t; }
  function pct(n) { return n >= 10 ? Math.round(n) + "%" : (Math.round(n * 10) / 10) + "%"; }

  /* ---------- ツールチップ ---------- */

  var $tip = el("tooltip");
  function tipContent(parts) {
    $tip.textContent = "";
    parts.forEach(function (p) { if (p) $tip.appendChild(p); });
  }
  function tipShowAt(x, y) {
    $tip.hidden = false;
    var w = $tip.offsetWidth, hh = $tip.offsetHeight;
    var vw = document.documentElement.clientWidth, vh = window.innerHeight;
    var left = Math.min(Math.max(8, x + 14), vw - w - 8);
    var top = y - hh - 12;
    if (top < 8) top = y + 18;
    if (top + hh > vh - 8) top = vh - hh - 8;
    $tip.style.left = left + "px";
    $tip.style.top = top + "px";
  }
  function tipHide() { $tip.hidden = true; }
  /** node に hover/focus のツールチップを付ける。build は表示する要素の配列を返す */
  function attachTip(node, build) {
    node.addEventListener("pointerenter", function () { tipContent(build()); });
    node.addEventListener("pointermove", function (e) { if ($tip.hidden) tipContent(build()); tipShowAt(e.clientX, e.clientY); });
    node.addEventListener("pointerleave", tipHide);
    node.addEventListener("focus", function () { tipContent(build()); var r = node.getBoundingClientRect(); tipShowAt(r.left + r.width / 2 - 14, r.top); });
    node.addEventListener("blur", tipHide);
  }
  function tipLines(value, label, sub, color) {
    return [
      h("span", { class: "tv", text: value }),
      h("span", null, [color ? h("span", { class: "tk", style: "background:" + color }) : null, label]),
      sub ? h("span", { class: "ts", text: sub, style: "display:block" }) : null
    ];
  }
  window.addEventListener("scroll", tipHide, { passive: true });

  /* ---------- 読み込み ---------- */

  function init() {
    var saved = lsGet(LS_TEXT);
    $text.value = saved != null ? saved : SAMPLE;
    var sv = parseInt(lsGet(LS_SERV), 10);
    if (sv > 0) $serv.value = sv;
    initTheme();
    buildSampleChips();
    Promise.all([fetch("data/foods.json"), fetch("data/lexicon.json")])
      .then(function (rs) {
        rs.forEach(function (r) { if (!r.ok) throw new Error(r.url + " " + r.status); });
        return Promise.all(rs.map(function (r) { return r.json(); }));
      })
      .then(function (d) {
        state.foodsData = d[0]; state.lexicon = d[1];
        state.nutrients = d[0].nutrients;
        state.index = C.buildIndex(d[0], d[1]);
        $status.textContent = "";
        el("credit").textContent = "出典：" + d[0].meta.credit + "（" + d[0].meta.sourcePage + "、データ更新日 " + d[0].meta.sourceUpdated + "）。本ツールは文部科学省が作成したものではありません。計量表の重量値は那覇市保健所・郡山市保健所の公開資料、計量単位の定義は同資料と古賀市「コガ COOKING NOTE」によります。";
        bind();
        markSample();
        recalc(true);
      })
      .catch(function (e) {
        $status.className = "status wrap-status error";
        $status.textContent = "データを読み込めませんでした（" + e.message + "）。ファイルを直接開いた場合は、site フォルダで「python3 -m http.server」を実行し http://localhost:8000/ を開いてください。";
      });
  }

  function initTheme() {
    var btn = el("btn-theme");
    var names = { auto: "表示: 自動", light: "表示: 明るい", dark: "表示: 暗い" };
    var cur = document.documentElement.getAttribute("data-theme") || "auto";
    btn.textContent = names[cur];
    btn.addEventListener("click", function () {
      cur = cur === "auto" ? "light" : cur === "light" ? "dark" : "auto";
      if (cur === "auto") document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", cur);
      lsSet(LS_THEME, cur);
      btn.textContent = names[cur];
    });
  }

  var timer = null;
  var servTouched = false;
  var lastDetected = null;

  function buildSampleChips() {
    var box = el("sample-chips");
    if (!box) return;
    box.textContent = "";
    RECIPES.forEach(function (r) {
      box.appendChild(h("button", { type: "button", class: "chip", id: r.id === "sanma" ? "btn-sample" : null, "data-sample": r.id, text: r.title }));
    });
  }

  function markSample() {
    var chips = document.querySelectorAll("[data-sample]");
    for (var i = 0; i < chips.length; i++) chips[i].setAttribute("aria-pressed", SAMPLES[chips[i].getAttribute("data-sample")] === $text.value ? "true" : "false");
  }

  function setServ(v) {
    v = Math.max(1, Math.min(100, Math.round(v) || 1));
    $serv.value = v; servTouched = true; recalc(false);
  }

  function bind() {
    $text.addEventListener("input", function () { markSample(); clearTimeout(timer); timer = setTimeout(function () { recalc(true); }, 250); });
    $serv.addEventListener("input", function () { recalc(false); });
    $serv.addEventListener("change", function () { servTouched = true; });
    el("serv-minus").addEventListener("click", function () { setServ((parseFloat($serv.value) || 1) - 1); });
    el("serv-plus").addEventListener("click", function () { setServ((parseFloat($serv.value) || 1) + 1); });
    var chips = document.querySelectorAll("[data-sample]");
    for (var i = 0; i < chips.length; i++) chips[i].addEventListener("click", function (e) {
      $text.value = SAMPLES[e.currentTarget.getAttribute("data-sample")];
      servTouched = false; lastDetected = null; state.openDetails = {};
      markSample(); recalc(true);
    });
    el("btn-clear").addEventListener("click", function () { $text.value = ""; markSample(); recalc(true); $text.focus(); });
    el("btn-csv").addEventListener("click", downloadCSV);
    el("btn-copy").addEventListener("click", copyCSV);
    var rt = null;
    window.addEventListener("resize", function () { clearTimeout(rt); rt = setTimeout(function () { fitSegLabels(document); }, 150); });
  }

  /* ---------- 計算と描画 ---------- */

  function recalc(textChanged) {
    lsSet(LS_TEXT, $text.value);
    var parsed = C.parseRecipe($text.value);
    if (textChanged && parsed.servings && parsed.servings.servings !== lastDetected) {
      lastDetected = parsed.servings.servings;
      if (!servTouched) $serv.value = parsed.servings.servings;
    }
    el("servings-note").textContent = parsed.servings ? "レシピの「" + parsed.servings.servings + "人分」を読み取りました" : "";
    lsSet(LS_SERV, $serv.value);

    var $lines = el("lines");
    $lines.textContent = "";
    var rows = [];
    parsed.items.forEach(function (item) {
      if (item.kind === "header") {
        if (item.servings && !item.isSteps && /^材料/.test(C.normalize(item.raw).replace(/^[【\[（(]/, ""))) return;
        $lines.appendChild(h("div", { class: "line is-header group-h", text: C.normalize(item.raw).replace(/^[【\[]|[】\]]$/g, "") }));
        return;
      }
      if (item.kind === "step") return;
      var r = computeItem(item);
      rows.push(r);
      $lines.appendChild(renderItem(r));
    });
    if (rows.length) $lines.insertBefore(colHead(), $lines.firstChild);
    state.lastRows = rows;
    el("lines-wrap").hidden = !rows.length;
    var nWarn = rows.filter(function (r) { return r.cls === "is-warn"; }).length;
    el("lines-count").textContent = rows.length ? rows.length + "行" + (nWarn ? "（うち " + nWarn + "行は入力が必要）" : "") : "";
    renderSummary(rows);
    el("csv-text").hidden = true;
    el("export-msg").textContent = "";
  }

  function colHead() {
    return h("div", { class: "line-head-cols", "aria-hidden": "true" }, [
      h("span", { text: "材料" }), h("span", { text: "成分表の食品" }), h("span", { text: "可食部" }), h("span", { text: "エネルギー" }), h("span", { text: "食塩" }), h("span")
    ]);
  }

  function computeItem(item) {
    var key = lineKey(item);
    var ch = state.choices[key] || {};
    var cands = C.candidatesFor(state.index, item.name, 15);
    var code = ch.code && state.index.byCode[ch.code] ? ch.code : (cands[0] && cands[0].code);
    if (code && !cands.some(function (c) { return c.code === code; })) {
      cands.unshift({ code: code, name: state.index.byCode[code].n, how: "選択" });
    }
    var food = code ? state.index.byCode[code] : null;
    var unit = item.qty ? (item.qty.unit || "個") : "";
    var uw = food ? state.weights[weightKey(food.c, unit)] : null;
    var res = C.resolveGrams(item, food, {
      lexicon: state.lexicon,
      userWeight: uw,
      refuse: ch.refuse || "auto",
      massIsGross: !!ch.gross,
      manualGrams: ch.manual
    });
    var r = { item: item, key: key, cands: cands, food: food, res: res, unit: unit, choice: ch };
    var st = res.status;
    r.excluded = ch.code === "__none";
    r.cls = r.excluded ? "is-skip" : st === "ok" ? "is-ok" : (st === "vague" || st === "water") ? "is-skip" : "is-warn";
    return r;
  }

  function setChoice(key, patch) {
    var c = state.choices[key] || {};
    Object.keys(patch).forEach(function (k) { if (patch[k] === null) delete c[k]; else c[k] = patch[k]; });
    state.choices[key] = c;
    state.openDetails[key] = true;
    saveJSON(LS_CHOICE, state.choices);
    recalc(false);
  }

  function qtyLabel(q, item) {
    if (!q) return "分量なし";
    if (q.unitType === "vague") return q.unit;
    var a = q.range ? q.range[0] + "〜" + q.range[1] + "（平均 " + C.fmt(q.amount, 3) + " で計算）" : C.fmt(q.amount, 3);
    var u = q.unit || "（単位なし→個数として扱う）";
    var t = (q.unitType === "volume" && /^(大さじ|小さじ|カップ)$/.test(q.unit)) ? q.unit + " " + a : a + " " + u;
    if (q.modifier) t += "（" + q.modifier + "は計算に反映しません）";
    if (item.explicit) t += "／括弧内: " + item.explicit.text;
    return t;
  }

  var BADGE = { ok: "計算済み", vague: "計算対象外", water: "計算対象外", nofood: "食品未選択", needweight: "重さが必要", noqty: "分量なし" };

  function renderItem(r) {
    var item = r.item, res = r.res, status = res.status, food = r.food;
    var inc = included(r);
    var art = h("article", { class: "line " + r.cls });
    var ns = inc ? C.nutrientsFor(food, res.grams) : null;
    var iE = nIdx("ENERC_KCAL"), iS = nIdx("NACL_EQ");

    // 1行目：材料・食品・可食部・エネルギー・食塩
    var badgeText = r.excluded ? "除外" : (BADGE[status] || status);
    var badge = h("span", { class: "badge " + (status === "ok" && !r.excluded ? "ok sr-only" : r.cls === "is-skip" ? "skip" : "warn"), text: badgeText });
    var foodLabel = food && !r.excluded && status !== "water" && status !== "vague" ? shortName(food.n) : (status === "water" ? "水（成分表に収載なし）" : status === "vague" ? "量が決まらない（" + (item.qty ? item.qty.unit : "") + "）" : r.excluded ? "計算に入れない" : "見つかりません");
    var main = h("div", { class: "line-main" }, [
      h("div", { class: "line-raw", text: C.normalize(item.raw) + (item.each ? "（" + item.name + "）" : "") }),
      h("div", { class: "line-food-name" }, [badge, status === "ok" && !r.excluded ? null : " ", foodLabel]),
      h("div", { class: "num g" + (inc ? "" : " dim"), "data-k": "可食部 " }, inc ? [f(res.grams, 1), h("small", { text: "g" })] : ["—"]),
      h("div", { class: "num" + (inc ? "" : " dim"), "data-k": "" }, inc ? [ns[iE].missing ? "未測定" : f(ns[iE].n, 0), h("small", { text: "kcal" })] : ["—"]),
      h("div", { class: "num" + (inc ? "" : " dim"), "data-k": "食塩 " }, inc ? [ns[iS].missing ? "未測定" : f(ns[iS].n, 1), h("small", { text: "g" })] : ["—"])
    ]);

    // 入力が必要な行は、入力欄を折りたたまずに出す
    var q0 = item.qty;
    var isPiece = q0 && (q0.unitType === "piece" || q0.unitType === "count");
    var needPieceWeight = food && !r.excluded && isPiece && !(item.explicit && item.explicit.grams != null);
    var weightCtrl = needPieceWeight ? pieceWeightCtrl(r) : null;

    // 折りたたみ：食品の選び直し・換算の根拠
    var det = h("details", { class: "line-detail" });
    if (state.openDetails[r.key] || (r.cls === "is-warn" && status !== "needweight") || (status === "needweight" && !weightCtrl)) det.open = true;
    det.addEventListener("toggle", function () { if (det.open) state.openDetails[r.key] = true; else delete state.openDetails[r.key]; });
    main.appendChild(h("span", { class: "chev", "aria-hidden": "true" }));
    var sum = h("summary", { class: "line-sum", title: inc ? "換算の根拠・食品の選び直し" : "食品の選び直し・重さの指定" }, [main, h("span", { class: "sr-only", text: inc ? "（開くと換算の根拠と食品の選び直し）" : "（開くと食品の選び直しと重さの指定）" })]);
    det.appendChild(sum);
    var body = h("div", { class: "line-body" });
    det.appendChild(body);
    art.appendChild(det);
    if (weightCtrl && status === "needweight") art.appendChild(h("div", { class: "line-action" }, [weightCtrl]));

    body.appendChild(h("div", { class: "parse", text: "読み取り: 食品名「" + item.name + "」／数量 " + qtyLabel(item.qty, item) + (item.notes.length ? "／メモ: " + item.notes.join("、") : "") }));

    // 食品の選択
    var sel = h("select", { class: "food-select" });
    if (!r.cands.length) sel.appendChild(h("option", { value: "", text: "（候補なし：下で探してください）" }));
    r.cands.forEach(function (c) {
      var o = h("option", { value: c.code, text: c.code + " " + shortName(c.name) + (c.how && c.how !== "検索" ? "　〔" + c.how + "〕" : "") });
      if (food && c.code === food.c) o.selected = true;
      sel.appendChild(o);
    });
    sel.appendChild(h("option", { value: "__none", text: "（この行は計算に入れない）" }));
    if (r.excluded) sel.value = "__none";
    sel.addEventListener("change", function () { setChoice(r.key, { code: sel.value, refuse: null }); });
    body.appendChild(h("label", { class: "lbl" }, ["成分表の食品", sel]));

    // 食品検索
    var q = h("input", { type: "search", class: "food-q", placeholder: "例: さんま 焼き／木綿豆腐／こいくち", enterkeyhint: "search", "aria-label": "成分表の食品を探す" });
    var ul = h("ul", { class: "food-results" });
    q.addEventListener("input", function () {
      ul.textContent = "";
      C.searchFoods(state.index, q.value, 30).forEach(function (hit) {
        ul.appendChild(h("li", null, [h("button", { type: "button", onclick: function () { setChoice(r.key, { code: hit.code, refuse: null }); } },
          [h("span", { class: "code", text: hit.code }), shortName(hit.name)])]));
      });
    });
    body.appendChild(h("details", { class: "food-search" }, [h("summary", { text: "ほかの食品を探す" }), q, ul]));

    // 重さ・廃棄率
    if (food && !r.excluded) {
      if (weightCtrl && status !== "needweight") body.appendChild(weightCtrl);
      var grossLike = isPiece || (item.explicit && item.explicit.grams != null && !item.explicit.net) || (q0 && q0.unitType === "mass" && r.choice.gross);
      if (q0 && q0.unitType === "mass" && !(item.explicit && item.explicit.grams != null)) {
        var cb = h("input", { type: "checkbox" });
        cb.checked = !!r.choice.gross;
        cb.addEventListener("change", function () { setChoice(r.key, { gross: cb.checked || null }); });
        body.appendChild(h("label", { class: "ctrl" }, [cb, "入力の重さは皮・骨などの廃棄部分を含む（廃棄率を差し引く）"]));
      }
      if (grossLike) {
        var opts = C.refuseOptions(food);
        var rs = h("select", { "aria-label": "廃棄率" });
        var auto = C.autoRefuse(food, q0 ? q0.unit : "");
        rs.appendChild(h("option", { value: "auto", text: "自動: " + auto.label }));
        opts.forEach(function (o) { rs.appendChild(h("option", { value: o.id, text: o.label })); });
        rs.value = r.choice.refuse || "auto";
        rs.addEventListener("change", function () { setChoice(r.key, { refuse: rs.value }); });
        body.appendChild(h("label", { class: "lbl" }, ["廃棄率", rs]));
      }
      if (status !== "vague" && status !== "water") {
        var man = h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: r.choice.manual != null ? r.choice.manual : "", placeholder: "未指定", "aria-label": "可食部の重さを直接指定" });
        man.addEventListener("change", function () { var v = parseFloat(man.value); setChoice(r.key, { manual: isFinite(v) && v >= 0 ? v : null }); });
        var md = h("details", { class: "fold" }, [
          h("summary", { text: "可食部の重さを直接指定する" }),
          h("div", { class: "mctrl", style: "margin-top:6px" }, ["この行の可食部", man, "g", h("span", { class: "hint", text: "入れると上の換算より優先します" })])
        ]);
        if ((status === "needweight" && !weightCtrl) || status === "noqty" || r.choice.manual != null) md.open = true;
        body.appendChild(md);
      }
    }

    // 根拠
    var ol = h("ol", { class: "basis" });
    var basis = r.excluded ? ["この行は計算に入れない設定です"] : res.basis;
    basis.forEach(function (b) { ol.appendChild(h("li", { text: b })); });
    body.appendChild(h("div", { class: "basis-box" }, [h("div", { class: "t", text: "換算の根拠" }), ol]));
    if (food && !r.excluded && food.b) {
      body.appendChild(h("details", { class: "remarks" }, [h("summary", { text: "成分表の備考（" + food.c + "）" }), h("pre", { text: food.b })]));
    }

    // 栄養（この行）
    var nut = h("div", { class: "mini-nutr line-nutr" });
    if (inc) {
      nut.appendChild(h("span", null, ["可食部 ", h("b", { text: C.fmt(res.grams) }), " g"]));
      MAIN.forEach(function (m) {
        var i = nIdx(m.id), x = ns[i];
        nut.appendChild(h("span", null, [m.label + " ", h("b", { text: x.missing ? "未測定" : C.fmt(x.n, m.d) + (x.est ? "*" : "") }), " " + state.nutrients[i].unit]));
      });
      body.appendChild(h("div", { class: "basis-box" }, [h("div", { class: "t", text: "この材料の栄養（全体）" }), nut]));
    }
    return art;
  }

  function pieceWeightCtrl(r) {
    var food = r.food;
    var w = state.weights[weightKey(food.c, r.unit)];
    var inp = h("input", { type: "number", min: "0", step: "any", inputmode: "decimal", value: w != null ? w : "", placeholder: "重さ", "aria-label": "1" + r.unit + "あたりの重さ（g）" });
    inp.addEventListener("change", function () {
      var v = parseFloat(inp.value);
      if (isFinite(v) && v > 0) state.weights[weightKey(food.c, r.unit)] = v; else delete state.weights[weightKey(food.c, r.unit)];
      saveJSON(LS_WEIGHTS, state.weights); recalc(false);
    });
    return h("div", { class: "ctrl" + (w == null ? " need" : "") }, [
      "1" + r.unit + "の重さ（丸ごと）", inp, "g",
      h("span", { class: "hint", text: w == null ? "目安重量は収録していないので、量って入れてください（この端末に保存）" : "この端末に保存済み。廃棄率は成分表の値で差し引きます" })
    ]);
  }

  function included(r) { return r.res.status === "ok" && r.food && !r.excluded; }

  /* ---------- 結果のまとめ ---------- */

  function renderSummary(rows) {
    var $s = el("summary");
    var inc = rows.filter(included);
    if (!rows.length) { $s.hidden = true; return; }
    $s.hidden = false;
    var serv = Math.max(1, parseFloat($serv.value) || 1);
    var tot = C.sumNutrients(inc.map(function (r) { return { food: r.food, grams: r.res.grams }; }), state.nutrients.length);
    var per = function (id) { var i = nIdx(id); return { v: tot[i].sum / serv, all: tot[i].sum, t: tot[i], unit: state.nutrients[i].unit }; };

    renderLabel(per, serv, inc.length);
    renderPFC(per);
    renderAmounts(per, serv);
    renderSalt(per("NACL_EQ"));
    renderContrib(inc);
    renderDetailTable(tot, serv);

    // 補足
    var skipped = rows.filter(function (r) { return !included(r); });
    var counts = {};
    skipped.forEach(function (r) { var k = r.excluded ? "除外" : r.res.status; counts[k] = (counts[k] || 0) + 1; });
    var parts = [];
    var label = { vague: "少々・適量など", water: "水", nofood: "食品未選択", needweight: "重さ未入力", noqty: "分量なし", "除外": "手動で除外" };
    Object.keys(counts).forEach(function (k) { parts.push((label[k] || k) + " " + counts[k] + "行"); });
    var fl = el("sum-flags");
    fl.textContent = "";
    var needN = (counts.needweight || 0) + (counts.nofood || 0) + (counts.noqty || 0);
    if (needN) {
      fl.appendChild(h("p", { class: "pill warn", style: "font-size:.84rem;padding:4px 12px;border-radius:8px;white-space:normal" }, [warnIcon(), needN + "行が計算に入っていません。下の「材料ごとの計算」で重さや食品を指定すると加わります。"]));
    }
    el("summary-note").textContent = "計算に入れた材料 " + inc.length + "行" + (parts.length ? "／入れていない材料: " + parts.join("、") : "") +
      "。※は未測定（-）の成分を含む食品があることを示します。行ごとの値の * は成分表の推計値（括弧付きの値）です。";
  }

  function missFlag(t) {
    return t.missing ? h("span", { class: "flag", title: "未測定（-）の食品が" + t.missing + "件あり、その分は合計に含みません", text: "※" }) : null;
  }

  function renderLabel(per, serv, nInc) {
    var box = el("label-box");
    box.textContent = "";
    var e = per("ENERC_KCAL");
    box.appendChild(h("div", { class: "lb-title" }, ["栄養成分表示", h("span", { text: "1人分あたり（" + serv + "人分で割った値）" })]));
    box.appendChild(h("div", { class: "lb-energy" }, [h("span", { class: "k", text: "エネルギー" }), h("span", { class: "v" }, [f(e.v, 0), h("small", { text: "kcal" }), missFlag(e.t)])]));
    [["PROT-", "たんぱく質", 1], ["FAT-", "脂質", 1], ["CHOCDF-", "炭水化物", 1], ["FIB-", "食物繊維", 1, true], ["NACL_EQ", "食塩相当量", 1]].forEach(function (d) {
      var p = per(d[0]);
      box.appendChild(h("div", { class: "lb-row" + (d[3] ? " sub" : "") }, [h("span", { class: "k", text: (d[3] ? "─ " : "") + d[1] }), h("span", { class: "v" }, [f(p.v, d[2]) + " " + p.unit, missFlag(p.t)])]));
    });
    var s = per("NACL_EQ");
    box.appendChild(h("div", { class: "lb-foot", text: serv > 1 ? "全体（" + serv + "人分）では " + f(e.all, 0) + " kcal、食塩相当量 " + f(s.all, 1) + " g" : "計算に入れた材料 " + nInc + "行の合計" }));
  }

  function checkIcon() { var v = s("svg", { viewBox: "0 0 12 12", "aria-hidden": "true" }); v.appendChild(s("path", { d: "M2 6.5 5 9.5 10 3", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" })); return v; }
  function warnIcon() { var v = s("svg", { viewBox: "0 0 12 12", "aria-hidden": "true", style: "width:12px;height:12px;flex:none" }); v.appendChild(s("path", { d: "M6 1.5 11 10.5H1Z", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linejoin": "round" })); v.appendChild(s("path", { d: "M6 5v2.5M6 9v.01", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round" })); return v; }

  function renderPFC(per) {
    var box = el("pfc");
    box.textContent = "";
    box.appendChild(h("h3", null, ["PFCバランス", h("span", { class: "sub-h", text: "エネルギー比（1日の目標量と比べた参考）" })]));
    var P = per("PROT-").v * DRI.atwater.P, F = per("FAT-").v * DRI.atwater.F, Cc = per("CHOCDF-").v * DRI.atwater.C;
    var sum = P + F + Cc;
    if (!(sum > 0)) { box.appendChild(h("p", { class: "empty-chart", text: "計算に入った材料がまだありません。" })); return; }
    var parts = [
      { k: "P", name: "たんぱく質", kcal: P, g: per("PROT-").v, color: "var(--s1)" },
      { k: "F", name: "脂質", kcal: F, g: per("FAT-").v, color: "var(--s2)" },
      { k: "C", name: "炭水化物", kcal: Cc, g: per("CHOCDF-").v, color: "var(--s3)" }
    ];
    parts.forEach(function (p) { p.pct = p.kcal / sum * 100; });

    // ドーナツ
    var size = 150, cx = 75, cy = 75, R = 62, W = 22;
    var svg = s("svg", { class: "donut", viewBox: "0 0 150 150", role: "img", "aria-label": "PFCバランス: " + parts.map(function (p) { return p.name + " " + Math.round(p.pct) + "%"; }).join("、") });
    var gap = 2 / R; // 2px のすき間（ラジアン）
    var a0 = -Math.PI / 2;
    var nonzero = parts.filter(function (p) { return p.pct > 0; }).length;
    parts.forEach(function (p) {
      var sweep = p.pct / 100 * Math.PI * 2;
      if (sweep <= 0) return;
      var g = nonzero > 1 ? gap : 0;
      var st = a0 + g / 2, en = a0 + sweep - g / 2;
      a0 += sweep;
      var node;
      if (nonzero === 1) node = s("circle", { cx: cx, cy: cy, r: R - W / 2, fill: "none", "stroke-width": W });
      else {
        var r1 = R, r2 = R - W, large = en - st > Math.PI ? 1 : 0;
        var pt = function (r, a) { return (cx + r * Math.cos(a)).toFixed(2) + " " + (cy + r * Math.sin(a)).toFixed(2); };
        node = s("path", { d: "M" + pt(r1, st) + " A" + r1 + " " + r1 + " 0 " + large + " 1 " + pt(r1, en) + " L" + pt(r2, en) + " A" + r2 + " " + r2 + " 0 " + large + " 0 " + pt(r2, st) + "Z" });
      }
      node.setAttribute("class", "seg");
      node.setAttribute("style", nonzero === 1 ? "stroke:" + p.color : "fill:" + p.color);
      node.setAttribute("tabindex", "0");
      node.setAttribute("aria-label", p.name + " " + Math.round(p.pct) + "%");
      attachTip(node, function () { return tipLines(Math.round(p.pct) + "%", p.name, f(p.g, 1) + " g × " + DRI.atwater[p.k] + " kcal/g = " + f(p.kcal, 0) + " kcal", p.color); });
      svg.appendChild(node);
    });
    var t1 = s("text", { x: cx, y: cy - 4, "text-anchor": "middle", class: "donut-center" }); t1.textContent = "P+F+C";
    var t2 = s("text", { x: cx, y: cy + 14, "text-anchor": "middle", class: "donut-center-v" }); t2.textContent = f(sum, 0) + " kcal";
    svg.appendChild(t1); svg.appendChild(t2);

    // 凡例＋目標量
    var list = h("ul", { class: "pfc-list" });
    parts.forEach(function (p) {
      var rg = DRI.pfc[p.k];
      var shown = Math.round(p.pct);
      var inRange = shown >= rg.lo && shown <= rg.hi;
      var pill = inRange ? h("span", { class: "pill ok" }, [checkIcon(), "範囲内"]) : h("span", { class: "pill warn" }, [warnIcon(), shown < rg.lo ? "低め" : "高め"]);
      list.appendChild(h("li", null, [
        h("span", { class: "swatch", style: "background:" + p.color }),
        h("span", { class: "name", text: p.name }),
        h("span", { class: "pct", text: shown + "%" }),
        h("span", { class: "range" }, ["目標量 " + rg.lo + "〜" + rg.hi + " %" + (rg.mark || ""), pill])
      ]));
    });
    box.appendChild(h("div", { class: "pfc-body" }, [svg, list]));
    box.appendChild(h("p", { class: "note", style: "margin-top:8px", text: "目標量は成人の1日あたり（厚生労働省「日本人の食事摂取基準（2025年版）」）。※たんぱく質は18〜49歳の値で、50〜64歳は14〜20 %、65歳以上は15〜20 %。" }));
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    var p = Math.pow(10, Math.floor(Math.log10(v)));
    var m = [1, 2, 2.5, 5, 10].find(function (k) { return k * p >= v; });
    return m * p;
  }

  function renderAmounts(per, serv) {
    var box = el("chart-amounts");
    box.textContent = "";
    var items = [["PROT-", "たんぱく質"], ["FAT-", "脂質"], ["CHOCDF-", "炭水化物"], ["FIB-", "食物繊維総量"], ["NACL_EQ", "食塩相当量"]].map(function (d) { var p = per(d[0]); return { name: d[1], v: p.v, all: p.all, t: p.t }; });
    var max = niceMax(Math.max.apply(null, items.map(function (i) { return i.v; })));
    items.forEach(function (it) {
      var row = h("div", { class: "bar-row", tabindex: "0", "aria-label": it.name + " " + f(it.v, 1) + " g" }, [
        h("span", { class: "name", text: it.name }),
        h("div", { class: "bar-track" }, [h("div", { class: "bar-fill", style: "width:" + Math.max(0, it.v / max * 100) + "%" })]),
        h("span", { class: "val" }, [f(it.v, 1), h("small", { text: "g" }), missFlag(it.t)])
      ]);
      attachTip(row, function () { return tipLines(f(it.v, 1) + " g", it.name + "（1人分）", serv > 1 ? "全体 " + f(it.all, 1) + " g ÷ " + serv + "人分" : null, "var(--bar)"); });
      box.appendChild(row);
    });
    var ticks = h("div", { class: "axis" });
    for (var k = 0; k <= 4; k++) {
      var span = h("span", { text: f(max * k / 4, max < 4 ? 1 : 0), style: "left:" + (k * 25) + "%" });
      if (k === 4) span.style.transform = "translateX(-100%)";
      ticks.appendChild(span);
    }
    box.appendChild(h("div", { class: "axis-row", "aria-hidden": "true" }, [h("span"), ticks, h("span")]));
  }

  function renderSalt(p) {
    var box = el("chart-salt");
    box.textContent = "";
    var v = p.v;
    var hi = DRI.salt[DRI.salt.length - 1].lt;
    var max = Math.max(hi * 1.4, v * 1.12);
    var track = h("div", { class: "salt-track", role: "img", "aria-label": "1人分の食塩相当量 " + f(v, 1) + " g。1日の目標量は男性7.5 g未満、女性6.5 g未満" }, [
      h("div", { class: "salt-fill", style: "width:" + Math.min(100, v / max * 100) + "%" })
    ]);
    DRI.salt.forEach(function (d, i) {
      track.appendChild(h("div", { class: "salt-tick" + (i === 0 ? " left" : ""), style: "left:" + (d.lt / max * 100) + "%" }, [h("span", { text: d.who + " " + d.lt + " g未満" })]));
    });
    attachTip(track, function () { return tipLines(f(v, 1) + " g", "食塩相当量（1人分）", "1日の目標量：男性 7.5 g未満・女性 6.5 g未満", "var(--bar)"); });
    track.setAttribute("tabindex", "0");
    box.appendChild(h("div", { class: "salt-meter" }, [track]));
    var txt = h("p", { class: "salt-text" }, [
      "1人分 ", h("b", { text: f(v, 1) + " g" }), missFlag(p.t),
      " は、1日の目標量の約 " + Math.round(v / 7.5 * 100) + " %（男性 7.5 g未満）、約 " + Math.round(v / 6.5 * 100) + " %（女性 6.5 g未満）です。"
    ]);
    box.appendChild(txt);
    box.appendChild(h("p", { class: "note", text: "目標量は厚生労働省「日本人の食事摂取基準（2025年版）」の成人1日あたりの値。高血圧・慢性腎臓病の重症化予防では男女とも 6.0 g未満とされています。" }));
  }

  var SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)", "var(--s6)", "var(--s7)"];
  var DARK_INK = { "var(--s4)": true };

  function renderContrib(inc) {
    var box = el("chart-contrib");
    box.textContent = "";
    if (!inc.length) { box.appendChild(h("p", { class: "empty-chart", text: "計算に入った材料がまだありません。" })); return; }
    var iE = nIdx("ENERC_KCAL"), iS = nIdx("NACL_EQ");
    var ents = inc.map(function (r, i) {
      var ns = C.nutrientsFor(r.food, r.res.grams);
      return { i: i, name: r.item.name, food: shortName(r.food.n), grams: r.res.grams, e: ns[iE].missing ? 0 : ns[iE].n, s: ns[iS].missing ? 0 : ns[iS].n };
    });
    var totE = ents.reduce(function (a, x) { return a + x.e; }, 0), totS = ents.reduce(function (a, x) { return a + x.s; }, 0);
    ents.forEach(function (x) { x.eSh = totE > 0 ? x.e / totE : 0; x.sSh = totS > 0 ? x.s / totS : 0; });
    // 名前を出すのは最大7件（エネルギー・食塩のどちらかで大きい順）。残りは「その他」
    var named = ents.slice();
    if (ents.length > 8) {
      named = ents.slice().sort(function (a, b) { return Math.max(b.eSh, b.sSh) - Math.max(a.eSh, a.sSh); }).slice(0, 7);
      named.sort(function (a, b) { return a.i - b.i; });
    }
    named.forEach(function (x, k) { x.color = SERIES[k]; });
    var others = ents.filter(function (x) { return !x.color; });

    function bar(key, total, unit, d, title) {
      var parts = named.map(function (x) { return { name: x.name, sub: x.food, v: x[key], color: x.color, dark: DARK_INK[x.color] }; })
        .filter(function (p) { return p.v > 0; }).sort(function (a, b) { return b.v - a.v; });
      var ov = others.reduce(function (a, x) { return a + x[key]; }, 0);
      if (ov > 0) parts.push({ name: "その他（" + others.length + "品）", sub: others.map(function (x) { return x.name; }).join("、"), v: ov, color: "var(--s-other)" });
      var seg = h("div", { class: "seg-bar", role: "img", "aria-label": title + "の内訳: " + parts.map(function (p) { return p.name + " " + pct(p.v / total * 100); }).join("、") });
      if (!(total > 0)) seg = h("p", { class: "empty-chart", text: "0（含む材料なし）" });
      else parts.forEach(function (p) {
        var share = p.v / total * 100;
        var part = h("div", { class: "part" + (p.dark ? " dark-ink" : ""), tabindex: "0", style: "flex:" + p.v + " 1 0;background:" + p.color, "aria-label": p.name + " " + f(p.v, d) + " " + unit + "（" + pct(share) + "）" }, [h("span", { class: "plbl", text: pct(share) })]);
        attachTip(part, function () { return tipLines(f(p.v, d) + " " + unit + "（" + pct(share) + "）", p.name, p.sub, p.color); });
        seg.appendChild(part);
      });
      return h("div", { class: "contrib-row" }, [h("div", { class: "name" }, [title, h("small", { text: "全体 " + f(total, d) + " " + unit })]), seg]);
    }
    box.appendChild(bar("e", totE, "kcal", 0, "エネルギー"));
    box.appendChild(bar("s", totS, "g", 1, "食塩相当量"));

    var lg = h("ul", { class: "legend", "aria-label": "凡例" });
    named.forEach(function (x) { lg.appendChild(h("li", null, [h("span", { class: "swatch", style: "background:" + x.color }), x.name])); });
    if (others.length) lg.appendChild(h("li", null, [h("span", { class: "swatch", style: "background:var(--s-other)" }), "その他（" + others.length + "品）"]));
    box.appendChild(lg);

    // 表（色に頼らず数値で確認できるように）
    var tb = h("tbody");
    ents.slice().sort(function (a, b) { return b.e - a.e; }).forEach(function (x) {
      tb.appendChild(h("tr", null, [h("td", { text: x.name }), h("td", { text: f(x.grams, 1) + " g" }), h("td", { text: f(x.e, 0) + " kcal" }), h("td", { text: pct(x.eSh * 100) }), h("td", { text: f(x.s, 2) + " g" }), h("td", { text: totS > 0 ? pct(x.sSh * 100) : "—" })]));
    });
    box.appendChild(h("details", { class: "fold", style: "margin-top:10px" }, [
      h("summary", { text: "材料ごとの数値（全体）" }),
      h("div", { class: "table-wrap" }, [h("table", { class: "detail" }, [h("thead", null, [h("tr", null, ["材料", "可食部", "エネルギー", "割合", "食塩相当量", "割合"].map(function (t) { return h("th", { text: t }); }))]), tb])])
    ]));
    requestAnimationFrame(function () { fitSegLabels(box); });
  }

  /** 積み上げ横棒の中の割合ラベル：収まらないものは隠す（値はツールチップと表に残る） */
  function fitSegLabels(root) {
    var parts = root.querySelectorAll(".seg-bar .part");
    for (var i = 0; i < parts.length; i++) {
      var lbl = parts[i].firstChild;
      lbl.classList.remove("hide");
      if (lbl.offsetWidth + 10 > parts[i].clientWidth) lbl.classList.add("hide");
    }
  }

  function renderDetailTable(tot, serv) {
    var det = el("summary-detail");
    det.textContent = "";
    var tb = h("tbody");
    function dg(n, v) { return n.unit === "g" ? 1 : n.unit === "kcal" ? 0 : (n.unit === "mg" || n.unit === "µg") && v < 10 ? 2 : 0; }
    state.nutrients.forEach(function (n, i) {
      var t = tot[i];
      tb.appendChild(h("tr", null, [
        h("td", { text: n.name + (t.missing ? " ※" : "") }),
        h("td", { text: f(t.sum / serv, dg(n, t.sum / serv)) + " " + n.unit }),
        h("td", { text: f(t.sum, dg(n, t.sum)) + " " + n.unit })
      ]));
    });
    det.appendChild(h("table", { class: "detail" }, [h("thead", null, [h("tr", null, [h("th", { text: "成分" }), h("th", { text: "1人分" }), h("th", { text: "全体" })])]), tb]));
  }

  /* ---------- CSV ---------- */

  function csvCell(v) { var t = v == null ? "" : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; }

  function csvText() {
    var rows = state.lastRows;
    var head = ["入力行", "食品番号", "食品名", "可食部(g)", "状態", "換算の根拠"].concat(state.nutrients.map(function (n) { return n.name + "(" + n.unit + ")"; }));
    var lines = [head.map(csvCell).join(",")];
    rows.forEach(function (r) {
      var inc = included(r);
      var ns = inc ? C.nutrientsFor(r.food, r.res.grams) : [];
      lines.push([C.normalize(r.item.raw), r.food ? r.food.c : "", r.food ? r.food.n.replace(/　/g, " ") : "", inc ? C.fmt(r.res.grams) : "", inc ? "計算" : "対象外:" + (r.excluded ? "除外" : r.res.status), r.res.basis.join(" / ")]
        .concat(state.nutrients.map(function (n, i) { return inc ? (ns[i].missing ? "-" : C.fmt(ns[i].n, 3)) : ""; })).map(csvCell).join(","));
    });
    lines.push("");
    lines.push(csvCell("人数," + (parseFloat($serv.value) || 1)));
    lines.push(csvCell(state.foodsData.meta.credit + " " + state.foodsData.meta.sourcePage));
    return lines.join("\r\n");
  }

  function copyCSV() {
    var text = csvText();
    var ta = el("csv-text"), msg = el("export-msg");
    ta.value = text;
    function fallback() {
      ta.hidden = false; ta.focus(); ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      msg.textContent = ok ? "コピーしました。表計算ソフトに貼り付けられます。" : "自動でコピーできませんでした。下の枠の内容を選んでコピーしてください。";
    }
    // iframe の中でクリップボードが許可されていなければ、最初から選択済みの枠を出す
    var allowed = true;
    try { var pp = document.permissionsPolicy || document.featurePolicy; if (pp && pp.allowsFeature) allowed = pp.allowsFeature("clipboard-write"); } catch (e) { allowed = true; }
    if (allowed && navigator.clipboard && navigator.clipboard.writeText) {
      try { navigator.clipboard.writeText(text).then(function () { ta.hidden = true; msg.textContent = "コピーしました。表計算ソフトに貼り付けられます。"; }, fallback); } catch (e) { fallback(); }
    } else fallback();
  }

  function downloadCSV() {
    var msg = el("export-msg");
    try {
      var blob = new Blob(["﻿" + csvText()], { type: "text/csv" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "recipe-eiyou.csv";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      msg.textContent = "保存を始めました。保存できない環境では「CSVをコピー」を使ってください。";
    } catch (e) {
      msg.textContent = "この環境ではファイルを保存できません。「CSVをコピー」を使ってください。";
    }
  }

  init();
})();
