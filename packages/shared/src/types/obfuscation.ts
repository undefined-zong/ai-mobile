export type TextObfuscationMode = 'scatter' | 'homophone' | 'homophone-scatter' | 'random' | 'wrap';

/** 只改发给文本模型的请求副本；本机记录、语音、绘图和向量化使用原文。 */
export interface TextObfuscationSettings {
  enabled: boolean;
  mode: TextObfuscationMode;
  chunkSize: number;
  carrierLines: number;
  carrier: string;
  instruction: string;
  homophoneRate: number;
  homophoneInstruction: string;
  /** 每行 原词=替换词，优先于自带词库。 */
  customWords: string;
}
