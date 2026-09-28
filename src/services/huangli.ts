import { Solar } from "lunar-typescript";

export type Huangli = {
  ganzhi: string;
  xingzuo: string;
  shengxiao: string;
  jieqi: string;
  yi: string[];
  ji: string[];
  pengsheng: string;
  zhushen: string;
  taishen: string;
};

export function getHuangli(date: Date): Huangli {
  const solar = Solar.fromYmd(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const lunar = solar.getLunar();
  return {
    ganzhi: `${lunar.getYearInGanZhi()}年 ${lunar.getMonthInGanZhi()}月 ${lunar.getDayInGanZhi()}日`,
    xingzuo: `${solar.getXingZuo()}座`,
    shengxiao: lunar.getYearShengXiao(),
    jieqi: lunar.getJieQi(),
    yi: lunar.getDayYi(),
    ji: lunar.getDayJi(),
    pengsheng: `${lunar.getPengZuGan()} · ${lunar.getPengZuZhi()}`,
    zhushen: lunar.getDayTianShen(),
    taishen: lunar.getDayPositionTai(),
  };
}
