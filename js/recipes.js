/*
 * recipes.js — サンプルレシピ（入力例）3種。
 * 分量は一般的な家庭料理の範囲で書いた「例」で、特定のレシピ本・サイトの値ではない。
 * 栄養値はここには書かず、すべて成分表（foods.json）から計算する。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RECIPES = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function R(id, title, lines) { return { id: id, title: title, text: lines.join("\n") }; }
  return [
    R("sanma", "さんまの塩焼きとみそ汁", [
      "材料（2人分）", "【さんまの塩焼き】", "さんま 2匹", "塩 少々", "大根 5cm", "醤油 小さじ1", "",
      "【みそ汁】", "豆腐 半丁", "玉ねぎ1/2個", "みそ 大さじ1と1/2", "水 400ml", "",
      "ごはん 300g", "卵 2個（120g）", "砂糖 大さじ二", "サラダ油 適量"
    ]),
    R("tonjiru", "豚汁（4人分）", [
      "材料（4人分）", "豚バラ肉 150g", "大根 200g", "にんじん 80g", "ごぼう 60g", "木綿豆腐 150g", "長ねぎ 50g",
      "水 800ml", "和風だし 小さじ1", "みそ 大さじ3", "ごま油 小さじ2", "七味唐辛子 お好みで"
    ]),
    R("teriyaki", "鶏の照り焼き定食", [
      "材料（2人分）", "【鶏の照り焼き】", "鶏もも肉 250g", "片栗粉 大さじ1", "サラダ油 小さじ2", "醤油 大さじ1と1/2",
      "みりん 大さじ1と1/2", "砂糖 小さじ2", "しょうが 5g", "", "【つけあわせ】", "キャベツ 100g", "ごはん 300g"
    ])
  ];
});
