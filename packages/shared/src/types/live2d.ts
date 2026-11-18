export interface Live2DParameter {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
}

export interface Live2DOutfit {
  id: string;
  name: string;
  /** Comma/newline separated names or tags from the character's rhythm wardrobe. */
  match: string;
  /** Absolute model parameter values, independent of facial expressions. */
  parameters: Record<string, number>;
}

/** A body pose the rig can hold on its own, apart from motion clips (arms at rest / raised / crossed). */
export interface Live2DPose {
  id: string;
  name: string;
  /** Comma separated other names the model may write in [pose:…]. */
  match?: string;
  /** Held for a few seconds, then back to the pose before it (a raised hand). */
  momentary?: boolean;
}

/** Only metadata travels with the character; model files live in this device's IndexedDB. */
export interface CharacterLive2D {
  assetId: string;
  name: string;
  bytes: number;
  fileCount: number;
  expressions: string[];
  motions: string[];
  /** App expression → exported .exp3 name. Empty means the model's neutral face. */
  expressionMap: Record<string, string>;
  /** App expression / greeting / agree / disagree → group:index. Empty = auto by name; "none" = no motion. */
  motionMap: Record<string, string>;
  /** App expression / greeting / agree / disagree → pose id, for rigs with poses. Empty = auto; "none" = keep the current pose. */
  poseMap?: Record<string, string>;
  /** group:index → readable name taken from the motion file. Optional for models uploaded before it existed. */
  motionLabels?: Record<string, string>;
  /** Optional for models uploaded before outfit support. Discovered on next load. */
  parameters?: Live2DParameter[];
  /** Poses the rig offers; discovered when the model loads, like outfits. */
  poses?: Live2DPose[];
  outfits?: Live2DOutfit[];
  defaultOutfit?: string;
  /**
   * Adjustment on the automatic silhouette fit. zoom scales around the bottom centre;
   * x / y then move the figure by a percentage of the stage width / height (right and up are positive).
   */
  framing?: { zoom: number; x?: number; y?: number };
  /** Eyes and head follow the mouse / finger. Missing means on. */
  followPointer?: boolean;
}
