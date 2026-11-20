import type { DayOutfit } from '@app/shared';
import type { ComputedRef, InjectionKey } from 'vue';

/** 场景里立绘此刻的样子：跟随立绘的头像按它裁，和场景里站着的那张对得上（只对这个角色） */
export interface FigureLook {
  characterId: string;
  expression: string;
  outfit?: string | null;
  pose?: string | null;
  dayOutfit?: DayOutfit;
}

export const FIGURE_LOOK: InjectionKey<ComputedRef<FigureLook | null>> = Symbol('figure-look');
