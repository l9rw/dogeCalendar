import { invoke } from "@tauri-apps/api/core";

export type Huangli = {
  source: string;
  lunar: string;
  ganzhi: string;
  week: string;
  xingzuo: string;
  shengxiao: string;
  festival: string;
  jieqi: string;
  yi: string[];
  ji: string[];
  pengsheng: string;
  baiji: string;
  zhushen: string;
  taishen: string;
};

export function fetchHuangli(date: string): Promise<Huangli> {
  return invoke<Huangli>("fetch_huangli", { date });
}
