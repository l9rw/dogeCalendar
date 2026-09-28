export type ColorInfo = {
  hex: string;
  name_en: string;
  name_zh: string;
};

export const accentColors: ColorInfo[] = [
  { hex: "#FFA07A", name_en: "Light Salmon", name_zh: "浅鲑红" },
  { hex: "#FF7F50", name_en: "Coral", name_zh: "珊瑚红" },
  { hex: "#FF6347", name_en: "Tomato", name_zh: "番茄红" },
  { hex: "#FF4500", name_en: "Orange Red", name_zh: "橙红色" },
  { hex: "#FF0000", name_en: "Red", name_zh: "红色" },
  { hex: "#DEB887", name_en: "Burlywood", name_zh: "原木色" },
  { hex: "#D2691E", name_en: "Chocolate", name_zh: "巧克力棕" },
  { hex: "#CD853F", name_en: "Peru", name_zh: "秘鲁棕" },
  { hex: "#A0522D", name_en: "Sienna", name_zh: "赭石棕" },
  { hex: "#8B4513", name_en: "Saddle Brown", name_zh: "马鞍棕" },
  { hex: "#00FF00", name_en: "Lime", name_zh: "酸橙色" },
  { hex: "#32CD32", name_en: "Lime Green", name_zh: "酸橙绿" },
  { hex: "#3CB371", name_en: "Medium Sea Green", name_zh: "中海绿" },
  { hex: "#228B22", name_en: "Forest Green", name_zh: "森林绿" },
  { hex: "#006400", name_en: "Dark Green", name_zh: "深绿色" },
  { hex: "#00BFFF", name_en: "Deep Sky Blue", name_zh: "深天蓝色" },
  { hex: "#1E90FF", name_en: "Dodger Blue", name_zh: "道奇蓝" },
  { hex: "#6495ED", name_en: "Cornflower Blue", name_zh: "矢车菊蓝" },
  { hex: "#4169E1", name_en: "Royal Blue", name_zh: "皇家蓝" },
  { hex: "#0000FF", name_en: "Blue", name_zh: "蓝色" },
  { hex: "#FFFF00", name_en: "Yellow", name_zh: "黄色" },
  { hex: "#FFF000", name_en: "Vivid Yellow", name_zh: "鲜艳黄" },
  { hex: "#FFEA00", name_en: "Daffodil", name_zh: "水仙黄" },
  { hex: "#FDD017", name_en: "Bright Gold", name_zh: "亮金黄" },
  { hex: "#F4C430", name_en: "Saffron", name_zh: "藏红花黄" },
  { hex: "#FFC04C", name_en: "Topaz", name_zh: "黄玉色" },
  { hex: "#FFB347", name_en: "Pastel Orange", name_zh: "柔和橙" },
  { hex: "#FFAA33", name_en: "Neon Carrot", name_zh: "霓虹胡萝卜色" },
  { hex: "#FFA500", name_en: "Orange", name_zh: "橙色" },
  { hex: "#FF8C00", name_en: "Dark Orange", name_zh: "深橙色" },
  { hex: "#DDA0DD", name_en: "Plum", name_zh: "李子紫" },
  { hex: "#DA70D6", name_en: "Orchid", name_zh: "兰花紫" },
  { hex: "#BA55D3", name_en: "Medium Orchid", name_zh: "中兰花紫" },
  { hex: "#8A2BE2", name_en: "Blue Violet", name_zh: "蓝紫色" },
  { hex: "#6A0DAD", name_en: "Royal Purple", name_zh: "皇家紫" },
  { hex: "#FFB6C1", name_en: "Light Pink", name_zh: "浅粉色" },
  { hex: "#FF69B4", name_en: "Hot Pink", name_zh: "亮粉色" },
  { hex: "#FF1493", name_en: "Deep Pink", name_zh: "深粉色" },
  { hex: "#DB7093", name_en: "Pale Violet Red", name_zh: "弱紫罗兰红" },
  { hex: "#C71585", name_en: "Medium Violet Red", name_zh: "中紫罗兰红" },
];

export const lightBackgroundColors: ColorInfo[] = [
  { hex: "#F0F0F0", name_en: "Anti-Flash White", name_zh: "防闪白" },
  { hex: "#F2F2F2", name_en: "Seashell", name_zh: "贝壳白" },
  { hex: "#F4F4F4", name_en: "Isabelline", name_zh: "灰白色" },
  { hex: "#F5F5F5", name_en: "White Smoke", name_zh: "烟白色" },
  { hex: "#F8F8F8", name_en: "Ghost White", name_zh: "幽灵白" },
  { hex: "#FAFAFA", name_en: "Cultured", name_zh: "培育白" },
  { hex: "#FCFCFC", name_en: "Baby Powder", name_zh: "婴儿粉白" },
  { hex: "#FEFEFE", name_en: "Snow", name_zh: "雪白" },
  { hex: "#FFFAFA", name_en: "Floral White", name_zh: "花卉白" },
  { hex: "#FFFFFF", name_en: "Pure White", name_zh: "纯白色" },
];

export const darkBackgroundColors: ColorInfo[] = [
  { hex: "#323232", name_en: "Charcoal", name_zh: "木炭黑" },
  { hex: "#2C2C2C", name_en: "Outer Space", name_zh: "外太空黑" },
  { hex: "#232323", name_en: "Raisin Black", name_zh: "葡萄干黑" },
  { hex: "#1D1C1C", name_en: "Eerie Black", name_zh: "诡黑" },
  { hex: "#161616", name_en: "Night", name_zh: "夜黑" },
  { hex: "#141010", name_en: "Black Coffee", name_zh: "黑咖啡" },
  { hex: "#0F0F0F", name_en: "Rich Black", name_zh: "浓黑" },
  { hex: "#0C0C0C", name_en: "Onyx", name_zh: "缟玛瑙黑" },
  { hex: "#0A0A0A", name_en: "Licorice", name_zh: "甘草黑" },
  { hex: "#000000", name_en: "Black", name_zh: "黑色" },
];

export const DEFAULT_ACCENT = "#496cff";
export const DEFAULT_LIGHT_BACKGROUND = "#FFFFFF";
export const DEFAULT_DARK_BACKGROUND = "#1a1e25";

export function colorName(hex: string, list: ColorInfo[], inChinese: boolean): string {
  const found = list.find((item) => item.hex.toUpperCase() === hex.toUpperCase());
  return found ? (inChinese ? found.name_zh : found.name_en) : hex;
}
